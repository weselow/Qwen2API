'use strict'

/**
 * Structured worker failures. Shared by the HTTP layer (server.js) and the
 * resident page service (lib/resident-pages.js) so every caller throws the
 * same error and the status map lives in one place.
 */

// Error codes -> HTTP statuses; unknown browser failures land on 500.
const STATUS_FOR_CODE = {
    invalid_request: 400,
    unauthorized: 401,
    invalid_credentials: 401,
    no_profile: 404,
    session_expired: 422,
    captcha_stuck: 502,
    form_not_found: 502,
    signin_timeout: 504,
    browser_error: 500,
    // Full logins are paced (Qwen2API-43a): retry after retryAfterMs
    signin_paced: 429,
    // Egress (Qwen2API-3ue.1)
    page_closed: 502,
    egress_failed: 502,
    egress_too_large: 502,
    resident_capacity: 503,
    egress_timeout: 504
}

class WorkerError extends Error {
    constructor(code, message) {
        super(message)
        this.code = code
    }
}

module.exports = { WorkerError, STATUS_FOR_CODE }
