const config = require('../config/index.js')
const DataPersistence = require('./data-persistence')
const TokenManager = require('./token-manager')
const lab = require('./v2-lab-sessions')
const v2sessions = require('./v2-session-store')
const sessionPersistence = require('./v2-session-persistence')
const AccountRotator = require('./account-rotator')
const { logger } = require('./logger')
const { generateDeterministicFingerprint } = require('./fingerprint')
const signinWorker = require('./signin-worker-client')
const accountRegistry = require('./account-registry')

/**
 * 默认 daily stats 结构。返回新对象，调用方安全修改
 * @returns {Object} default stats
 */
const createDefaultStats = () => ({
    chat: { input: 0, output: 0 },
    cli: { calls: 0, input: 0, output: 0 }
})

/**
 * Ensure account has a deterministic fingerprint.
 * Generates one from SHA-256(email) if missing; persists on next save.
 * @param {Object} account - Account object (mutated in place)
 */
const ensureAccountFingerprint = (account) => {
    if (!account || !account.email) return
    if (!account.fingerprint || typeof account.fingerprint !== 'object' || !account.fingerprint.deviceId) {
        try {
            account.fingerprint = generateDeterministicFingerprint(account.email)
            logger.info(`Generated deterministic fingerprint for ${account.email}`, 'ACCOUNT')
        } catch (err) {
            logger.error(`Failed to generate fingerprint for ${account.email}: ${err.message}`, 'ACCOUNT')
            // Fall back: leave undefined so header-profile uses legacy headers
        }
    }
}

/**
 * 保证账户具备 stats 和 statsHistory 字段（兼容老 data.json/Redis 数据）
 * @param {Object} account - 账户对象
 */
const ensureStats = (account) => {
    if (!account) return
    if (!account.stats || typeof account.stats !== 'object') {
        account.stats = createDefaultStats()
    } else {
        if (!account.stats.chat || typeof account.stats.chat !== 'object') {
            account.stats.chat = { input: 0, output: 0 }
        } else {
            account.stats.chat.input = Number(account.stats.chat.input) || 0
            account.stats.chat.output = Number(account.stats.chat.output) || 0
        }
        if (!account.stats.cli || typeof account.stats.cli !== 'object') {
            account.stats.cli = { calls: 0, input: 0, output: 0 }
        } else {
            account.stats.cli.calls = Number(account.stats.cli.calls) || 0
            account.stats.cli.input = Number(account.stats.cli.input) || 0
            account.stats.cli.output = Number(account.stats.cli.output) || 0
        }
    }
    // statsHistory: { 'YYYY-MM-DD': { chat:{input,output}, cli:{calls,input,output} } }
    // Backward-compat: legacy records without the field — initialize to {}
    if (!account.statsHistory || typeof account.statsHistory !== 'object') {
        account.statsHistory = {}
    }
}

/**
 * YYYY-MM-DD date key for (now + offsetDays) in Node process local TZ
 * @param {number} offsetDays - day offset (negative = past)
 * @returns {string}
 */
const _formatDateKey = (offsetDays) => {
    const d = new Date()
    d.setDate(d.getDate() + offsetDays)
    const yyyy = d.getFullYear()
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    return `${yyyy}-${mm}-${dd}`
}

const _getTodayKey = () => _formatDateKey(0)
const _getYesterdayKey = () => _formatDateKey(-1)
const _dateKeyDaysAgo = (n) => _formatDateKey(-n)

const _hasNonZeroStats = (stats) => {
    if (!stats || typeof stats !== 'object') return false
    const c = stats.chat || {}
    const l = stats.cli || {}
    return (Number(c.input) || 0) > 0
        || (Number(c.output) || 0) > 0
        || (Number(l.calls) || 0) > 0
        || (Number(l.input) || 0) > 0
        || (Number(l.output) || 0) > 0
}

// What the worker's /forget reports of the browser profile (Qwen2API-2l0):
// deleted or not deletable are worth a word, kept and never-there are not.
const FORGET_PROFILE_NOTE = { deleted: '，浏览器配置已删除', left: '，浏览器配置没能删除', absent: '', kept: '' }

// The timer's cycle of token refreshes (Qwen2API-ops). In browser mode a
// refresh is a reload of the account's page in the signin-worker whenever the
// worker has no fresh session of it to answer from — after the worker's
// restart, or once its cached session has run low; while the worker's own
// timer keeps that session fresh, it answers from the cache and no page is
// loaded. The cycle cannot tell the two apart beforehand, so every refresh is
// given room: two accounts of one cycle are kept this far apart, plus up to
// the same again as jitter — as the worker keeps its full sign-ins. Shorter,
// and a renewal that does reload would stand in the worker's line of page
// loads, holding its account's lock until its turn (Qwen2API-m47).
const AUTO_REFRESH_MIN_INTERVAL_MS = 30000

const STATS_HISTORY_RETENTION_DAYS = 90
/**
 * 账户管理器
 * 统一管理账户、令牌、模型等功能
 */
class Account {
    constructor() {
        // 初始化各个管理器
        this.dataPersistence = new DataPersistence()
        this.tokenManager = new TokenManager()
        this.accountRotator = new AccountRotator(token => Boolean(this.tokenManager.validateToken(token)))

        // 账户数据
        this._accountMutationQueues = new Map()
        this.accountTokens = []
        this.isInitialized = false
        // 初始化失败的原因（例如 data.json 损坏），用于给客户端返回可读的错误
        this.initError = null

        // 配置信息
        this.defaultHeaders = config.defaultHeaders || {}

        // cli请求次数定时刷新器
        this.cliRequestNumberInterval = null
        this.cliDailyResetInterval = null
        // Whether the timer's cycle of token refreshes is running (autoRefreshTokens)
        this.autoRefreshCycleRunning = false

        // Keep the init promise so debug methods can await readiness
        this._initPromise = this._initialize()
    }

    /**
     * 异步初始化
     * @private
     */
    async _initialize() {
        try {
            // 加载账户信息
            await this.loadAccountTokens()

            // jik.4：恢复持久化的 v2 浏览器会话（off/lab 模式下 no-op）。
            // 恢复失败不阻塞启动——会话可再生，首次请求/自动刷新会重建
            try {
                await sessionPersistence.restoreSessions()
            } catch (error) {
                logger.error('v2 会话恢复失败，继续启动（会话将由登录/刷新重建）', 'ACCOUNT', '', error)
            }

            // 设置定期刷新令牌
            if (config.autoRefresh) {
                this.refreshInterval = setInterval(
                    () => this.autoRefreshTokens(24, { paced: true }),
                    (config.autoRefreshInterval || 21600) * 1000 // 默认6小时
                )
            }

            this.isInitialized = true
            this.initError = null
            logger.success(`账户管理器初始化完成，共加载 ${this.accountTokens.length} 个账户`, 'ACCOUNT')
        } catch (error) {
            this.isInitialized = false
            this.initError = error
            logger.error('账户管理器初始化失败', 'ACCOUNT', '', error)
        }
    }

    /**
     * 账户不可用的原因——供上层把「Request failed」换成人能看懂的说明
     * @returns {string|null} 不可用原因；null 表示账户可用
     */
    getUnavailableReason() {
        if (this.initError) {
            return `账户管理器初始化失败：${this.initError.message}`
        }
        if (!this.isInitialized) {
            return '账户管理器尚未初始化完成，请稍后重试'
        }
        if (!Array.isArray(this.accountTokens) || this.accountTokens.length === 0) {
            return '没有可用的账户，请在管理面板中添加账户'
        }
        return null
    }

    /**
     * 加载账户令牌数据
     * @returns {Promise<void>}
     */
    async loadAccountTokens() {
        try {
            this.accountTokens = await this.dataPersistence.loadAccounts()

            // 兼容历史数据：旧 data.json/Redis 没有 stats 字段
            this.accountTokens.forEach(ensureStats)

            // Antidetect: ensure every account has a deterministic fingerprint
            this.accountTokens.forEach(ensureAccountFingerprint)

            // 如果是环境变量模式，需要进行登录获取令牌
            if (config.dataSaveMode === 'none' && this.accountTokens.length > 0) {
                await this._loginEnvironmentAccounts()
            }

            // Persisted records belong in account management even when their token
            // is expired. Startup must not silently drop them or retry their login.
            // Rotation validates tokens independently before selecting an account.
            if (config.dataSaveMode === 'none') {
                await this._validateAndCleanTokens()
            }

            // 更新账户轮询器
            this.accountRotator.setAccounts(this.accountTokens)

            // 初始化 CLI 账户（后台执行，不阻塞 chat-flow init）
            // 为所有账户启动 CLI 初始化，确保没有 CLI 额度的账号被正确标记为 unsupported
            if (this.accountTokens.length > 0) {
                if (config.cliEnabled) {
                    logger.info(`后台初始化所有 ${this.accountTokens.length} 个账户的 CLI`, 'ACCOUNT')
                    Promise.allSettled(
                        this.accountTokens
                            .filter(account => this.tokenManager.validateToken(account.token))
                            .map(account => this._initializeCliAccount(account))
                    ).then(() => {
                        const cliReady = this.accountTokens.filter(a => a.cli_info).length
                        const cliUnsupported = this.accountTokens.filter(a => a.cli_unavailable_reason === 'unsupported').length
                        logger.success(`CLI 初始化完成: ${cliReady} 个可用, ${cliUnsupported} 个不支持`, 'CLI')
                    })
                } else {
                    // CLI 关闭时也要标记账户：cli_unavailable_reason 为空的账户会被
                    // cli-support.js 判定为 cli_pending，管理面板会一直显示「CLI 初始化中」。
                    // 该字段不落盘（见 data-persistence 的字段白名单），所以每次启动都要重新标记。
                    this.accountTokens.forEach(account => this._markCliDisabled(account))
                    logger.info(`CLI 已关闭，${this.accountTokens.length} 个账户标记为 disabled`, 'CLI')
                }
            }

            // 设置cli定时器 每天00:00:00刷新请求次数
            this._setupDailyResetTimer()

            logger.success(`成功加载 ${this.accountTokens.length} 个账户`, 'ACCOUNT')
        } catch (error) {
            logger.error('加载账户令牌失败', 'ACCOUNT', '', error)
            this.accountTokens = []
            this.accountRotator.setAccounts(this.accountTokens)
            throw error
        }
    }

    /**
     * 为环境变量模式的账户进行登录
     * @private
     */
    async _loginEnvironmentAccounts() {
        // 浏览器模式下 signin-worker 给完整登录排队（Qwen2API-43a）：并发登录只会在那边
        // 排队或被拒（signin_paced），所以逐个登录。
        if (v2sessions.browser) {
            for (const account of this.accountTokens) await this._loginEnvironmentAccount(account)
            return
        }
        this.accountTokens = await Promise.all(this.accountTokens.map(account => this._loginEnvironmentAccount(account)))
    }

    /**
     * 环境变量账户尚未持有令牌时登录一次
     * @param {Object} account - 账户对象（就地写入 token / expires）
     * @returns {Promise<Object>} 同一账户对象
     * @private
     */
    async _loginEnvironmentAccount(account) {
        if (!account.token && account.email && account.password) {
            const token = await this.tokenManager.login(account.email, account.password, account)
            if (token) {
                const decoded = this.tokenManager.validateToken(token)
                if (decoded) {
                    account.token = token
                    account.expires = decoded.exp
                }
            }
        }
        return account
    }

    /**
     * 标记账户的 CLI 不可用——因为 CLI 功能已关闭
     * @param {Object} account - 账户对象
     * @private
     */
    _markCliDisabled(account) {
        account.cli_info = null
        account.cli_unavailable_reason = 'disabled'
    }

    /**
     * 初始化CLI账户
     * @param {Object} account - 账户对象
     * @private
     */
    async _initializeCliAccount(account) {
        if (!config.cliEnabled) {
            this._markCliDisabled(account)
            return null
        }
        try {
            const cliManager = require('./cli.manager')
            const cliAccount = await cliManager.initCliAccount(account.token, account)

            if (cliAccount.access_token && cliAccount.refresh_token && cliAccount.expiry_date) {
                account.cli_unavailable_reason = null
                account.cli_info = {
                    access_token: cliAccount.access_token,
                    refresh_token: cliAccount.refresh_token,
                    expiry_date: cliAccount.expiry_date,
                    refresh_token_interval: setInterval(async () => {
                        try {
                            const refreshToken = await cliManager.refreshAccessToken({
                                access_token: account.cli_info.access_token,
                                refresh_token: account.cli_info.refresh_token,
                                expiry_date: account.cli_info.expiry_date
                            }, account)
                            if (refreshToken.access_token && refreshToken.refresh_token && refreshToken.expiry_date) {
                                account.cli_info.access_token = refreshToken.access_token
                                account.cli_info.refresh_token = refreshToken.refresh_token
                                account.cli_info.expiry_date = refreshToken.expiry_date
                                logger.info(`CLI账户 ${account.email} 令牌刷新成功`, 'CLI')
                            }
                        } catch (error) {
                            logger.error(`CLI账户 ${account.email} 令牌刷新失败`, 'CLI', '', error)
                        }
                        // 每2小时刷新一次
                    }, 1000 * 60 * 60 * 2),
                    request_number: 0
                }
                logger.success(`CLI账户 ${account.email} 初始化成功`, 'CLI')
            } else {
                account.cli_info = null
                account.cli_unavailable_reason = 'unsupported'
                logger.error(`CLI账户 ${account.email} 初始化失败：无效的响应数据`, 'CLI', '', cliAccount)
            }
        } catch (error) {
            account.cli_info = null
            account.cli_unavailable_reason = 'unsupported'
            logger.error(`CLI账户 ${account.email} 初始化失败`, 'CLI', '', error)
        }
    }

    /**
     * 设置每日重置定时器
     * @private
     */
    _setupDailyResetTimer() {
        logger.info('设置每日 00:00 重置定时器（CLI 请求次数 + daily stats）', 'CLI')

        // 计算到下一天00:00:00的毫秒数
        const now = new Date()
        const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0)
        const timeDiff = tomorrow.getTime() - now.getTime()

        logger.info(`距离下次重置还有 ${Math.round(timeDiff / 1000 / 60)} 分钟`, 'CLI')

        // 首次执行使用setTimeout
        this.cliRequestNumberInterval = setTimeout(() => {
            this._resetDailyCounters()

            // 设置每24小时执行一次的定时器
            this.cliDailyResetInterval = setInterval(() => {
                this._resetDailyCounters()
            }, 24 * 60 * 60 * 1000)
        }, timeDiff)
    }

    /**
     * Daily 00:00 reset: CLI request counters + chat/cli daily stats.
     * Before zeroing, snapshot yesterday into account.statsHistory and prune
     * entries older than STATS_HISTORY_RETENTION_DAYS days, then a single
     * saveAllAccounts batch (instead of 30 individual saves).
     *
     * Caveats:
     * - Multiple replicas archive independent in-memory stats. They need
     *   coordinated aggregation before sharing persistence; one process is
     *   the supported default.
     * - DATA_SAVE_MODE=none: saveAllAccounts returns false and history is not
     *   persisted. Set DATA_SAVE_MODE=file or redis to enable the feature.
     * @private
     */
    async _resetDailyCounters() {
        // CLI 请求计数（旧逻辑）
        const cliAccounts = this.accountTokens.filter(account => account.cli_info)
        cliAccounts.forEach(account => {
            account.cli_info.request_number = 0
        })

        const yesterday = _getYesterdayKey()
        const cutoff = _dateKeyDaysAgo(STATS_HISTORY_RETENTION_DAYS)
        let archivedCount = 0

        // For every account (including inactive ones) prune old history;
        // for accounts with any non-zero counters, snapshot yesterday.
        this.accountTokens.forEach(account => {
            ensureStats(account)

            // Date-based pruning (string compare is valid for YYYY-MM-DD).
            for (const key of Object.keys(account.statsHistory)) {
                if (key < cutoff) {
                    delete account.statsHistory[key]
                }
            }

            // Snapshot only if there was at least one non-zero counter.
            if (_hasNonZeroStats(account.stats)) {
                account.statsHistory[yesterday] = {
                    chat: { ...account.stats.chat },
                    cli: { ...account.stats.cli }
                }
                archivedCount++
            }

            // Reset today.
            account.stats.chat.input = 0
            account.stats.chat.output = 0
            account.stats.cli.calls = 0
            account.stats.cli.input = 0
            account.stats.cli.output = 0
        })

        logger.info(
            `已重置 ${cliAccounts.length} 个CLI账户请求次数 + ${this.accountTokens.length} 个账户 daily stats，归档 ${archivedCount} 条 statsHistory[${yesterday}]`,
            'CLI'
        )

        // Single batch save. In file mode — one data.json rewrite; in redis
        // mode — sequential HSETs (the saveAccountStats debounce is not used).
        try {
            await this.dataPersistence.saveAllAccounts(this.accountTokens)
        } catch (error) {
            logger.error('每日重置后 persist 失败', 'ACCOUNT', '', error)
        }
    }

    /**
     * Public helper: today's YYYY-MM-DD key in Node process local TZ.
     * Paired with the _getYesterdayKey used inside _resetDailyCounters.
     * The /statsHistory route must use this rather than new Date() in the
     * browser — otherwise differing browser/container TZs can shift month
     * boundaries.
     * @returns {string}
     */
    getTodayKey() {
        return _getTodayKey()
    }

    /**
     * Debug: manual trigger for archive/reset (used by the dev endpoint).
     * The readiness guard prevents wiping data.accounts = [] before init finishes.
     * @returns {Promise<void>}
     */
    async archiveYesterdayForTest() {
        if (this._initPromise) {
            await this._initPromise
        }
        if (!this.isInitialized || !Array.isArray(this.accountTokens) || this.accountTokens.length === 0) {
            throw new Error('account manager not initialized — refusing to archive (would wipe data)')
        }
        return this._resetDailyCounters()
    }

    /**
     * 重置CLI请求次数（向后兼容别名）
     * @private
     */
    _resetCliRequestNumbers() {
        return this._resetDailyCounters()
    }

    /**
     * 验证和清理无效令牌
     * @private
     */
    async _validateAndCleanTokens() {
        const validAccounts = []

        for (const account of this.accountTokens) {
            if (account.token && this.tokenManager.validateToken(account.token)) {
                validAccounts.push(account)
            } else if (account.email && account.password) {
                // 尝试重新登录
                logger.info(`令牌无效，尝试重新登录: ${account.email}`, 'TOKEN', '🔄')
                const newToken = await this.tokenManager.login(account.email, account.password, account)
                if (newToken) {
                    const decoded = this.tokenManager.validateToken(newToken)
                    if (decoded) {
                        account.token = newToken
                        account.expires = decoded.exp
                        validAccounts.push(account)
                    }
                }
            }
        }

        this.accountTokens = validAccounts
    }


    /**
     * 令牌将在阈值内过期（或已失效）的账户
     * @param {number} thresholdHours - 过期阈值（小时）
     * @returns {Array} 需要刷新的账户
     */
    getAccountsNeedingRefresh(thresholdHours = 24) {
        return this.accountTokens.filter(account =>
            this.tokenManager.isTokenExpiringSoon(account.token, thresholdHours)
        )
    }

    /**
     * 自动刷新即将过期的令牌
     * @param {number} thresholdHours - 过期阈值（小时）
     * @param {Object} [options]
     * @param {boolean} [options.paced] - 调用方是定时器（Qwen2API-ops）：browser 模式下同一次循环里的
     *   账户彼此隔开（_refreshPauseMs），上一轮还没结束时这一轮不开始。面板的按钮不传它——
     *   它们在自己的 HTTP 请求里等结果，间隔照旧。
     * @returns {Promise<number>} 成功刷新的令牌数量
     */
    async autoRefreshTokens(thresholdHours = 24, { paced = false } = {}) {
        if (!this.isInitialized) {
            logger.warn('账户管理器尚未初始化，跳过自动刷新', 'TOKEN')
            return 0
        }
        // 一次只有一轮：账户之间的停顿能让一轮持续得比定时器的间隔还久（16 个账户——
        // 间隔 15 分钟时最多约 18 分钟），而同时跑着的第二轮会一次更新两个账户。
        if (paced && this.autoRefreshCycleRunning) {
            logger.info('上一轮自动刷新还没结束，跳过这一轮', 'TOKEN')
            return 0
        }
        if (paced) this.autoRefreshCycleRunning = true
        try {
            return await this._refreshDueTokens(thresholdHours, paced)
        } finally {
            if (paced) this.autoRefreshCycleRunning = false
        }
    }

    /**
     * 一轮：刷新令牌将在阈值内过期的账户。循环可能持续几分钟，所以期间被删除的账户、
     * 或令牌已经被别的路径更新过的账户，都跳过（Qwen2API-ops；刷新被删除的账户还会在
     * signin-worker 里重新打开它的页面——Qwen2API-2l0）。
     * @param {number} thresholdHours - 过期阈值（小时）
     * @param {boolean} paced - 是否是定时器的那一轮（autoRefreshTokens）
     * @returns {Promise<number>} 成功刷新的令牌数量
     * @private
     */
    async _refreshDueTokens(thresholdHours, paced) {
        logger.info('开始自动刷新令牌...', 'TOKEN', '🔄')

        // 获取需要刷新的账户
        const needsRefresh = this.getAccountsNeedingRefresh(thresholdHours)

        if (needsRefresh.length === 0) {
            logger.info('没有需要刷新的令牌', 'TOKEN')
            return 0
        }

        logger.info(`发现 ${needsRefresh.length} 个令牌需要刷新`, 'TOKEN')

        // What the due accounts' tokens were as the cycle began. The cycle can last minutes, and the
        // record may change meanwhile both ways: a refresh replaces it, a recovered session rewrites
        // its token in place — on the very object this cycle holds.
        const tokenAtStart = new Map(needsRefresh.map(account => [account.email, account.token]))

        let successCount = 0
        let failedCount = 0

        // 逐个刷新账户，每次成功后立即保存
        for (const [index, account] of needsRefresh.entries()) {
            const current = this.accountTokens.find(acc => acc.email === account.email)
            if (!current) {
                logger.info(`账户 ${account.email} 已被删除，跳过刷新`, 'TOKEN')
                continue
            }
            if (current.token !== tokenAtStart.get(account.email) ||
                !this.tokenManager.isTokenExpiringSoon(current.token, thresholdHours)) {
                logger.info(`账户 ${account.email} 的令牌已是新的，跳过刷新`, 'TOKEN')
                continue
            }
            try {
                const refreshed = await this.refreshAccountToken(account.email)
                if (refreshed) {
                    successCount++

                    logger.info(`账户 ${account.email} 令牌刷新并保存成功 (${successCount}/${needsRefresh.length})`, 'TOKEN', '✅')
                } else {
                    // 记录失败的账户
                    this.accountRotator.recordFailure(account.email)
                    failedCount++
                    logger.error(`账户 ${account.email} 令牌刷新失败 (${failedCount} 个失败)`, 'TOKEN', '❌')
                }
            } catch (error) {
                this.accountRotator.recordFailure(account.email)
                failedCount++
                logger.error(`账户 ${account.email} 刷新过程中出错`, 'TOKEN', '', error)
            }

            // 添加延迟避免请求过于频繁
            if (paced && v2sessions.browser) {
                // 最后一个账户之后不停：后面已经没有要隔开的了
                if (index < needsRefresh.length - 1) {
                    const pauseMs = this._refreshPauseMs()
                    logger.info(`${Math.round(pauseMs / 1000)} 秒后刷新下一个账户 (${index + 1}/${needsRefresh.length})`, 'TOKEN')
                    await this._delay(pauseMs)
                }
            } else {
                await this._delay(1000)
            }
        }

        // 更新轮询器
        this.accountRotator.setAccounts(this.accountTokens)

        logger.success(`令牌刷新完成: 成功 ${successCount} 个，失败 ${failedCount} 个`, 'TOKEN')
        return successCount
    }

    /**
     * 定时器那一轮里两个账户之间等多久（Qwen2API-ops）：最小间隔，加上最多同样大小的随机添加卡
     * @param {() => number} [random] - 添加卡的来源，[0, 1)
     * @returns {number} 毫秒
     * @private
     */
    _refreshPauseMs(random = Math.random) {
        return Math.round(AUTO_REFRESH_MIN_INTERVAL_MS * (1 + random()))
    }

    /**
     * 获取下一个可用的账户对象（包含 proxy 等完整字段）
     * @returns {Object|null} 账户对象或 null
     */
    getAccount(excludedEmails = []) {
        if (!this.isInitialized) {
            logger.warn('账户管理器尚未初始化完成', 'ACCOUNT')
            return null
        }

        if (this.accountTokens.length === 0) {
            logger.error('没有可用的账户令牌', 'ACCOUNT')
            return null
        }

        const account = this.accountRotator.getNextAccount(excludedEmails)
        if (!account) {
            logger.error('所有账户令牌都不可用', 'ACCOUNT')
        }

        return account
    }

    /**
     * 获取可用的账户令牌（向后兼容的便捷方法）
     * @returns {string|null} 账户令牌或null
     */
    getAccountToken() {
        const account = this.getAccount()
        return account ? account.token : null
    }

    /**
     * 根据邮箱获取特定账户对象
     * @param {string} email - 邮箱地址
     * @returns {Object|null} 账户对象或 null
     */
    getAccountByEmail(email) {
        return this.accountRotator.getAccountByEmail(email)
    }

    /**
     * 根据令牌反查账户对象（用于只持有 token 的下游调用解析账号级代理）
     * @param {string} token - 访问令牌
     * @returns {Object|null} 账户对象或 null
     */
    getAccountByToken(token) {
        if (!token) return null
        return this.accountTokens.find(acc => acc.token === token) || null
    }

    /**
     * 根据邮箱获取特定账户的令牌（向后兼容）
     * @param {string} email - 邮箱地址
     * @returns {string|null} 账户令牌或null
     */
    getTokenByEmail(email) {
        return this.accountRotator.getTokenByEmail(email)
    }

    /**
     * 保存更新后的账户数据
     * @param {Array} updatedAccounts - 更新后的账户列表
     * @private
     */
    async _saveUpdatedAccounts(updatedAccounts) {
        try {
            for (const account of updatedAccounts) {
                await this.dataPersistence.saveAccount(account.email, {
                    password: account.password,
                    token: account.token,
                    expires: account.expires,
                    proxy: account.proxy ?? null
                })
            }
        } catch (error) {
            logger.error('保存更新后的账户数据失败', 'ACCOUNT', '', error)
        }
    }

    /** Serialize mutations of the same account, including refresh and deletion. */
    _runAccountMutation(email, operation) {
        const previous = this._accountMutationQueues.get(email) || Promise.resolve()
        const result = previous.then(operation, operation)
        const tail = result.then(() => {}, () => {})
        this._accountMutationQueues.set(email, tail)
        tail.then(() => {
            if (this._accountMutationQueues.get(email) === tail) this._accountMutationQueues.delete(email)
        })
        return result
    }

    /**
     * 手动刷新指定账户的令牌
     * @param {string} email - 邮箱地址
     * @returns {Promise<boolean>} 刷新是否成功
     */
    async refreshAccountToken(email, options) {
        return this._runAccountMutation(email, () => this._refreshAccountToken(email, options))
    }

    async _refreshAccountToken(email, options) {
        const account = this.accountTokens.find(acc => acc.email === email)
        if (!account) return false
        let publishSession
        // Publish the rotated v2 session (lab and browser modes) only after storage
        // accepted the new token, keeping requests off a token that is not durable.
        const refreshOptions = v2sessions.active ? { ...options, afterSave: fn => { publishSession = fn } } : options
        const updatedAccount = await this.tokenManager.refreshToken(account, refreshOptions)
        if (!updatedAccount) return false
        const saved = await this.dataPersistence.saveAccount(email, {
            password: updatedAccount.password,
            token: updatedAccount.token,
            expires: updatedAccount.expires,
            proxy: updatedAccount.proxy ?? account.proxy ?? null
        })
        if (!saved) return false
        const index = this.accountTokens.findIndex(acc => acc.email === email)
        if (index === -1) return false
        publishSession?.()
        this.accountTokens[index] = updatedAccount
        this.accountRotator.setAccounts(this.accountTokens)
        this.accountRotator.resetFailures(email)
        return true
    }

    /**
     * A session recovered outside the refresh flow rotated the account token
     * with it (Qwen2API-3ue.2). The record follows IN PLACE: every holder of
     * the account object — rotation, a request already in flight — sees the
     * live token, which is what the v2 session store now accepts.
     * In the account's queue of mutations, like every other change of its
     * record (Qwen2API-cke): a refresh of the same account that is out at the
     * worker would otherwise end after it and put its own token back on
     * record — the sign-in's result, published first, was lost on the record.
     * @param {string} email - 邮箱地址
     * @param {{token: string, expiresAt: number}} session - The renewed session
     * @returns {Promise<boolean|null>} null: no such account; false: storage refused
     *   the token; true: the token is on record already, or the store holds another
     *   session now and there is nothing to adopt
     */
    async adoptSessionToken(email, session) {
        return this._runAccountMutation(email, () => this._adoptSessionToken(email, session))
    }

    async _adoptSessionToken(email, session) {
        const account = this.accountTokens.find(acc => acc.email === email)
        if (!account) return null
        // The store holds another session now, or none: one may have been published
        // while this waited its turn (a refresh that began after the session was
        // published and ended before this ran). The record follows the store, not a
        // session it no longer holds (Qwen2API-cke).
        if (v2sessions.sessions.get(email)?.token !== session.token) return true
        if (account.token === session.token) return true
        account.token = session.token
        account.expires = session.expiresAt
        if (config.dataSaveMode === 'none') return true
        return this.dataPersistence.saveAccount(email, { token: session.token, expires: session.expiresAt })
    }

    /**
     * 生成 Markdown 表格
     * @param {Array} websites - 网站信息数组
     * @param {string} mode - 模式 ('table' 或 'text')
     * @returns {Promise<string>} Markdown 字符串
     */
    async generateMarkdownTable(websites, mode) {
        // 输入校验
        if (!Array.isArray(websites) || websites.length === 0) {
            return ''
        }

        let markdown = ''
        if (mode === 'table') {
            markdown += '| **序号** | **网站URL** | **来源** |\n'
            markdown += '|:---|:---|:---|\n'
        }

        // 默认值
        const DEFAULT_TITLE = '未知标题'
        const DEFAULT_URL = 'https://www.baidu.com'
        const DEFAULT_HOSTNAME = '未知来源'

        // 表格内容
        websites.forEach((site, index) => {
            const { title, url, hostname } = site
            // 处理字段值，若为空则使用默认值
            const urlCell = `[${title || DEFAULT_TITLE}](${url || DEFAULT_URL})`
            const hostnameCell = hostname || DEFAULT_HOSTNAME
            if (mode === 'table') {
                markdown += `| ${index + 1} | ${urlCell} | ${hostnameCell} |\n`
            } else {
                markdown += `[${index + 1}] ${urlCell} | 来源: ${hostnameCell}\n`
            }
        })

        return markdown
    }



    /**
     * 获取所有账户信息
     * @returns {Array} 账户列表
     */
    getAllAccountKeys() {
        return this.accountTokens
    }

    /**
     * 用户登录（委托给 TokenManager）
     * @param {string} email - 邮箱
     * @param {string} password - 密码
     * @returns {Promise<string|null>} 令牌或null
     */
    async login(email, password, proxy, options) {
        const accountLike = proxy ? { proxy } : undefined
        return await this.tokenManager.login(email, password, accountLike, options)
    }

    /**
     * 获取账户健康状态统计
     * @returns {Object} 健康状态统计
     */
    getHealthStats() {
        const tokenStats = this.tokenManager.getTokenHealthStats(this.accountTokens)
        const rotatorStats = this.accountRotator.getStats()

        return {
            accounts: tokenStats,
            rotation: rotatorStats,
            initialized: this.isInitialized
        }
    }

    /**
     * 记录账户传输层失败（影响 cooldown）
     * 仅在 timeout/ECONNRESET 等传输层错误调用——HTTP 4xx/5xx 走 recordAccountError
     * @param {string} email - 邮箱地址
     * @param {string|number} [code] - 错误码（err.code 或 HTTP status）
     */
    recordAccountFailure(email, code) {
        this.accountRotator.recordFailure(email, code)
    }

    /**
     * 记录账户错误（仅用于 UI warn 指示，不影响 cooldown）
     * HTTP 4xx/5xx 走这里——上游主动拒绝，账户本身有效
     * @param {string} email - 邮箱地址
     * @param {string|number} [code] - HTTP status 或错误码
     */
    recordAccountError(email, code) {
        this.accountRotator.recordError(email, code)
    }

    /**
     * 记录“该账户今天的额度已耗尽”，把它移出轮询直到额度恢复。
     * 调用方：anthropic.js / chat.js 的 catch，经 upstream-error#noteRateLimitedAccount。
     * 额度耗尽藏在 HTTP 200 的 SSE 包体里，request.js 的状态码分支永远看不到它。
     * @param {string} email - 邮箱地址
     * @param {number|null} [retryAfterSeconds] - 上游给的真实等待（秒）
     */
    recordAccountQuotaExhausted(email, retryAfterSeconds = null) {
        this.accountRotator.recordQuotaExhausted(email, retryAfterSeconds)
    }

    /**
     * 累计 daily stats（per-account）
     * 调用方：chat.js / anthropic.js / cli.chat.js 在成功消费完上游 usage 后
     * 注意：多个副本各持一份 in-memory 统计，不会自动聚合。
     * @param {string} email - 邮箱地址
     * @param {'chat'|'cli'} kind - 统计类别
     * @param {Object} delta - 增量
     * @param {number} [delta.input] - 输入 tokens
     * @param {number} [delta.output] - 输出 tokens
     * @param {number} [delta.calls] - 调用次数（仅 cli 使用）
     */
    accumulateStats(email, kind, delta) {
        if (!email || !delta) return
        const account = this.accountTokens.find(acc => acc.email === email)
        if (!account) return

        ensureStats(account)

        const input = Number(delta.input) || 0
        const output = Number(delta.output) || 0
        const calls = Number(delta.calls) || 0

        if (kind === 'chat') {
            account.stats.chat.input += input
            account.stats.chat.output += output
        } else if (kind === 'cli') {
            account.stats.cli.calls += calls
            account.stats.cli.input += input
            account.stats.cli.output += output
        } else {
            return
        }

        // 异步 debounced persist——失败不影响调用方
        try {
            this.dataPersistence.saveAccountStats(email, account.stats)
        } catch (error) {
            logger.error(`accumulateStats persist 调度失败 (${email})`, 'STATS', '', error)
        }
    }

    /**
     * 重置账户失败计数
     * @param {string} email - 邮箱地址
     */
    resetAccountFailures(email) {
        this.accountRotator.resetFailures(email)
    }

    /**
     * 直接添加账户（已有token，无需登录）
     * @param {string} email - 邮箱
     * @param {string} password - 密码
     * @param {string} token - 已获取的令牌
     * @param {number} expires - 过期时间戳
     * @param {string|null} [proxy] - 账号专属代理 URL
     * @returns {Promise<boolean>} 添加是否成功
     */
    async addAccountWithToken(email, password, token, expires, proxy = null) {
        return this._runAccountMutation(email, () => this._addAccountWithToken(email, password, token, expires, proxy))
    }

    async _addAccountWithToken(email, password, token, expires, proxy = null) {
        try {
            // 检查账户是否已存在
            const existingAccount = this.accountTokens.find(acc => acc.email === email)
            if (existingAccount) {
                logger.warn(`账户 ${email} 已存在`, 'ACCOUNT')
                return false
            }

            const newAccount = {
                email,
                password,
                token,
                expires,
                proxy: (typeof proxy === 'string' && proxy.trim()) ? proxy.trim() : null,
                stats: createDefaultStats()
            }

            // 添加到内存
            this.accountTokens.push(newAccount)

            // 保存到持久化存储
            const saved = await this.dataPersistence.saveAccount(email, newAccount, { allowCreate: true })
            if (!saved) {
                const insertedIndex = this.accountTokens.indexOf(newAccount)
                if (insertedIndex !== -1) this.accountTokens.splice(insertedIndex, 1)
                this.accountRotator.setAccounts(this.accountTokens)
                // The account is not the app's: the session its sign-in published goes with it, from
                // the store and from storage, so that an account added in vain leaves nothing behind
                // (Qwen2API-jwh; the guard of Qwen2API-u50 holds for an account added again).
                v2sessions.deleteSession(email)
                await this.dataPersistence.deleteV2Session(email).catch(() => {})
                logger.error(`账户 ${email} 持久化失败，已回滚内存数据`, 'ACCOUNT')
                return false
            }

            // The account is the app's again: its calls reach the worker from here on (Qwen2API-u50).
            accountRegistry.noteAdded(email)

            // 更新轮询器
            this.accountRotator.setAccounts(this.accountTokens)

            // 后台初始化 CLI
            this._initializeCliAccount(newAccount).catch(err => {
                logger.error(`新账户 CLI 初始化失败: ${email}`, 'ACCOUNT', '', err)
            })

            logger.success(`成功添加账户: ${email}`, 'ACCOUNT')
            return true
        } catch (error) {
            logger.error(`添加账户失败 (${email})`, 'ACCOUNT', '', error)
            return false
        }
    }

    /**
     * 更新账户的代理 URL
     * 同时使旧 URL 对应的 agent 失效（释放底层 socket）
     * @param {string} email - 邮箱
     * @param {string|null} proxy - 新代理 URL，空字符串/null 表示清除
     * @returns {Promise<boolean>} 更新是否成功
     */
    async updateAccountProxy(email, proxy) {
        return this._runAccountMutation(email, () => this._updateAccountProxy(email, proxy))
    }

    async _updateAccountProxy(email, proxy) {
        try {
            const account = this.accountTokens.find(acc => acc.email === email)
            if (!account) {
                logger.warn(`账户 ${email} 不存在`, 'ACCOUNT')
                return false
            }

            const oldProxy = account.proxy || null
            const newProxy = (typeof proxy === 'string' && proxy.trim()) ? proxy.trim() : null

            if (oldProxy === newProxy) {
                logger.info(`账户 ${email} 代理未变化，无需更新`, 'ACCOUNT')
                return true
            }

            // 先更新内存，再持久化；持久化失败时回滚
            account.proxy = newProxy
            const saved = await this.dataPersistence.saveAccount(email, {
                password: account.password,
                token: account.token,
                expires: account.expires,
                proxy: newProxy
            })
            if (!saved) {
                account.proxy = oldProxy
                logger.error(`账户 ${email} 代理持久化失败，已回滚内存数据`, 'ACCOUNT')
                return false
            }

            // 旧代理 URL 不再被该账户引用，主动失效缓存
            // 注意：其他账户可能仍在使用同一 URL，但 invalidate 仅按 URL 操作；
            // 多账户共享代理的场景下后续请求会重新创建 agent，安全
            if (oldProxy && oldProxy !== newProxy) {
                const { invalidateProxyAgent } = require('./proxy-helper')
                invalidateProxyAgent(oldProxy)
            }

            const { formatProxyForLog } = require('./proxy-helper')
            logger.success(`账户 ${email} 代理更新成功 (${formatProxyForLog(oldProxy)} → ${formatProxyForLog(newProxy)})`, 'ACCOUNT')
            return true
        } catch (error) {
            logger.error(`更新账户 ${email} 代理失败`, 'ACCOUNT', '', error)
            return false
        }
    }

    /**
     * 移除账户
     * @param {string} email - 邮箱地址
     * @returns {Promise<boolean>} 移除是否成功
     */
    async removeAccount(email) {
        return this._runAccountMutation(email, async () => {
            try {
                const account = this.accountTokens.find(acc => acc.email === email)
                if (!account) return false
                // Keep memory and rotation intact if storage refuses the deletion.
                if (!await this.dataPersistence.deleteAccount(email)) return false
                const index = this.accountTokens.findIndex(acc => acc.email === email)
                // The session and its recovery state go with the account (Qwen2API-u50): a
                // request still out on it must find nothing to recover, and an account
                // added again must not inherit the old one's backoff.
                sessionPersistence.forgetRecovery(email)
                if (index !== -1) this.accountTokens.splice(index, 1)
                if (account.cli_info?.refresh_token_interval) clearInterval(account.cli_info.refresh_token_interval)
                this.accountRotator.setAccounts(this.accountTokens)
                logger.success(`成功移除账户: ${email}`, 'ACCOUNT')
                // In browser mode the signin-worker keeps a session, a renew
                // timer and a page for every account it has seen (Qwen2API-2l0).
                // Told here, inside the account's queue: the deletion is durable
                // by now, and nothing done to this account later can overtake it.
                await this._forgetWorkerSession(email)
                return true
            } catch (error) {
                logger.error(`移除账户失败 (${email})`, 'ACCOUNT', '', error)
                return false
            }
        })
    }

    /**
     * 账户已经从应用里删掉——让 signin-worker 也忘掉它（Qwen2API-2l0）：否则它为这个
     * 账户留着的会话、悄悄续期的定时器和常驻页面会一直活着。删除已经落盘，这里只是
     * 通知：signin-worker 拒绝或没有回答，账户照样是删除的，日志里留一条警告。警告分三种：
     * 拒绝——它的会话和页面会留到 signin-worker 重启；没及时回答——那边会自己做完，
     * 不用管；它等不下去了（这个账户的登录或续期一次又一次地开始）——结束后可能又
     * 留下会话，要人手动再叫一次 /forget。
     * 只有 browser 模式用得到 signin-worker。
     * @param {string} email - 邮箱地址
     * @returns {Promise<void>}
     * @private
     */
    async _forgetWorkerSession(email) {
        if (!v2sessions.browser) return
        const removed = `账户 ${email} 已删除，`
        try {
            const forgotten = await signinWorker.forgetAccount(email)
            if (forgotten.pending) {
                logger.warn(`${removed}但 signin-worker 等不下去了——这个账户的${forgotten.pending === 'login' ? '登录' : '续期'}还在进行，` +
                    '结束后可能又留下会话：需要手动再叫一次 /forget（带 signin-worker 的密钥）', 'ACCOUNT')
                return
            }
            logger.info(`signin-worker 已忘掉账户 ${email}（会话${forgotten.session ? '已清除' : '本无'}，` +
                `页面${forgotten.page ? '已关闭' : '本无'}${FORGET_PROFILE_NOTE[forgotten.profile] || ''}）`, 'ACCOUNT')
        } catch (error) {
            if (error.timedOut) {
                logger.warn(`${removed}但 signin-worker 没有及时回答 (${error.code})：那边会自己把它忘掉——` +
                    '看 signin-worker 日志里的 forget 行', 'ACCOUNT')
                return
            }
            logger.warn(`${removed}但 signin-worker 没能忘掉它 (${error.workerCode || error.code})：` +
                '它的会话、续期定时器和页面会留在 signin-worker 里，直到 signin-worker 重启', 'ACCOUNT')
        }
    }

    /**
     * 删除账户（向后兼容）
     * @param {string} email - 邮箱地址
     * @returns {Promise<boolean>} 删除是否成功
     */
    async deleteAccount(email) {
        return this.removeAccount(email)
    }

    /**
     * 为指定账户初始化CLI信息（公共方法）
     * @param {Object} account - 账户对象
     * @returns {Promise<boolean>} 初始化是否成功
     */
    async initializeCliForAccount(account) {
        if (!account) {
            logger.error('账户对象不能为空', 'CLI')
            return false
        }

        try {
            await this._initializeCliAccount(account)
            return true
        } catch (error) {
            logger.error(`为账户 ${account.email} 初始化CLI失败`, 'CLI', '', error)
            return false
        }
    }

    /**
     * 延迟函数
     * @param {number} ms - 延迟毫秒数
     * @private
     */
    async _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms))
    }

    /**
     * 清理资源
     */
    destroy() {
        lab.sessions.clear()
        // 清理自动刷新定时器
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval)
            this.refreshInterval = null
        }

        // 清理CLI请求次数重置定时器
        if (this.cliRequestNumberInterval) {
            clearTimeout(this.cliRequestNumberInterval)
            this.cliRequestNumberInterval = null
        }

        if (this.cliDailyResetInterval) {
            clearInterval(this.cliDailyResetInterval)
            this.cliDailyResetInterval = null
        }

        // 清理所有CLI账户的刷新定时器
        this.accountTokens.forEach(account => {
            if (account.cli_info && account.cli_info.refresh_token_interval) {
                clearInterval(account.cli_info.refresh_token_interval)
                account.cli_info.refresh_token_interval = null
            }
        })

        this.accountRotator.reset()
        logger.info('账户管理器已清理资源', 'ACCOUNT', '🧹')
    }

}

if (!(process.env.API_KEY || config.apiKey)) {
    logger.error('请务必设置 API_KEY 环境变量', 'CONFIG', '⚙️')
    process.exit(1)
}

const accountManager = new Account()

// 添加进程退出时的清理
process.on('exit', () => {
    if (accountManager) {
        accountManager.destroy()
    }
})

// 处理意外退出
process.on('SIGINT', () => {
    if (accountManager) {
        accountManager.destroy()
    }
    process.exit(0)
})


module.exports = accountManager
// Said where code that must not load this module can find it once it is loaded.
accountRegistry.manager = accountManager
