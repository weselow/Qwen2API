const { detectWafChallenge } = require('./upstream-error')

class SigninError extends Error {
    constructor(code, status, message, upstreamStatus = null) {
        super(message)
        this.code = code
        this.status = status
        this.upstreamStatus = upstreamStatus
    }

    static fromResponse(response) {
        const { status, data } = response
        const body = typeof data === 'string' ? data.slice(0, 65536) : data
        if (detectWafChallenge(body)) {
            return new SigninError('signin_verification_required', 502, 'Qwen requires sign-in verification in Qwen Chat.', status)
        }
        if (status === 405 && typeof body === 'string' && /<html\b/i.test(body) &&
            body.includes('errors.aliyun.com') && body.includes('/405.png') &&
            body.includes('Sorry, your request has been blocked')) {
            return new SigninError('signin_waf_block', 502, 'Qwen security blocked sign-in.', status)
        }
        if (status === 401) {
            return new SigninError('signin_rejected', 401, 'Qwen rejected sign-in.', status)
        }
        return new SigninError('signin_upstream_error', 502, 'Unexpected Qwen sign-in response.', status)
    }

    static fromError(error) {
        if (error instanceof SigninError) return error
        if (error.response) return SigninError.fromResponse(error.response)
        if (error.request || error.isAxiosError) {
            return new SigninError('signin_transport_error', 502, 'Could not obtain a Qwen sign-in response.')
        }
        return new SigninError('signin_local_error', 500, 'Local sign-in request failed.')
    }

    toPublicResponse() {
        return { error: this.message, code: this.code, upstreamStatus: this.upstreamStatus }
    }
}

module.exports = { SigninError }
