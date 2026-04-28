const config = require('../config/index.js')
const { HttpsProxyAgent } = require('https-proxy-agent')

// 按代理 URL 缓存 agent 实例（多账号共享同一代理时复用同一个 agent）
const proxyAgents = new Map()

/**
 * 解析账号实际使用的代理 URL
 * 优先级: account.proxy > 全局 PROXY_URL > 不使用代理
 * @param {Object} [account] - 账号对象（可选）
 * @returns {string|null}
 */
const resolveProxyUrl = (account) => {
    if (account && typeof account.proxy === 'string' && account.proxy.trim()) {
        return account.proxy.trim()
    }
    return config.proxyUrl || null
}

/**
 * 根据 URL 获取或创建代理 agent
 * @param {string|null} url
 * @returns {HttpsProxyAgent|undefined}
 */
const getOrCreateAgent = (url) => {
    if (!url) return undefined
    let agent = proxyAgents.get(url)
    if (!agent) {
        agent = new HttpsProxyAgent(url)
        proxyAgents.set(url, agent)
    }
    return agent
}

/**
 * 获取代理 Agent
 * @param {Object} [account] - 账号对象（可选）。未传则回退到全局 PROXY_URL
 * @returns {HttpsProxyAgent|undefined}
 */
const getProxyAgent = (account) => {
    return getOrCreateAgent(resolveProxyUrl(account))
}

/**
 * 显式失效缓存中的某个代理 agent
 * 当账号代理 URL 被修改或删除时调用，释放底层 socket
 * @param {string|null} url
 */
const invalidateProxyAgent = (url) => {
    if (!url) return
    const agent = proxyAgents.get(url)
    if (!agent) return
    try {
        if (typeof agent.destroy === 'function') {
            agent.destroy()
        }
    } catch (_) {
        // destroy 失败不影响后续逻辑
    }
    proxyAgents.delete(url)
}

/**
 * 获取 Chat API 基础 URL
 * @returns {string}
 */
const getChatBaseUrl = () => config.qwenChatProxyUrl

/**
 * 获取 CLI API 基础 URL
 * @returns {string}
 */
const getCliBaseUrl = () => config.qwenCliProxyUrl

/**
 * 为 axios 请求配置添加代理设置
 * 注意：account 作为第二个可选参数以保持向后兼容（旧调用点只传 requestConfig）
 * @param {Object} [requestConfig] - axios 请求配置对象
 * @param {Object} [account] - 账号对象（可选）
 * @returns {Object}
 */
const applyProxyToAxiosConfig = (requestConfig = {}, account) => {
    const proxyAgent = getProxyAgent(account)
    if (proxyAgent) {
        requestConfig.httpsAgent = proxyAgent
        requestConfig.proxy = false
    }
    return requestConfig
}

/**
 * 为 fetch 请求配置添加代理设置
 * @param {Object} [fetchOptions] - fetch 请求配置对象
 * @param {Object} [account] - 账号对象（可选）
 * @returns {Object}
 */
const applyProxyToFetchOptions = (fetchOptions = {}, account) => {
    const proxyAgent = getProxyAgent(account)
    if (proxyAgent) {
        fetchOptions.agent = proxyAgent
    }
    return fetchOptions
}

module.exports = {
    resolveProxyUrl,
    getProxyAgent,
    invalidateProxyAgent,
    getChatBaseUrl,
    getCliBaseUrl,
    applyProxyToAxiosConfig,
    applyProxyToFetchOptions
}
