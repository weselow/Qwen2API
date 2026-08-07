class UpstreamResponseError extends Error {
  constructor(message, code = 'upstream_error', details = null) {
    super(message);
    this.name = 'UpstreamResponseError';
    this.code = code;
    this.publicMessage = message;
    this.details = details;
  }
}

/**
 * Qwen Web 有时以 HTTP 200 + 普通 JSON 返回 WAF/captcha 或业务失败。
 * 这些帧没有 choices，若直接跳过就会被误包装成空成功或正常 stop。
 */
const assertNoUpstreamFailure = (payload) => {
  if (!payload || typeof payload !== 'object') return;

  const ret = Array.isArray(payload.ret)
    ? payload.ret.map(String)
    : (payload.ret ? [String(payload.ret)] : []);
  const upstreamSignals = [
    ...ret,
    payload.code,
    payload.data?.code,
    payload.data?.url,
    payload.error?.code
  ].filter(Boolean).map(String);
  if (upstreamSignals.some(item => /FAIL_SYS_USER_VALIDATE|RGV587|captcha|\/punish\?/i.test(item))) {
    throw new UpstreamResponseError(
      'Qwen 网页上游触发 WAF/captcha；Agent 上下文可能过大或账号需要验证',
      'upstream_waf_challenge',
      { ret }
    );
  }

  const explicitError = payload.error;
  if (explicitError && !Array.isArray(payload.choices)) {
    const message = typeof explicitError === 'string'
      ? explicitError
      : (explicitError.message || explicitError.msg || 'Qwen 上游返回业务错误');
    throw new UpstreamResponseError(message, explicitError.code || 'upstream_business_error');
  }

  if (payload.success === false && !Array.isArray(payload.choices)) {
    const message = payload.data?.details || payload.data?.message || payload.message || 'Qwen 上游返回业务错误';
    throw new UpstreamResponseError(
      message,
      payload.data?.code || payload.code || 'upstream_business_error'
    );
  }
};

module.exports = {
  UpstreamResponseError,
  assertNoUpstreamFailure
};
