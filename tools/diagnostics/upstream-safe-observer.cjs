'use strict';
// Diagnostic preload for the exact stock executable. No headers or raw bodies are logged.
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
const OUT = '/app/data/upstream-safe.jsonl';
const CAP = 512 * 1024;
const ALLOWED = new Set(['/api/models', '/api/v2/chats/new', '/api/v2/chat/completions', '/api/v1/auths/']);
let authProbeStarted = false;
function emit(value) {
  try { fs.appendFileSync(OUT, JSON.stringify({ utc: new Date().toISOString(), ...value }) + '\n', { mode: 0o600 }); }
  catch { /* Never fall back to printing application data. */ }
}
function decode(body, encoding) {
  const opts = { maxOutputLength: 2 * CAP };
  if (encoding === 'gzip') return zlib.gunzipSync(body, opts);
  if (encoding === 'deflate') return zlib.inflateSync(body, opts);
  if (encoding === 'br') return zlib.brotliDecompressSync(body, opts);
  if (encoding === 'zstd' && typeof zlib.zstdDecompressSync === 'function') return zlib.zstdDecompressSync(body, opts);
  if (encoding && encoding !== 'identity') throw new Error('unsupported encoding');
  return body;
}
function observeResponse(res, meta, done) {
  let count = 0, chunks = [];
  const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
  const contentType = String(res.headers['content-type'] || '').split(';')[0].toLowerCase();
  const knownType = ['application/json', 'text/html', 'text/event-stream', 'text/plain'].includes(contentType) ? contentType : 'other';
  res.on('data', chunk => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (count < CAP) chunks.push(buf.subarray(0, CAP - count));
    count += buf.length;
  });
  res.on('end', () => {
    const result = { ...meta, http: res.statusCode, content_type: knownType, received_bytes: count, truncated: count > CAP };
    try {
      const text = decode(Buffer.concat(chunks), encoding).toString('utf8');
      result.html_body = /^\s*(?:<!doctype\s+html|<html\b)/i.test(text);
      result.waf_aliyun_meta = /aliyun_waf_/i.test(text);
      result.waf_captcha_marker = /aliyunCaptcha|_waf_is_mobile|id=["']captcha-element|<title>Verification<\/title>/i.test(text);
      result.waf_json_signal = /FAIL_SYS_USER_VALIDATE|RGV587|upstream_waf_challenge/.test(text);
      let body;
      try { body = JSON.parse(text); result.json_body = true; } catch { result.json_body = false; }
      if (body && typeof body === 'object') {
        const detail = typeof body.detail === 'string' ? body.detail : '';
        const safeFields = [];
        const codes = [];
        function collect(obj, depth = 0) {
          if (!obj || typeof obj !== 'object' || depth > 4) return;
          for (const [key, value] of Object.entries(obj)) {
            if (['code', 'error_code', 'message', 'msg', 'detail', 'status'].includes(key) && typeof value === 'string') safeFields.push(value);
            if (['code', 'error_code'].includes(key) && typeof value === 'string') {
              const known = ['Unauthorized', 'unauthorized', 'InvalidToken', 'INVALID_TOKEN', 'TokenExpired', 'InvalidJWT', 'Bad_Request', 'BadRequest', 'RateLimited', 'InvalidRequest', 'InvalidAccessToken', '401', '403'];
              if (known.includes(value)) codes.push(value);
            }
            if (typeof value === 'object') collect(value, depth + 1);
          }
        }
        collect(body);
        result.known_error_codes = codes;
        result.success_false = body.success === false;
        result.data_success_false = body.data?.success === false;
        const authText = safeFields.join(' ');
        result.auth_unauthorized = /unauthorized|not authenticated|authentication required/i.test(authText);
        result.auth_invalid_jwt = /invalid.*(?:token|jwt)|(?:token|jwt).*(?:invalid|expired)|signature verification failed/i.test(authText);
        result.auth_invalid_or_expired = /invalid or expired token|invalid token|token.*(?:expired|invalid)|not authenticated|unauthorized/i.test(authText);
        result.auth_exact_invalid_or_expired_token = detail === 'Invalid or expired token';
        result.session_id_present = typeof body.data?.id === 'string' && body.data.id.length > 0;
        if (meta.kind === 'identity_probe') {
          result.user_identity_present = typeof body.id === 'string' && !!body.id;
          result.user_identity_matches_session = typeof body.id === 'string' && body.id === sessionId();
        }
      }
    } catch { result.body_classification_failed = true; }
    chunks = [];
    emit(result);
    if (done) done();
  });
}
function authFacts(headers) {
  try {
    const a = JSON.parse(fs.readFileSync('/app/data/data.json', 'utf8')).accounts[0];
    const h = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
    return { bearer_present: typeof h.authorization === 'string', bearer_matches_session: h.authorization === 'Bearer ' + a.token, cookie_matches_session: typeof h.cookie === 'string' && h.cookie.split(';').some(v => v.trim() === 'token=' + a.token) };
  } catch { return { request_auth_check_failed: true }; }
}
function sessionId() {
  try {
    const a = JSON.parse(fs.readFileSync('/app/data/data.json', 'utf8')).accounts[0];
    return JSON.parse(Buffer.from(a.token.split('.')[1], 'base64url').toString()).id;
  } catch { return null; }
}
const originalHttpsRequest = https.request;
function identityProbe(headers) {
  if (authProbeStarted) return;
  authProbeStarted = true;
  // Reuse the in-memory stock request profile. Never persist the headers.
  const clean = { ...headers, accept: 'application/json' };
  delete clean['content-length']; delete clean['transfer-encoding'];
  const request = originalHttpsRequest.call(https, {
    protocol: 'https:', hostname: 'chat.qwen.ai', port: 443,
    path: '/api/v1/auths/', method: 'GET', headers: clean,
    timeout: 10000
  }, res => {
    observeResponse(res, { kind: 'identity_probe', path: '/api/v1/auths/', ...authFacts(clean) });
    res.resume();
  });
  request.on('timeout', () => request.destroy());
  request.on('error', () => emit({ kind: 'identity_probe', transport_error: true }));
  request.end();
}
for (const mod of [http, https]) {
  const original = mod.request;
  mod.request = function (...args) {
    const req = original.apply(this, args);
    const host = String(req.getHeader('host') || '').toLowerCase();
    const path = String(req.path || '').split('?')[0];
    if ((host === 'chat.qwen.ai' || host === 'chat.qwen.ai:443') && ALLOWED.has(path)) {
      const stockHeaders = path === '/api/v2/chats/new' ? { ...req.getHeaders() } : null;
      req.prependListener('response', res => observeResponse(res, { kind: 'stock_upstream', path, ...authFacts(req.getHeaders()) },
        stockHeaders ? () => setImmediate(() => identityProbe(stockHeaders)) : null));
      req.on('error', error => {
        const allowed = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ERR_TLS_CERT_ALTNAME_INVALID'];
        emit({ kind: 'stock_upstream', path, transport_error: allowed.includes(error.code) ? error.code : 'other' });
      });
    }
    return req;
  };
}
emit({ observer_loaded: true, request_wrapper: 'node:http+node:https', raw_capture: false });
