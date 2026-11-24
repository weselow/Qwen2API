'use strict'

/**
 * Where account.js publishes its manager as it loads.
 *
 * For code that must not be what pulls account.js (and its timers) in, but
 * has to reach the manager once it is loaded: v2-session-persistence.js#adoptToken.
 *
 * It used to look the module up by path, `require.cache[require.resolve('./account.js')]`.
 * That works from source and fails where the app actually runs in production:
 * a compiled Bun binary has no sources on disk, the lookup throws
 * MODULE_NOT_FOUND, and every session recovery ended as failed on its last
 * step (2026-11-24, the live rollout). A module both sides import is the same
 * module in either case.
 */

module.exports = { manager: null }
