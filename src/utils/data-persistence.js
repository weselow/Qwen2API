const fs = require('fs').promises
const path = require('path')
const config = require('../config/index.js')
const redisClient = require('./redis')
const { logger } = require('./logger')
const { resolveRuntimePath } = require('./runtime-paths')

/**
 * 数据持久化管理器
 * 统一处理账户数据的存储和读取
 */
// Debounce 窗口（per-email）写入 stats——避免每次 token 累计都触发文件 I/O
const STATS_PERSIST_DEBOUNCE_MS = 5000
// 备份（data.json.bak）最小刷新间隔——不必每次落盘都多写一份
const BACKUP_MIN_INTERVAL_MS = 5 * 60 * 1000
// rename 重试间隔：Windows / 网络盘上目标文件被占用时可能短暂 EPERM / EBUSY
const RENAME_RETRY_DELAYS_MS = [20, 50, 100]

// 进程内串行化：所有对 data.json 的 read-modify-write 排队执行。
// 队列必须是模块级的——进程里存在多个 DataPersistence 实例
// （utils/account.js 一个、routes/settings.js 一个），实例级的锁挡不住并发。
// 注：多个进程共享文件时仍可能「后写覆盖先写」丢一次统计，
// 但原子 rename 保证任何时刻文件都是完整 JSON，不会再出现半截内容。
let fileWriteQueue = Promise.resolve()
let tmpFileCounter = 0
let lastBackupAt = 0

/**
 * 把一次文件读写排入串行队列
 * @param {Function} task - 返回 Promise 的任务
 * @returns {Promise<*>} 任务结果
 */
const enqueueFileTask = (task) => {
  const result = fileWriteQueue.then(task, task)
  // 队列本身不能因为单次失败而中断
  fileWriteQueue = result.then(() => { }, () => { })
  return result
}

// Serialize account writes/deletes across persistence instances. A deleted record
// may only be recreated by an explicit account addition, never a stale stats save.
const accountWriteQueues = new Map()
const deletedAccountKeys = new Set()
const accountVersions = new Map()
const markAccountDeleted = (key) => {
  if (!deletedAccountKeys.has(key)) accountVersions.set(key, (accountVersions.get(key) || 0) + 1)
  deletedAccountKeys.add(key)
}
const enqueueAccountTask = (key, task) => {
  const previous = accountWriteQueues.get(key) || Promise.resolve()
  const result = previous.then(task, task)
  const tail = result.then(() => {}, () => {})
  accountWriteQueues.set(key, tail)
  tail.then(() => { if (accountWriteQueues.get(key) === tail) accountWriteQueues.delete(key) })
  return result
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

// v2 会话在 Redis 里的家：独立 hash，不进 user:*（getAllAccounts 的 SCAN
// 靠 user:* 圈定账户，会话混进去会把 bearer token 泄进账户列表）
const V2_SESSIONS_KEY = 'qwen2api:v2sessions'

class DataPersistence {
  constructor() {
    this.dataFilePath = resolveRuntimePath('data', 'data.json')
    // 最近一次「解析成功」的快照，用于文件损坏时自愈
    this.backupFilePath = `${this.dataFilePath}.bak`
    // v2 浏览器会话（token + cookie-jar）单独落盘：token 是 bearer 凭据，
    // 不能混进默认权限的 data.json（Qwen2API-jik.4）
    this.v2SessionsFilePath = resolveRuntimePath('data', 'v2-sessions.json')
    // 每个 email 的待持久化 stats 与定时器（debounce）
    this._statsPersistTimers = new Map()
    this._statsPendingPayload = new Map()
  }

  /**
   * 加载所有账户数据
   * @returns {Promise<Array>} 账户列表
   */
  async loadAccounts() {
    try {
      switch (config.dataSaveMode) {
        case 'redis':
          return await this._loadFromRedis()
        case 'file':
          return await this._loadFromFile()
        case 'none':
          return await this._loadFromEnv()
        default:
          logger.error(`不支持的数据保存模式: ${config.dataSaveMode}`, 'DATA')
          throw new Error(`不支持的数据保存模式: ${config.dataSaveMode}`)
      }
    } catch (error) {
      logger.error('加载账户数据失败', 'DATA', '', error)
      throw error
    }
  }

  _accountKey(email) {
    const store = config.dataSaveMode === 'redis' ? config.redisURL : this.dataFilePath
    return JSON.stringify([config.dataSaveMode, store, email])
  }

  /** Save an account; only explicit additions may recreate a deleted record. */
  async saveAccount(email, accountData, { allowCreate = false, expectedVersion } = {}) {
    const key = this._accountKey(email)
    const version = expectedVersion ?? (accountVersions.get(key) || 0)
    return enqueueAccountTask(key, async () => {
      if ((accountVersions.get(key) || 0) !== version || (deletedAccountKeys.has(key) && !allowCreate)) return false
      try {
        let saved
        switch (config.dataSaveMode) {
          case 'redis': saved = await this._saveToRedis(email, accountData); break
          case 'file': saved = await this._saveToFile(email, accountData); break
          case 'none': return false
          default: throw new Error(`Unsupported data save mode: ${config.dataSaveMode}`)
        }
        if (saved && allowCreate) deletedAccountKeys.delete(key)
        return saved
      } catch (error) {
        logger.error(`保存账户数据失败 (${email})`, 'DATA', '', error)
        return false
      }
    })
  }

  /** Delete storage before acknowledging removal from the in-memory account list. */
  async deleteAccount(email) {
    const key = this._accountKey(email)
    return enqueueAccountTask(key, async () => {
      try {
        let removed
        switch (config.dataSaveMode) {
          case 'redis': removed = await redisClient.deleteAccount(email); break
          case 'file': removed = await this._deleteFromFile(email, key); break
          case 'none': removed = true; break
          default: throw new Error(`Unsupported data save mode: ${config.dataSaveMode}`)
        }
        if (removed) {
          markAccountDeleted(key)
          const timer = this._statsPersistTimers.get(email)
          if (timer) clearTimeout(timer)
          this._statsPersistTimers.delete(email)
          this._statsPendingPayload.delete(email)
          // 账户删除后，其 v2 会话记录（bearer token + jar）不能留在线上：
          // 删除失败只记日志——账户本体已删，回滚它只会更糟。
          // Already inside this account's queue: the unqueued variant.
          if (!(await this.deleteV2SessionNow(email))) {
            logger.error(`账户已删除但其 v2 会话记录删除失败 (${email})`, 'DATA')
          }
        }
        return removed
      } catch (error) {
        logger.error(`删除账户数据失败 (${email})`, 'DATA', '', error)
        return false
      }
    })
  }

  async _deleteFromFile(email, key) {
    return enqueueFileTask(async () => {
      const data = await this._readDataFile()
      data.accounts = (data.accounts || []).filter(account => account.email !== email)
      const content = JSON.stringify(data, null, 2)
      // Deletion must also reach recovery data, including deletion of the last
      // record. Refresh this snapshot before committing the authoritative file.
      let previousBackup = null
      try { previousBackup = await fs.readFile(this.backupFilePath, 'utf-8') }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      await this._writeFileAtomic(this.backupFilePath, content)
      try {
        await this._writeFileAtomic(this.dataFilePath, content)
      } catch (error) {
        try {
          if (previousBackup === null) await fs.unlink(this.backupFilePath)
          else await this._writeFileAtomic(this.backupFilePath, previousBackup)
        } catch (rollbackError) {
          logger.error('Account deletion backup rollback failed', 'DATA', '', rollbackError)
        }
        throw error
      }
      lastBackupAt = Date.now()
      markAccountDeleted(key)
      return true
    })
  }

  // v2 浏览器会话持久化（Qwen2API-jik.4）。记录对存储层不透明——
  // {token, expiresAt, jar} 由 v2-session-persistence 序列化/反序列化，
  // 这里只负责按 backend 落盘；过期裁剪在读取方（restore）做。

  /**
   * 加载全部 v2 会话记录
   * @returns {Promise<Object>} { [email]: {token, expiresAt, jar} }
   */
  async loadV2Sessions() {
    try {
      switch (config.dataSaveMode) {
        case 'redis': return await this._loadV2SessionsFromRedis()
        case 'file': return await this._loadV2SessionsFromFile()
        case 'none': return {}
        default:
          logger.error(`不支持的数据保存模式: ${config.dataSaveMode}`, 'DATA')
          return {}
      }
    } catch (error) {
      logger.error('加载 v2 会话数据失败', 'DATA', '', error)
      return {}
    }
  }

  /**
   * 保存单个账户的 v2 会话。已删除的账户拒绝恢复写入——
   * 会话 token 是 bearer 凭据，绝不能因迟到的续期而复活。
   * @returns {Promise<boolean>} 写入是否成功
   */
  async saveV2Session(email, session) {
    if (!email || !session) return false
    const key = this._accountKey(email)
    return enqueueAccountTask(key, async () => {
      if (deletedAccountKeys.has(key)) return false
      try {
        switch (config.dataSaveMode) {
          case 'redis':
            await redisClient.hset(V2_SESSIONS_KEY, email, JSON.stringify(session))
            return true
          case 'file':
            return await this._saveV2SessionToFile(email, session)
          case 'none': return false
          default: throw new Error(`Unsupported data save mode: ${config.dataSaveMode}`)
        }
      } catch (error) {
        logger.error(`保存 v2 会话失败 (${email})`, 'DATA', '', error)
        return false
      }
    })
  }

  /**
   * 删除单个账户的 v2 会话记录（401 失效、账户删除）
   * 与保存走同一条 per-account 队列：晚于保存发出的删除一定晚于它落地。
   * 否则还在排队的保存会把刚作废的会话写回线上（Qwen2API-3ue.2）。
   * @returns {Promise<boolean>} 删除是否成功
   */
  async deleteV2Session(email) {
    if (!email) return false
    return enqueueAccountTask(this._accountKey(email), () => this.deleteV2SessionNow(email))
  }

  /** deleteV2Session для того, кто уже держит очередь аккаунта (deleteAccount). */
  async deleteV2SessionNow(email) {
    try {
      switch (config.dataSaveMode) {
        case 'redis': {
          await redisClient.hdel(V2_SESSIONS_KEY, email)
          return true
        }
        case 'file': return await this._deleteV2SessionFromFile(email)
        case 'none': return true
        default: throw new Error(`Unsupported data save mode: ${config.dataSaveMode}`)
      }
    } catch (error) {
      logger.error(`删除 v2 会话失败 (${email})`, 'DATA', '', error)
      return false
    }
  }

  async _loadV2SessionsFromRedis() {
    const raw = await redisClient.hgetall(V2_SESSIONS_KEY)
    const sessions = {}
    for (const [email, value] of Object.entries(raw || {})) {
      try {
        const record = JSON.parse(value)
        if (record && typeof record === 'object') sessions[email] = record
      } catch (parseError) {
        logger.warn(`v2 会话 JSON 损坏，跳过 (${email})`, 'DATA')
      }
    }
    return sessions
  }

  async _loadV2SessionsFromFile() {
    return enqueueFileTask(async () => (await this._readV2SessionsFile()).sessions)
  }

  async _saveV2SessionToFile(email, session) {
    return enqueueFileTask(async () => {
      const data = await this._readV2SessionsFile()
      data.sessions[email] = session
      await this._writeV2SessionsFile(data)
      return true
    })
  }

  async _deleteV2SessionFromFile(email) {
    return enqueueFileTask(async () => {
      const data = await this._readV2SessionsFile()
      if (!(email in data.sessions)) return true
      delete data.sessions[email]
      await this._writeV2SessionsFile(data)
      return true
    })
  }

  /**
   * 读取 v2-sessions.json；损坏时隔离原件并返回空集——会话可再生
   * （signin-worker 一次续期即可重建），不值得像 data.json 那样中止启动。
   * @returns {Promise<{sessions: Object}>}
   */
  async _readV2SessionsFile() {
    let content
    try {
      content = await fs.readFile(this.v2SessionsFilePath, 'utf-8')
    } catch (error) {
      if (error.code === 'ENOENT') return { sessions: {} }
      throw error
    }
    try {
      const data = JSON.parse(content)
      if (data && typeof data === 'object' && !Array.isArray(data) && data.sessions &&
          typeof data.sessions === 'object' && !Array.isArray(data.sessions)) {
        return data
      }
      throw new Error('unexpected v2 sessions file shape')
    } catch (parseError) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const quarantinePath = `${this.v2SessionsFilePath}.corrupt-${stamp}`
      logger.error(
        `v2 会话文件损坏 (${this.v2SessionsFilePath})，弃用全部会话并隔离原件: ${quarantinePath}`,
        'DATA'
      )
      try {
        await fs.rename(this.v2SessionsFilePath, quarantinePath)
      } catch (renameError) {
        logger.warn(`损坏 v2 会话文件隔离失败: ${renameError.message}`, 'DATA')
      }
      return { sessions: {} }
    }
  }

  /**
   * v2-sessions.json 原子写入，权限 0600——文件里是 bearer token
   * 与会话 cookie，同目录的 data.json 没有这类凭据，维持默认权限。
   */
  async _writeV2SessionsFile(data) {
    const content = JSON.stringify(data, null, 2)
    await fs.mkdir(path.dirname(this.v2SessionsFilePath), { recursive: true })
    await this._writeFileAtomic(this.v2SessionsFilePath, content, 0o600)
  }

  /**
   * 加载运行时设置（chat retry config 等）
   * 在 'none' 模式下返回 {}, 因为没有可写存储
   * @returns {Promise<Object>} 设置对象 (空对象表示尚未存储任何值)
   */
  async loadSettings() {
    try {
      switch (config.dataSaveMode) {
        case 'redis':
          return (await redisClient.getSettings()) || {}
        case 'file':
          return await this._loadSettingsFromFile()
        case 'none':
          return {}
        default:
          logger.error(`不支持的数据保存模式: ${config.dataSaveMode}`, 'DATA')
          return {}
      }
    } catch (error) {
      logger.error('加载运行时设置失败', 'DATA', '', error)
      return {}
    }
  }

  /**
   * 保存运行时设置（部分合并）
   * @param {Object} partial - 要写入的字段
   * @returns {Promise<boolean>} 保存是否成功
   */
  async saveSettings(partial) {
    try {
      switch (config.dataSaveMode) {
        case 'redis':
          return await redisClient.setSettings(partial)
        case 'file':
          return await this._saveSettingsToFile(partial)
        case 'none':
          logger.warn('环境变量模式不支持保存运行时设置', 'DATA')
          return false
        default:
          logger.error(`不支持的数据保存模式: ${config.dataSaveMode}`, 'DATA')
          return false
      }
    } catch (error) {
      logger.error('保存运行时设置失败', 'DATA', '', error)
      return false
    }
  }

  async _loadSettingsFromFile() {
    return enqueueFileTask(async () => {
      const data = await this._readDataFile()
      return (data.settings && typeof data.settings === 'object') ? data.settings : {}
    })
  }

  async _saveSettingsToFile(partial) {
    return enqueueFileTask(async () => {
      const data = await this._readDataFile()
      data.settings = { ...(data.settings || {}), ...partial }
      await this._writeDataFile(data)
      return true
    })
  }

  /**
   * 批量保存账户数据
   * @param {Array} accounts - 账户列表
   * @returns {Promise<boolean>} 保存是否成功
   */
  async saveAllAccounts(accounts) {
    const versions = new Map(accounts.map(account => [account.email, accountVersions.get(this._accountKey(account.email)) || 0]))
    try {
      switch (config.dataSaveMode) {
        case 'redis':
          return await this._saveAllToRedis(accounts, versions)
        case 'file':
          return await this._saveAllToFile(accounts, versions)
        case 'none':
          logger.warn('环境变量模式不支持保存账户数据', 'DATA')
          return false
        default:
          logger.error(`不支持的数据保存模式: ${config.dataSaveMode}`, 'DATA')
          throw new Error(`不支持的数据保存模式: ${config.dataSaveMode}`)
      }
    } catch (error) {
      logger.error('批量保存账户数据失败', 'DATA', '', error)
      return false
    }
  }

  /**
   * 从 Redis 加载账户数据
   * @private
   */
  async _loadFromRedis() {
    const accounts = await redisClient.getAllAccounts()
    return accounts.length > 0 ? accounts : []
  }

  /**
   * 从文件加载账户数据
   * @private
   */
  async _loadFromFile() {
    return enqueueFileTask(async () => {
      const data = await this._readDataFile()
      return data.accounts || []
    })
  }

  /**
   * 从环境变量加载账户数据
   * @private
   */
  async _loadFromEnv() {
    if (!process.env.ACCOUNTS) {
      return []
    }

    const { parseAccountLine } = require('./account-parser')
    const accountTokens = process.env.ACCOUNTS.split(',')
    const accounts = []

    // 解析委托给共用 parser，与后台批量添加保持一致；
    // 注意：这里仅加载凭据，token 在 Account 类中按需登录获取
    for (const item of accountTokens) {
      const parsed = parseAccountLine(item)
      if (parsed) {
        accounts.push({ ...parsed, token: null, expires: null })
      }
    }

    return accounts
  }

  /**
   * 保存到 Redis
   * @private
   */
  async _saveToRedis(email, accountData) {
    return await redisClient.setAccount(email, accountData)
  }

  /**
   * 保存到文件（MERGE 语义）
   * partial save（仅 token、proxy、stats）不应覆盖未传字段——保留 existing 值
   * @private
   */
  async _saveToFile(email, accountData) {
    return enqueueFileTask(async () => {
      const data = await this._readDataFile()

      if (!data.accounts) {
        data.accounts = []
      }

      const existingIndex = data.accounts.findIndex(account => account.email === email)
      const existing = existingIndex !== -1 ? data.accounts[existingIndex] : {}

      // 仅写入显式传入的字段；未传字段保留 existing 值。stats 同理——
      // 避免 token refresh / proxy update 的 partial save 把累计 stats 清零
      const merged = { ...existing, email }
      if (accountData.password !== undefined) merged.password = accountData.password
      if (accountData.token !== undefined) merged.token = accountData.token
      if (accountData.expires !== undefined) merged.expires = accountData.expires
      if (accountData.proxy !== undefined) merged.proxy = accountData.proxy ?? null
      if (accountData.stats !== undefined) merged.stats = accountData.stats
      if (accountData.statsHistory !== undefined) merged.statsHistory = accountData.statsHistory
      if (accountData.fingerprint !== undefined) merged.fingerprint = accountData.fingerprint

      if (existingIndex !== -1) {
        data.accounts[existingIndex] = merged
      } else {
        data.accounts.push(merged)
      }

      await this._writeDataFile(data)
      return true
    })
  }

  /**
   * 批量保存到 Redis
   * @private
   */
  async _saveAllToRedis(accounts, versions) {
    let successCount = 0
    for (const account of accounts) {
      const success = await this.saveAccount(account.email, account, { expectedVersion: versions.get(account.email) })
      if (success) successCount++
    }
    return successCount === accounts.length
  }

  /**
   * 批量保存到文件
   * @private
   */
  async _saveAllToFile(accounts, versions) {
    return enqueueFileTask(async () => {
      const data = await this._readDataFile()

      // Like Redis HSET, a daily snapshot updates records without removing
      // accounts added concurrently. Ignore snapshots predating a deletion.
      const merged = new Map((data.accounts || []).map(account => [account.email, account]))
      for (const account of accounts) {
        const key = this._accountKey(account.email)
        if (deletedAccountKeys.has(key) || versions.get(account.email) !== (accountVersions.get(key) || 0)) continue
        merged.set(account.email, {
          email: account.email,
          password: account.password,
          token: account.token,
          expires: account.expires,
          proxy: account.proxy ?? null,
          stats: account.stats ?? undefined,
          statsHistory: account.statsHistory ?? undefined,
          fingerprint: account.fingerprint ?? undefined
        })
      }
      data.accounts = [...merged.values()]

      await this._writeDataFile(data)
      return true
    })
  }

  /**
   * 调度 per-account daily stats 持久化（debounce 5 秒）
   * 高频 accumulateStats 调用合并为单次 I/O——重复调用替换上一个 timer
   * dataSaveMode='none' 时不写盘，返回 false
   * @param {string} email - 邮箱
   * @param {Object} stats - 完整 stats 对象 { chat: {input,output}, cli: {calls,input,output} }
   * @returns {boolean} 是否调度成功
   */
  saveAccountStats(email, stats) {
    if (config.dataSaveMode === 'none') {
      return false
    }
    if (!email || !stats || deletedAccountKeys.has(this._accountKey(email))) {
      return false
    }

    // 替换 pending payload 与 timer
    this._statsPendingPayload.set(email, stats)
    const prev = this._statsPersistTimers.get(email)
    if (prev) clearTimeout(prev)

    const timer = setTimeout(async () => {
      this._statsPersistTimers.delete(email)
      const payload = this._statsPendingPayload.get(email)
      this._statsPendingPayload.delete(email)
      if (!payload) return
      try {
        await this.saveAccount(email, { stats: payload })
      } catch (error) {
        logger.error(`stats 持久化失败 (${email})`, 'STATS', '', error)
      }
    }, STATS_PERSIST_DEBOUNCE_MS)

    this._statsPersistTimers.set(email, timer)
    return true
  }

  /**
   * 读取并解析 data.json；解析失败时尝试用备份自愈
   * 仅在 enqueueFileTask 内部调用——保证 read-modify-write 不交错
   * @returns {Promise<Object>} 解析后的数据对象
   * @private
   */
  async _readDataFile() {
    await this._ensureDataFileExists()

    const fileContent = await fs.readFile(this.dataFilePath, 'utf-8')
    let data
    try {
      data = JSON.parse(fileContent)
    } catch (parseError) {
      return await this._recoverFromBackup(parseError, fileContent.length)
    }

    // 解析成功即为「已知良好」，按最小间隔刷新备份
    await this._refreshBackup(fileContent, data)
    return data
  }

  /**
   * data.json 损坏时的恢复：优先用备份，没有备份就大声报错并中止
   * 绝不能静默返回空账户列表——那会让服务带着 0 个账户启动，
   * 之后所有请求都以「无可用令牌」失败，并且下一次写入会把损坏文件覆盖掉
   * @param {Error} parseError - JSON.parse 抛出的错误
   * @param {number} brokenSize - 损坏文件的字符数（便于排查）
   * @returns {Promise<Object>} 从备份恢复的数据对象
   * @private
   */
  async _recoverFromBackup(parseError, brokenSize) {
    logger.error(
      `数据文件损坏: ${this.dataFilePath} (${brokenSize} 字符) — ${parseError.message}`,
      'DATA'
    )

    let backupContent = null
    let backupData
    try {
      backupContent = await fs.readFile(this.backupFilePath, 'utf-8')
      backupData = JSON.parse(backupContent)
    } catch (backupError) {
      backupData = null
    }

    if (!backupData || typeof backupData !== 'object') {
      logger.error(
        `备份不可用 (${this.backupFilePath})，账户数据无法自动恢复；` +
        '损坏文件已原样保留，请人工修复后重启服务',
        'DATA'
      )
      throw new Error(`数据文件 ${this.dataFilePath} 损坏且无可用备份: ${parseError.message}`)
    }

    // 先给损坏文件留证（copy 而非 rename——避免中途崩溃导致 data.json 缺失），再用备份覆盖
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const quarantinePath = `${this.dataFilePath}.corrupt-${stamp}`
    try {
      await fs.copyFile(this.dataFilePath, quarantinePath)
    } catch (copyError) {
      logger.warn(`损坏文件留证失败: ${quarantinePath}`, 'DATA', '', copyError)
    }

    await this._writeFileAtomic(this.dataFilePath, backupContent)
    logger.warn(
      `已用备份恢复数据文件（${(backupData.accounts || []).length} 个账户）；` +
      `损坏副本: ${quarantinePath}`,
      'DATA'
    )
    return backupData
  }

  /**
   * 写入 data.json 并刷新备份
   * @param {Object} data - 完整数据对象
   * @private
   */
  async _writeDataFile(data) {
    const content = JSON.stringify(data, null, 2)
    await this._writeFileAtomic(this.dataFilePath, content)
    await this._refreshBackup(content, data)
  }

  /**
   * 原子写入：先写同目录临时文件 + fsync，再 rename 覆盖目标
   * rename 在同一文件系统内是原子的——读取方永远看到完整文件；
   * 中途崩溃也只会留下临时文件，目标文件保持上一版完整内容
   * @param {string} targetPath - 目标文件路径
   * @param {string} content - 文件内容
   * @param {number} [mode] - 目标文件权限（POSIX）；chmod 显式设置，不受 umask 影响
   * @private
   */
  async _writeFileAtomic(targetPath, content, mode) {
    const tmpPath = `${targetPath}.${process.pid}.${++tmpFileCounter}.tmp`
    let handle = null
    try {
      handle = await fs.open(tmpPath, 'w', mode)
      if (mode !== undefined) await handle.chmod(mode)
      await handle.writeFile(content, 'utf-8')
      // fsync：保证 rename 之后内容确实落盘（掉电 / 容器被杀时才不会拿到空文件）
      await handle.sync()
      await handle.close()
      handle = null

      await this._renameWithRetry(tmpPath, targetPath)
    } catch (error) {
      if (handle) {
        try { await handle.close() } catch (closeError) { /* 已经失败，忽略 */ }
      }
      try { await fs.unlink(tmpPath) } catch (unlinkError) { /* 临时文件可能不存在 */ }
      throw error
    }
  }

  /**
   * rename 重试：目标文件被杀毒软件 / 另一进程短暂占用时不至于直接失败
   * @param {string} fromPath - 临时文件路径
   * @param {string} toPath - 目标文件路径
   * @private
   */
  async _renameWithRetry(fromPath, toPath) {
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(fromPath, toPath)
        return
      } catch (error) {
        const retriable = error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'EBUSY'
        if (!retriable || attempt >= RENAME_RETRY_DELAYS_MS.length) {
          throw error
        }
        await sleep(RENAME_RETRY_DELAYS_MS[attempt])
      }
    }
  }

  /**
   * 刷新备份文件（限流；失败不影响主流程）
   * @param {string} content - 已确认可解析的内容
   * @param {Object} data - 与 content 对应的数据对象
   * @private
   */
  async _refreshBackup(content, data) {
    // 空账户列表不值得做备份，更不能拿它覆盖已有备份：
    // data.json 被误删时会先生成空的默认文件，备份必须留住上一份真实数据
    if (!data || !Array.isArray(data.accounts) || data.accounts.length === 0) {
      return
    }

    const now = Date.now()
    if (now - lastBackupAt < BACKUP_MIN_INTERVAL_MS) {
      return
    }
    lastBackupAt = now

    try {
      await this._writeFileAtomic(this.backupFilePath, content)
    } catch (error) {
      logger.warn('备份文件写入失败（不影响主数据文件）', 'DATA', '', error)
    }
  }

  /**
   * 确保数据文件存在
   * @private
   */
  async _ensureDataFileExists() {
    try {
      await fs.access(this.dataFilePath)
    } catch (error) {
      logger.info('数据文件不存在，正在创建默认文件...', 'FILE', '📁')

      // 确保目录存在
      const dirPath = path.dirname(this.dataFilePath)
      await fs.mkdir(dirPath, { recursive: true })

      // 创建默认数据结构
      const defaultData = {
        defaultHeaders: null,
        defaultCookie: null,
        accounts: []
      }

      await this._writeFileAtomic(this.dataFilePath, JSON.stringify(defaultData, null, 2))
      logger.success('默认数据文件创建成功', 'FILE')
    }
  }
}

module.exports = DataPersistence
