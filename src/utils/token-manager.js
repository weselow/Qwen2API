const axios = require('axios')
const lab = require('./v2-lab-sessions')
const v2sessions = require('./v2-session-store')
const sessionPersistence = require('./v2-session-persistence')
const signinWorker = require('./signin-worker-client')
const { SigninError } = require('./signin-error')
const { sha256Encrypt, JwtDecode, jitter } = require('./tools')
const { logger } = require('./logger')
const { applyProxyToAxiosConfig, getChatBaseUrl } = require('./proxy-helper');
const { buildSigninHeaders } = require('./header-profile')

/**
 * 令牌管理器
 * 负责令牌的获取、验证、刷新等操作
 */
class TokenManager {
    constructor(httpClient = axios) {
        this.httpClient = httpClient
    }

    /**
     * 获取登录端点
     * @returns {string} 登录端点URL
     */
    get loginEndpoint() {
        if (lab.authOrigin) return `${lab.authOrigin}/api/v2/auths/signin`
        return `${getChatBaseUrl()}/api/v1/auths/signin`
    }

    /**
     * 用户登录获取令牌
     * @param {string} email - 邮箱
     * @param {string} password - 密码
     * @param {Object} [account] - 账户对象（用于解析账号级代理；为空时回退到全局 PROXY_URL）
     * @returns {Promise<string|null>} 令牌或null
     */
    async login(email, password, account, options = {}) {
        // Browser mode: the WAF captcha makes pure-Node sign-in impossible; the
        // signin worker signs in inside real Chromium and hands back the jar.
        if (v2sessions.browser) {
            try {
                return await this.loginBrowserSession(email, password, account)
            } catch (error) {
                const failure = error instanceof SigninError ? error : SigninError.fromError(error)
                logger.error(`Qwen signin: ${failure.code} (upstream HTTP ${failure.upstreamStatus ?? 'none'})`, 'AUTH')
                if (options.throwOnFailure) throw failure
                return null
            }
        }
        try {
            const requestConfig = {
                headers: buildSigninHeaders(account, { chatBaseUrl: getChatBaseUrl() }),
                timeout: 10000 // 10秒超时
            }

            let formJar
            if (lab.authOrigin) {
                formJar = await lab.openAuthForm(this.httpClient)
                const cookies = formJar.getCookieStringSync(this.loginEndpoint)
                if (cookies) requestConfig.headers.Cookie = cookies
                Object.assign(requestConfig, { proxy: false, maxRedirects: 0 })
            } else {
                applyProxyToAxiosConfig(requestConfig, account)
            }

            const response = await this.httpClient.post(this.loginEndpoint, {
                email: email,
                password: sha256Encrypt(password)
            }, requestConfig)

            if (lab.authOrigin) {
                const session = lab.authenticatedJar(response, this.loginEndpoint, { jar: formJar }, token => this.validateToken(token))
                lab.sessions.set(email, session)
            }
            if (response.data && response.data.token) {
                // 不记录令牌本身：日志可能落盘或被采集，令牌可直接冒充该账户
                logger.success(`${email} 登录成功`, 'AUTH')
                return response.data.token
            }
            throw SigninError.fromResponse(response)
        } catch (error) {
            const failure = SigninError.fromError(error)
            // Axios errors can include a reusable password hash, cookies and proxy credentials.
            logger.error(`Qwen signin: ${failure.code} (upstream HTTP ${failure.upstreamStatus ?? 'none'})`, 'AUTH')
            if (options.throwOnFailure) throw failure
            return null
        }
    }

    /**
     * Browser-режим: вход через signin-worker и сохранение сессии (token + jar).
     * @returns {Promise<string>} 令牌
     */
    async loginBrowserSession(email, password, account) {
        const harvested = await signinWorker.acquireSession(email, password, account)
        const decoded = this.validateToken(harvested.token)
        if (!decoded) throw new SigninError('signin_upstream_error', 502, 'Signin worker returned an invalid token.')
        // publishSession = setSession + 持久化（jik.4）：重启后无需重新登录
        await sessionPersistence.publishSession(email, {
            token: harvested.token,
            expiresAt: decoded.exp,
            jar: harvested.jar
        })
        // 不记录令牌本身：日志可能落盘或被采集，令牌可直接冒充该账户
        logger.success(`${email} 登录成功`, 'AUTH')
        return harvested.token
    }

    /**
     * 验证令牌是否有效
     * @param {string} token - JWT令牌
     * @returns {Object|null} 解码后的令牌信息或null
     */
    validateToken(token) {
        try {
            if (!token) return null

            const decoded = JwtDecode(token)
            if (!decoded || !decoded.exp) {
                return null
            }

            const now = Math.floor(Date.now() / 1000)
            if (decoded.exp <= now) {
                return null // 令牌已过期
            }

            return decoded
        } catch (error) {
            logger.error('令牌验证失败', 'TOKEN', '', error)
            return null
        }
    }

    /**
     * 检查令牌是否即将过期
     * @param {string} token - JWT令牌
     * @param {number} thresholdHours - 过期阈值（小时）
     * @returns {boolean} 是否即将过期
     */
    isTokenExpiringSoon(token, thresholdHours = 6) {
        const decoded = this.validateToken(token)
        if (!decoded) return true // 无效令牌视为即将过期

        const now = Math.floor(Date.now() / 1000)
        const thresholdSeconds = thresholdHours * 60 * 60
        return decoded.exp - now < thresholdSeconds
    }

    /**
     * 获取令牌剩余有效时间（小时）
     * @param {string} token - JWT令牌
     * @returns {number} 剩余小时数，-1表示无效令牌
     */
    getTokenRemainingHours(token) {
        const decoded = this.validateToken(token)
        if (!decoded) return -1

        const now = Math.floor(Date.now() / 1000)
        const remainingSeconds = decoded.exp - now
        return Math.max(0, Math.round(remainingSeconds / 3600))
    }

    /**
     * 刷新单个账户的令牌
     * @param {Object} account - 账户对象 {email, password, token, expires}
     * @returns {Promise<Object|null>} 更新后的账户对象或null
     */
    async refreshToken(account, options) {
        try {
            if (v2sessions.browser) return await this.refreshBrowserSession(account, options)
            if (lab.authOrigin) return await this.refreshLabSession(account, options)
            const newToken = await this.login(account.email, account.password, account, options)
            if (!newToken) {
                return null
            }

            const decoded = this.validateToken(newToken)
            if (!decoded) {
                logger.error(`刷新后的令牌无效: ${account.email}`, 'TOKEN')
                return null
            }

            const updatedAccount = {
                ...account,
                token: newToken,
                expires: decoded.exp
            }

            const remainingHours = this.getTokenRemainingHours(newToken)
            logger.success(`令牌刷新成功: ${account.email} (有效期: ${remainingHours}小时)`, 'TOKEN')

            return updatedAccount
        } catch (error) {
            if (error instanceof SigninError) throw error
            logger.error(`刷新令牌失败 (${account.email})`, 'TOKEN', '', error)
            return null
        }
    }

    /**
     * Browser-режим: обновление = попросить воркер тихо перезагрузить профиль
     * (v2 refresh endpoint доступен только Electron-FE). Мёртвый профиль
     * (sessionLost) откатывается на полный вход с паролем.
     */
    async refreshBrowserSession(account, options = {}) {
        try {
            let harvested
            try {
                harvested = await signinWorker.renewSession(account.email, account)
            } catch (error) {
                if (!error.sessionLost) throw error
                harvested = await signinWorker.acquireSession(account.email, account.password, account)
            }
            const decoded = this.validateToken(harvested.token)
            if (!decoded) throw new SigninError('signin_upstream_error', 502, 'Signin worker returned an invalid token.')
            const next = { token: harvested.token, expiresAt: decoded.exp, jar: harvested.jar }
            const previous = v2sessions.sessions.get(account.email)
            const publish = () => {
                const current = v2sessions.sessions.get(account.email)
                // publishSession 同时写 store 与持久层（jik.4）；
                // 它不会抛错——此处 fire-and-forget 安全
                if (!current || current === previous) sessionPersistence.publishSession(account.email, next)
            }
            if (options.afterSave) options.afterSave(publish)
            else publish()
            return { ...account, token: next.token, expires: decoded.exp }
        } catch (error) {
            const failure = error instanceof SigninError ? error : SigninError.fromError(error)
            logger.error(`Browser session refresh: ${failure.code}`, 'AUTH')
            if (options.throwOnFailure) throw failure
            return null
        }
    }

    async refreshLabSession(account, options = {}) {
        const previous = lab.sessionFor(account.email, account.token)
        if (!previous) return null
        const url = `${lab.authOrigin}/api/v2/auths/refresh`
        const headers = buildSigninHeaders(account, { chatBaseUrl: getChatBaseUrl() })
        delete headers['content-type']
        const cookie = previous.jar.getCookieStringSync(url)
        if (cookie) headers.cookie = cookie
        try {
            const response = await this.httpClient.get(url, { headers, timeout: 10000, proxy: false, maxRedirects: 0 })
            const next = lab.authenticatedJar(response, url, previous, token => this.validateToken(token))
            if (lab.sessions.get(account.email) !== previous) return null
            const publish = () => {
                if (lab.sessions.get(account.email) === previous) lab.sessions.set(account.email, next)
            }
            if (options.afterSave) options.afterSave(publish)
            else publish()
            return { ...account, token: next.token, expires: this.validateToken(next.token).exp }
        } catch (error) {
            const failure = SigninError.fromError(error)
            logger.error(`Lab session refresh: ${failure.code}`, 'AUTH')
            if (options.throwOnFailure) throw failure
            return null
        }
    }

    /**
     * 批量刷新即将过期的令牌
     * @param {Array} accounts - 账户列表
     * @param {number} thresholdHours - 过期阈值（小时）
     * @param {Function} onEachRefresh - 每次刷新成功后的回调函数 (updatedAccount, index, total) => void
     * @returns {Promise<Object>} 刷新结果 {refreshed: Array, failed: Array}
     */
    async batchRefreshTokens(accounts, thresholdHours = 24, onEachRefresh = null) {
        const needsRefresh = accounts.filter(account =>
            this.isTokenExpiringSoon(account.token, thresholdHours)
        )

        if (needsRefresh.length === 0) {
            logger.info('没有需要刷新的令牌', 'TOKEN')
            return { refreshed: [], failed: [] }
        }

        logger.info(`发现 ${needsRefresh.length} 个令牌需要刷新`, 'TOKEN')

        const refreshed = []
        const failed = []

        for (let i = 0; i < needsRefresh.length; i++) {
            const account = needsRefresh[i]
            const updatedAccount = await this.refreshToken(account)

            if (updatedAccount) {
                refreshed.push(updatedAccount)

                // 如果提供了回调函数，立即调用
                if (onEachRefresh && typeof onEachRefresh === 'function') {
                    try {
                        await onEachRefresh(updatedAccount, i + 1, needsRefresh.length)
                    } catch (error) {
                        logger.error(`刷新回调函数执行失败 (${account.email})`, 'TOKEN', '', error)
                    }
                }
            } else {
                failed.push(account)
            }

            // 添加延迟避免请求过于频繁 (jitter breaks machine-perfect timing)
            await this._delay(jitter(1000))
        }

        logger.success(`令牌刷新完成: 成功 ${refreshed.length} 个，失败 ${failed.length} 个`, 'TOKEN')
        return { refreshed, failed }
    }

    /**
     * 获取健康的令牌统计信息
     * @param {Array} accounts - 账户列表
     * @returns {Object} 统计信息
     */
    getTokenHealthStats(accounts) {
        const stats = {
            total: accounts.length,
            valid: 0,
            expired: 0,
            expiringSoon: 0,
            invalid: 0
        }

        accounts.forEach(account => {
            if (!account.token) {
                stats.invalid++
                return
            }

            const decoded = this.validateToken(account.token)
            if (!decoded) {
                stats.invalid++
                return
            }

            const now = Math.floor(Date.now() / 1000)
            if (decoded.exp <= now) {
                stats.expired++
            } else if (this.isTokenExpiringSoon(account.token, 6)) {
                stats.expiringSoon++
            } else {
                stats.valid++
            }
        })

        return stats
    }

    /**
     * 延迟函数
     * @param {number} ms - 延迟毫秒数
     * @private
     */
    async _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms))
    }
}

module.exports = TokenManager
