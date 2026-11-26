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
 *
 * And where the app notes the accounts it has removed, and has not added
 * again (Qwen2API-u50) — read by the worker client and by the session's
 * recovery, for the same reason: both must see one list.
 *
 * A request that was already running on an account when the operator removed
 * it keeps that account's object, and its retry, or its session's recovery,
 * would ask the worker for the account again: the worker would open its page
 * and cache a session for an account that is gone — and, with the profile
 * deleted, the app would go on to sign the account in by password. The worker
 * cannot tell such a call from one for an account just added; the app can.
 *
 * Known, not guessed: an account is refused because the app removed it
 * (removeAccount says so, through v2-session-persistence#forgetRecovery) —
 * never merely because the manager does not hold it, since calls are made for
 * accounts the manager never held too. Added again — once its record is
 * saved for good (account.js, _addAccountWithToken) — it is not refused any
 * more; until then it stays removed, whatever the manager's records hold for
 * the moment, since a record being saved may still roll back.
 */

// The accounts removed and not added again, by email.
const removedAccounts = new Set()

// What a call for an account the app no longer has ends with.
const ACCOUNT_REMOVED = 'signin_account_removed'

const registry = {
    // Set by account.js as it loads: the account manager.
    manager: null,
    removedAccounts,
    ACCOUNT_REMOVED,
    noteRemoved,
    noteAdded,
    accountRemoved
}

/** The app removed the account: from here on no request of its reaches the worker for it. */
function noteRemoved(email) {
    if (email) removedAccounts.add(email)
}

/** The account is the app's again — its record saved for good. */
function noteAdded(email) {
    removedAccounts.delete(email)
}

/** A lookup, nothing more: whether the app removed this account and has not added it again since. */
function accountRemoved(email) {
    return Boolean(email) && removedAccounts.has(email)
}

module.exports = registry
