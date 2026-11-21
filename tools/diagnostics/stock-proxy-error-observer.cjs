'use strict';
// Suppress console output; retain only allowlisted model-failure categories.
const fs = require('node:fs');
for (const method of ['log', 'error', 'warn', 'info', 'debug']) {
  console[method] = (...args) => {
    const text = args.filter(v => typeof v === 'string').join(' ');
    if (!text.includes('获取模型列表失败')) return;
    const http = text.match(/status code\s+(\d{3})/i);
    const proxy = text.match(/Proxy response\s*\((\d{3})\)/i);
    const result = {
      model_failure_observed: true,
      http_status: http ? Number(http[1]) : null,
      proxy_response_status: proxy ? Number(proxy[1]) : null,
      proxy_authentication_error: /407|proxy authentication/i.test(text),
      headers_timeout: /headers.*timeout|UND_ERR_HEADERS_TIMEOUT/i.test(text),
      body_timeout: /body.*timeout|UND_ERR_BODY_TIMEOUT/i.test(text),
      socket_closed: /other side closed|socket.*closed|ECONNRESET|UND_ERR_SOCKET/i.test(text),
      invalid_header: /invalid.*header|header.*invalid/i.test(text),
      invalid_url: /invalid.*url|invalid.*uri/i.test(text),
      unsupported_protocol: /unsupported.*protocol/i.test(text),
      not_a_function: /not a function/i.test(text)
    };
    try { fs.appendFileSync('/app/data/stock-model-failure-safe.jsonl', JSON.stringify(result) + '\n', { mode: 0o600 }); } catch {}
  };
}
