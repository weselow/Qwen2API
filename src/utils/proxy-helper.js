const config = require('../config/index.js')
const dns = require('dns')
const net = require('net')
const https = require('https')
const { HttpsProxyAgent } = require('https-proxy-agent')
const { logger } = require('./logger')

// agent 缓存。key = `${代理URL|direct}|${固定入口的域名|-}|${固定入口的IP|-}`
// 域名和 IP 必须进 key：同一个代理在不同入口 IP 下需要不同的 agent，
// 否则切换入口后旧 agent 仍然握着连向坏入口的 socket
const proxyAgents = new Map()

// 接受 http/https/socks5 协议；正则故意宽松，仅拦截最常见的拼写错误
// （缺少协议、错误协议如 'htp://'），不强制 host 形态以免拒绝合法的
// 含用户名/密码、IPv6、自定义路径的代理 URL
const PROXY_URL_REGEX = /^(https?|socks5):\/\/[^\s]+$/i

/**
 * 校验代理 URL 格式
 * 空值（null/undefined/空字符串）视为合法（表示"无账号级代理"）
 * @param {string|null|undefined} url
 * @returns {boolean}
 */
const isValidProxyUrl = (url) => {
    if (url === null || url === undefined || url === '') return true
    if (typeof url !== 'string') return false
    const trimmed = url.trim()
    if (!trimmed) return true
    return PROXY_URL_REGEX.test(trimmed)
}

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
 * 获取 Chat API 基础 URL
 * @returns {string}
 */
const getChatBaseUrl = () => config.qwenChatProxyUrl

/**
 * 获取 CLI API 基础 URL
 * @returns {string}
 */
const getCliBaseUrl = () => config.qwenCliProxyUrl

// ========== 入口 IP 固定 ==========
//
// 阿里云的 DNS 按提问者所在地区返回不同的入口地址。俄罗斯方向拿到的
// 8.209.x 能建连、能完成握手，但数据流会卡死；境外拿到的 47.x 一切正常。
// 通过代理时域名由代理自己解析（隧道里走的是 CONNECT chat.qwen.ai:443），
// 所以 hosts 和自建 DNS 都救不了。
//
// 这里做的等价于 curl --connect-to：TCP 连到指定 IP，域名照旧进 SNI、
// 证书校验和 Host 头。rejectUnauthorized 一律不动。

// 域名 -> { ips: string[], index: number }。只有配置了对应环境变量的域名才在表里
let endpointRegistry = null

/**
 * 从 URL 中安全地取出域名
 * @param {string|null|undefined} baseUrl
 * @returns {string|null}
 */
const safeHostname = (baseUrl) => {
    if (!baseUrl || typeof baseUrl !== 'string') return null
    try {
        return new URL(baseUrl).hostname || null
    } catch (_) {
        return null
    }
}

/**
 * 构建入口 IP 表（惰性，首次使用时构建）
 * @returns {Map<string, {ips: string[], index: number}>}
 */
const getEndpointRegistry = () => {
    if (endpointRegistry) return endpointRegistry

    endpointRegistry = new Map()
    const register = (baseUrl, ips) => {
        if (!Array.isArray(ips) || ips.length === 0) return
        const hostname = safeHostname(baseUrl)
        if (!hostname) return
        endpointRegistry.set(hostname, { ips: [...ips], index: 0 })
        logger.info(`入口 IP 已固定 ${hostname} -> ${ips.join(', ')}（域名仍用于 SNI 与证书校验）`, 'PROXY', '📌')
    }
    register(config.qwenChatProxyUrl, config.qwenChatEndpointIps)
    register(config.qwenCliProxyUrl, config.qwenCliEndpointIps)
    return endpointRegistry
}

/**
 * 重新读取入口 IP 配置并丢弃全部缓存的 agent
 * 配置在运行时被改动（或测试需要重置）时调用
 */
const reloadEndpointConfig = () => {
    endpointRegistry = null
    for (const [key, agent] of proxyAgents) {
        destroyAgent(agent)
        proxyAgents.delete(key)
    }
}

/**
 * 目标 URL 当前生效的入口 IP
 * @param {string} baseUrl
 * @returns {string|null} 未配置固定入口时返回 null
 */
const getActiveEndpointIp = (baseUrl) => {
    const state = getEndpointRegistry().get(safeHostname(baseUrl))
    return state ? state.ips[state.index] : null
}

/**
 * 目标 URL 配置了几个入口 IP
 * @param {string} baseUrl
 * @returns {number}
 */
const getEndpointIpCount = (baseUrl) => {
    const state = getEndpointRegistry().get(safeHostname(baseUrl))
    return state ? state.ips.length : 0
}

/**
 * 当前入口 IP 不通时切到下一个，并记住它
 * @param {string} baseUrl
 * @param {string|null} [failedIp] - 报告故障时用的那个 IP
 * @returns {string|null} 切换后的 IP；无可切换时返回 null
 */
const rotateEndpointIp = (baseUrl, failedIp) => {
    const hostname = safeHostname(baseUrl)
    const state = getEndpointRegistry().get(hostname)
    if (!state || state.ips.length < 2) return null

    // 并发请求会就同一次故障重复报告；别人已经轮换过就直接沿用他们的结果，
    // 否则一次故障会把整个列表转一圈
    const current = state.ips[state.index]
    if (failedIp && failedIp !== current) return current

    state.index = (state.index + 1) % state.ips.length
    const next = state.ips[state.index]
    // 旧 agent 上的 keep-alive 连接仍然连着坏入口，必须一起丢掉
    dropAgentsForEndpoint(hostname, current)
    logger.warn(`入口 IP 切换 ${hostname}: ${current} -> ${next}`, 'PROXY')
    return next
}

/**
 * 解析目标 URL 需要固定的入口
 * @param {string} baseUrl
 * @returns {{hostname: string, ip: string}|null}
 */
const resolveEndpointPin = (baseUrl) => {
    const hostname = safeHostname(baseUrl)
    if (!hostname) return null
    const state = getEndpointRegistry().get(hostname)
    if (!state) return null
    return { hostname, ip: state.ips[state.index] }
}

/**
 * 走代理时固定入口 IP 的 agent
 * CONNECT 发往 IP，TLS 握手仍按域名：servername 进 SNI，证书也按域名校验
 */
class PinnedHttpsProxyAgent extends HttpsProxyAgent {
    constructor(proxyUrl, pin) {
        super(proxyUrl)
        this.pin = pin
    }

    connect(req, opts) {
        // 同一个 agent 只服务被固定的那个域名；其余目标原样透传
        if (!this.pin || opts.host !== this.pin.hostname) {
            return super.connect(req, opts)
        }
        return super.connect(req, {
            ...opts,
            host: this.pin.ip,
            servername: opts.servername || this.pin.hostname
        })
    }
}

/**
 * 不走代理时固定入口 IP 用的域名解析函数
 * 与改 hosts 等价，但只作用于本进程，且只作用于被固定的域名
 * @param {{hostname: string, ip: string}} pin
 * @returns {Function}
 */
const createPinnedLookup = (pin) => (hostname, options, callback) => {
    if (typeof options === 'function') {
        callback = options
        options = {}
    }
    const family = net.isIPv6(pin.ip) ? 6 : 4
    // 目标不是被固定的域名，或调用方点名要另一个协议族 —— 交回系统解析
    if (hostname !== pin.hostname || (options && options.family && options.family !== family)) {
        return dns.lookup(hostname, options, callback)
    }
    // Node 会用两种形态调用：all=true 要数组，否则要 (address, family)
    if (options && options.all) {
        return process.nextTick(callback, null, [{ address: pin.ip, family }])
    }
    return process.nextTick(callback, null, pin.ip, family)
}

/**
 * 销毁 agent，失败不影响后续逻辑
 * @param {Object} agent
 */
function destroyAgent(agent) {
    try {
        if (agent && typeof agent.destroy === 'function') {
            agent.destroy()
        }
    } catch (_) {
        // destroy 失败不影响后续逻辑
    }
}

/**
 * 丢弃绑定在某个入口 IP 上的全部 agent
 * @param {string} hostname
 * @param {string} ip
 */
function dropAgentsForEndpoint(hostname, ip) {
    const suffix = `|${hostname}|${ip}`
    for (const [key, agent] of proxyAgents) {
        if (!key.endsWith(suffix)) continue
        destroyAgent(agent)
        proxyAgents.delete(key)
    }
}

/**
 * 按代理 URL + 固定入口获取或创建 agent
 * @param {string|null} proxyUrl
 * @param {{hostname: string, ip: string}|null} pin
 * @returns {Object|undefined} 既无代理又无固定入口时返回 undefined（保持原行为）
 */
const getOrCreateAgent = (proxyUrl, pin) => {
    if (!proxyUrl && !pin) return undefined

    const key = `${proxyUrl || 'direct'}|${pin ? pin.hostname : '-'}|${pin ? pin.ip : '-'}`
    let agent = proxyAgents.get(key)
    if (!agent) {
        if (proxyUrl) {
            agent = pin
                ? new PinnedHttpsProxyAgent(proxyUrl, pin)
                : new HttpsProxyAgent(proxyUrl)
        } else {
            agent = new https.Agent({ keepAlive: true, lookup: createPinnedLookup(pin) })
        }
        proxyAgents.set(key, agent)
    }
    return agent
}

/**
 * 获取请求用的 Agent（代理 + 入口 IP 固定）
 * @param {Object} [account] - 账号对象（可选）。未传则回退到全局 PROXY_URL
 * @param {string} [targetBaseUrl] - 目标服务的基础 URL。默认 Chat 服务；
 *        发往 CLI（portal.qwen.ai）等其他域名时必须显式传入，否则会套用 Chat 的入口 IP
 * @returns {Object|undefined}
 */
const getProxyAgent = (account, targetBaseUrl) => {
    const baseUrl = targetBaseUrl === undefined ? getChatBaseUrl() : targetBaseUrl
    return getOrCreateAgent(resolveProxyUrl(account), resolveEndpointPin(baseUrl))
}

/**
 * 显式失效缓存中某个代理 URL 的全部 agent
 * 当账号代理 URL 被修改或删除时调用，释放底层 socket
 * @param {string|null} url
 */
const invalidateProxyAgent = (url) => {
    if (!url) return
    const prefix = `${url}|`
    for (const [key, agent] of proxyAgents) {
        if (!key.startsWith(prefix)) continue
        destroyAgent(agent)
        proxyAgents.delete(key)
    }
}

/**
 * 为 axios 请求配置添加代理设置
 * 注意：account 作为第二个可选参数以保持向后兼容（旧调用点只传 requestConfig）
 * @param {Object} [requestConfig] - axios 请求配置对象
 * @param {Object} [account] - 账号对象（可选）
 * @param {string} [targetBaseUrl] - 目标服务基础 URL（默认 Chat 服务）
 * @returns {Object}
 */
const applyProxyToAxiosConfig = (requestConfig = {}, account, targetBaseUrl) => {
    const proxyAgent = getProxyAgent(account, targetBaseUrl)
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
 * @param {string} [targetBaseUrl] - 目标服务基础 URL（默认 Chat 服务）
 * @returns {Object}
 */
const applyProxyToFetchOptions = (fetchOptions = {}, account, targetBaseUrl) => {
    const proxyAgent = getProxyAgent(account, targetBaseUrl)
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
    applyProxyToFetchOptions,
    isValidProxyUrl,
    getActiveEndpointIp,
    getEndpointIpCount,
    rotateEndpointIp,
    reloadEndpointConfig
}
