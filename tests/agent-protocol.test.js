const test = require('node:test')
const assert = require('node:assert/strict')
const { Readable } = require('node:stream')

process.env.API_KEY = process.env.API_KEY || 'test-only-key'

const { createUpstreamDeltaNormalizer, formatHistoryMessages } = require('../src/utils/chat-helpers.js')
const {
  normalizeOpenAIFinishReason,
  handleStreamResponse,
  handleNonStreamResponse
} = require('../src/controllers/chat.js')
const {
  mapAnthropicStopReason,
  handleAnthropicStream,
  handleAnthropicNonStream
} = require('../src/controllers/anthropic.js')
const { externalizeOversizedAgentContext } = require('../src/utils/request.js')
const { assertNoUpstreamFailure } = require('../src/utils/upstream-error.js')

test.after(() => {
  require('../src/utils/account.js').destroy()
})

const createMockResponse = () => ({
  output: '',
  headers: {},
  headersSent: false,
  writableEnded: false,
  statusCode: 200,
  set(headers) {
    Object.assign(this.headers, headers)
    return this
  },
  setHeader(name, value) {
    this.headers[name] = value
  },
  write(chunk) {
    this.headersSent = true
    this.output += String(chunk)
    return true
  },
  end(chunk = '') {
    if (chunk) this.write(chunk)
    this.writableEnded = true
  },
  status(code) {
    this.statusCode = code
    return this
  },
  json(value) {
    this.headersSent = true
    this.output += JSON.stringify(value)
    this.writableEnded = true
    return this
  }
})

test('phase-less answer content is not silently discarded', () => {
  const normalize = createUpstreamDeltaNormalizer()
  assert.deepEqual(normalize({ content: 'final answer' }), {
    phase: 'answer',
    content: 'final answer'
  })
  assert.deepEqual(normalize({ reasoning_content: 'thinking' }), {
    phase: 'think',
    content: 'thinking'
  })
})

test('finish reasons preserve truncation instead of reporting normal completion', () => {
  assert.equal(normalizeOpenAIFinishReason('length', false, true), 'length')
  assert.equal(normalizeOpenAIFinishReason(null, false, false), null)
  assert.equal(mapAnthropicStopReason('length', false, true), 'max_tokens')
  assert.equal(mapAnthropicStopReason(null, false, false), null)
  assert.equal(mapAnthropicStopReason('stop', true, true), 'tool_use')
})

test('history envelope preserves role and punctuation with JSONL', () => {
  const history = formatHistoryMessages([
    { role: 'system', content: 'keep: semicolons; intact' },
    { role: 'assistant', content: 'done; not really' }
  ])
  const lines = history.split('\n').map(line => JSON.parse(line))
  assert.deepEqual(lines, [
    { role: 'system', content: 'keep: semicolons; intact' },
    { role: 'assistant', content: 'done; not really' }
  ])
})

test('controller modules can consume fragmented terminal frames', async () => {
  const chunks = [
    Buffer.from('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"len'),
    Buffer.from('gth"}]}\r\n\r\ndata: [DO'),
    Buffer.from('NE]\r\n\r\n')
  ]
  const { consumeUpstream } = require('../src/controllers/anthropic.js')
  const seen = []
  const result = await consumeUpstream(Readable.from(chunks), json => seen.push(json))
  assert.equal(seen.length, 1)
  assert.equal(seen[0].choices[0].finish_reason, 'length')
  assert.equal(result.sawDone, true)
})

test('OpenAI stream preserves length, accepts clean EOF and rejects transport aborts', async () => {
  const completedRes = createMockResponse()
  await handleStreamResponse(
    completedRes,
    Readable.from([
      'data: {"choices":[{"delta":{"content":"partial answer"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n'
    ]),
    false,
    false,
    { messages: [] },
    {}
  )
  assert.match(completedRes.output, /"finish_reason":"length"/)
  assert.doesNotMatch(completedRes.output, /"finish_reason":"stop"/)

  const cleanEofRes = createMockResponse()
  await handleStreamResponse(
    cleanEofRes,
    Readable.from(['data: {"choices":[{"delta":{"content":"normal eof"},"finish_reason":null}]}\n\n']),
    false,
    false,
    { messages: [] },
    {}
  )
  assert.match(cleanEofRes.output, /"finish_reason":"stop"/)
  assert.doesNotMatch(cleanEofRes.output, /upstream_incomplete/)

  async function * brokenStream() {
    yield 'data: {"choices":[{"delta":{"content":"cut"},"finish_reason":null}]}\n\n'
    const error = new Error('socket reset')
    error.code = 'ECONNRESET'
    throw error
  }
  const abortedRes = createMockResponse()
  await handleStreamResponse(
    abortedRes,
    Readable.from(brokenStream()),
    false,
    false,
    { messages: [] },
    {}
  )
  assert.match(abortedRes.output, /"code":"upstream_stream_error"/)
  assert.doesNotMatch(abortedRes.output, /"finish_reason":"stop"/)
})

test('thinking-only Agent turns retry once and recover visible output', async () => {
  let openAIRetries = 0
  const openAIRes = createMockResponse()
  await handleStreamResponse(
    openAIRes,
    Readable.from(['data: {"choices":[{"delta":{"phase":"think","content":"planning"},"finish_reason":null}]}\n\n']),
    true,
    false,
    { messages: [{ role: 'user', content: 'finish the task' }] },
    {
      sendChatRequest: async () => {
        openAIRetries += 1
        return {
          status: true,
          response: Readable.from(['data: {"choices":[{"delta":{"phase":"answer","content":"recovered"},"finish_reason":null}]}\n\n'])
        }
      }
    }
  )
  assert.equal(openAIRetries, 1)
  assert.match(openAIRes.output, /recovered/)
  assert.match(openAIRes.output, /"finish_reason":"stop"/)

  let anthropicRetries = 0
  const anthropicRes = createMockResponse()
  await handleAnthropicStream(
    anthropicRes,
    {
      message_id: 'msg_retry',
      model: 'qwen-test',
      hasTools: false,
      requestBody: { messages: [{ role: 'user', content: 'finish the task' }] },
      sendRequest: async () => {
        anthropicRetries += 1
        return {
          status: true,
          response: Readable.from(['data: {"choices":[{"delta":{"phase":"answer","content":"recovered"},"finish_reason":null}]}\n\n'])
        }
      }
    },
    Readable.from(['data: {"choices":[{"delta":{"phase":"think","content":"planning"},"finish_reason":null}]}\n\n'])
  )
  assert.equal(anthropicRetries, 1)
  assert.match(anthropicRes.output, /recovered/)
  assert.match(anthropicRes.output, /event: message_stop/)
})

test('prose-only Agent actions are retried into executable tool calls', async () => {
  let openAIRetries = 0
  const openAIRes = createMockResponse()
  await handleStreamResponse(
    openAIRes,
    Readable.from(['data: {"choices":[{"delta":{"phase":"answer","content":"I will inspect the repository now."},"finish_reason":null}]}\n\n']),
    false,
    false,
    { messages: [{ role: 'user', content: 'fix the project' }] },
    {
      has_tools: true,
      tool_choice: 'auto',
      allowed_tool_names: ['read_file'],
      sendChatRequest: async () => {
        openAIRetries += 1
        return {
          status: true,
          response: Readable.from([
            'data: {"choices":[{"delta":{"phase":"answer","content":"<tool_call>{\\"name\\":\\"read_file\\",\\"arguments\\":{\\"path\\":\\"README.md\\"}}</tool_call>"},"finish_reason":null}]}\n\n'
          ])
        }
      }
    }
  )
  assert.equal(openAIRetries, 1)
  assert.match(openAIRes.output, /"name":"read_file"/)
  assert.match(openAIRes.output, /"finish_reason":"tool_calls"/)

  let anthropicRetries = 0
  const anthropicRes = createMockResponse()
  await handleAnthropicStream(
    anthropicRes,
    {
      message_id: 'msg_action_retry',
      model: 'qwen-test',
      hasTools: true,
      toolChoice: 'auto',
      allowedToolNames: ['read_file'],
      requestBody: { messages: [{ role: 'user', content: 'fix the project' }] },
      sendRequest: async () => {
        anthropicRetries += 1
        return {
          status: true,
          response: Readable.from([
            'data: {"choices":[{"delta":{"phase":"answer","content":"<tool_call>{\\"name\\":\\"read_file\\",\\"arguments\\":{\\"path\\":\\"README.md\\"}}</tool_call>"},"finish_reason":null}]}\n\n'
          ])
        }
      }
    },
    Readable.from(['data: {"choices":[{"delta":{"phase":"answer","content":"我将读取项目文件。"},"finish_reason":null}]}\n\n'])
  )
  assert.equal(anthropicRetries, 1)
  assert.match(anthropicRes.output, /"type":"tool_use"/)
  assert.match(anthropicRes.output, /"stop_reason":"tool_use"/)
})

test('clean-EOF tool turns keep Agent loops alive for OpenAI and Anthropic clients', async () => {
  const toolFrame = 'data: {"choices":[{"delta":{"phase":"answer","content":"<tool_call>{\\"name\\":\\"read_file\\",\\"arguments\\":{\\"path\\":\\"README.md\\"}}</tool_call>"},"finish_reason":null}]}\n\n'

  const openAIRes = createMockResponse()
  await handleStreamResponse(
    openAIRes,
    Readable.from([toolFrame]),
    false,
    false,
    { messages: [] },
    { has_tools: true, tool_choice: 'auto', allowed_tool_names: ['read_file'] }
  )
  assert.match(openAIRes.output, /"name":"read_file"/)
  assert.match(openAIRes.output, /"finish_reason":"tool_calls"/)
  assert.doesNotMatch(openAIRes.output, /"error"/)

  const anthropicRes = createMockResponse()
  await handleAnthropicStream(
    anthropicRes,
    {
      message_id: 'msg_tool_loop',
      model: 'qwen-test',
      hasTools: true,
      toolChoice: 'auto',
      allowedToolNames: ['read_file'],
      requestBody: { messages: [] }
    },
    Readable.from([toolFrame])
  )
  assert.match(anthropicRes.output, /"type":"tool_use"/)
  assert.match(anthropicRes.output, /"stop_reason":"tool_use"/)
  assert.match(anthropicRes.output, /event: message_stop/)
})

test('oversized Agent history is externalized while current turn stays live', async () => {
  const original = [
    '# Tools',
    'strict tool protocol',
    '# Conversation history (JSONL)',
    JSON.stringify({ role: 'tool', content: 'x'.repeat(12000) }),
    '# Current message',
    JSON.stringify({ role: 'user', content: 'continue fixing the project' })
  ].join('\n')
  let uploaded = ''
  const result = await externalizeOversizedAgentContext(
    { messages: [{ role: 'user', content: original, files: [] }], model: 'qwen-test' },
    'token',
    { email: 'test@example.com' },
    {
      thresholdBytes: 1024,
      livePromptBytes: 4096,
      uploader: async text => {
        uploaded = text
        return { id: 'file_context', type: 'file', name: 'QWEN2API_AGENT_CONTEXT.txt' }
      }
    }
  )

  assert.equal(result.externalized, true)
  assert.equal(uploaded, original)
  assert.equal(result.payload.messages[0].files[0].id, 'file_context')
  assert.match(result.payload.messages[0].content, /continue fixing the project/)
  assert.match(result.payload.messages[0].content, /Agent context attachment/)
  assert.ok(Buffer.byteLength(result.payload.messages[0].content) < Buffer.byteLength(original))
})

test('oversized multimodal Agent context is externalized and upload failure keeps tool schemas', async () => {
  const original = [
    '# Tools',
    'strict tool protocol with read_file(path: string)',
    '# Conversation history (JSONL)',
    JSON.stringify({ role: 'tool', content: 'x'.repeat(12000) }),
    '# Current message',
    JSON.stringify({ role: 'user', content: 'continue the unfinished task' })
  ].join('\n')
  const media = { type: 'image_url', image_url: { url: 'https://example.test/screenshot.png' } }
  const externalized = await externalizeOversizedAgentContext(
    { messages: [{ role: 'user', content: [{ type: 'text', text: original }, media] }] },
    'token',
    {},
    {
      thresholdBytes: 1024,
      livePromptBytes: 4096,
      uploader: async () => ({ id: 'file_context', name: 'QWEN2API_AGENT_CONTEXT_123.txt' })
    }
  )
  assert.equal(externalized.externalized, true)
  assert.match(externalized.payload.messages[0].content[0].text, /QWEN2API_AGENT_CONTEXT_123\.txt/)
  assert.deepEqual(externalized.payload.messages[0].content[1], media)

  const compacted = await externalizeOversizedAgentContext(
    { messages: [{ role: 'user', content: original }] },
    'token',
    {},
    {
      thresholdBytes: 1024,
      livePromptBytes: 4096,
      uploader: async () => { throw new Error('parse failed') }
    }
  )
  assert.equal(compacted.compacted, true)
  assert.match(compacted.payload.messages[0].content, /strict tool protocol with read_file/)
  assert.match(compacted.payload.messages[0].content, /continue the unfinished task/)
  assert.ok(Buffer.byteLength(compacted.payload.messages[0].content) <= 4096)
})

test('Qwen HTTP-200 WAF payload is surfaced as an explicit failure', () => {
  assert.throws(
    () => assertNoUpstreamFailure({
      ret: ['FAIL_SYS_USER_VALIDATE', 'RGV587_ERROR'],
      data: { url: 'https://chat.qwen.ai/punish?action=captcha' }
    }),
    error => error.code === 'upstream_waf_challenge'
  )
})

test('Qwen HTTP-200 bare JSON WAF response reaches OpenAI clients explicitly', async () => {
  const res = createMockResponse()
  await handleStreamResponse(
    res,
    Readable.from([JSON.stringify({
      ret: ['FAIL_SYS_USER_VALIDATE', 'RGV587_ERROR'],
      data: { url: 'https://chat.qwen.ai/punish?action=captcha' }
    })]),
    false,
    false,
    { messages: [] },
    {}
  )
  assert.equal(res.statusCode, 502)
  assert.match(res.output, /upstream_waf_challenge/)
  assert.match(res.output, /WAF\\u002fcaptcha|WAF\/captcha/)
})

test('Anthropic stream emits thinking signature, max_tokens and tool parse errors', async () => {
  const thinkingRes = createMockResponse()
  await handleAnthropicStream(
    thinkingRes,
    {
      message_id: 'msg_test',
      model: 'qwen-test',
      hasTools: false,
      requestBody: { messages: [] }
    },
    Readable.from([
      'data: {"choices":[{"delta":{"phase":"think","content":"reason"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n'
    ])
  )
  assert.match(thinkingRes.output, /"type":"signature_delta"/)
  assert.match(thinkingRes.output, /"stop_reason":"max_tokens"/)
  assert.match(thinkingRes.output, /event: message_stop/)

  const invalidToolRes = createMockResponse()
  await handleAnthropicStream(
    invalidToolRes,
    {
      message_id: 'msg_tool',
      model: 'qwen-test',
      hasTools: true,
      toolChoice: 'auto',
      allowedToolNames: ['read_file'],
      requestBody: { messages: [] }
    },
    Readable.from([
      'data: {"choices":[{"delta":{"phase":"answer","content":"<tool_call>{\\"name\\":\\"read_file\\",\\"arguments\\":{\\"path\\":\\""},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
    ])
  )
  assert.match(invalidToolRes.output, /event: error/)
  assert.match(invalidToolRes.output, /invalid_tool_call_error/)
  assert.doesNotMatch(invalidToolRes.output, /event: message_stop/)
})

test('non-stream responses preserve truncation for both protocols', async () => {
  const frames = [
    'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n'
  ]

  const openAIRes = createMockResponse()
  await handleNonStreamResponse(
    openAIRes,
    Readable.from(frames),
    false,
    false,
    'qwen-test',
    { messages: [] },
    {}
  )
  assert.match(openAIRes.output, /"finish_reason":"length"/)

  const anthropicRes = createMockResponse()
  await handleAnthropicNonStream(
    anthropicRes,
    {
      message_id: 'msg_nonstream',
      model: 'qwen-test',
      hasTools: false,
      requestBody: { messages: [] }
    },
    Readable.from(frames)
  )
  assert.match(anthropicRes.output, /"stop_reason":"max_tokens"/)
})

test('interleaved multi-response frames are not merged into a duplicated answer', async () => {
  // 上游偶尔对同一次请求开启多路候选回答：先下发两个 response.created
  // （response_index "0"/"1"，各自 response_id 不同），随后两路增量帧交错到达。
  // 不按 response_id 区分就会把两路内容拼在一起，回答被复读（问题 #149）。
  // 下列帧取自 chat.qwen.ai 实际抓包。
  const dualResponseFrames = [
    'data: {"response.created":{"chat_id":"d8e2ce75","parent_id":"4cc3a56d","response_id":"4f79335b","response_index":"0"}}\n\n',
    'data: {"response.created":{"chat_id":"d8e2ce75","parent_id":"4cc3a56d","response_id":"4c2b7c86","response_index":"1"}}\n\n',
    'data: {"choices":[{"delta":{"role":"assistant","content":"巴","phase":"answer","status":"typing"}}],"response_id":"4c2b7c86"}\n\n',
    'data: {"choices":[{"delta":{"role":"assistant","content":"巴","phase":"answer","status":"typing"}}],"response_id":"4f79335b"}\n\n',
    'data: {"choices":[{"delta":{"role":"assistant","content":"黎","phase":"answer","status":"typing"}}],"response_id":"4c2b7c86"}\n\n',
    'data: {"choices":[{"delta":{"content":"","role":"assistant","status":"finished","phase":"answer"}}],"response_id":"4c2b7c86"}\n\n',
    'data: {"choices":[{"delta":{"role":"assistant","content":"黎","phase":"answer","status":"typing"}}],"response_id":"4f79335b"}\n\n',
    'data: {"choices":[{"delta":{"content":"","role":"assistant","status":"finished","phase":"answer"}}],"response_id":"4f79335b"}\n\n',
    'data: [DONE]\n\n'
  ]

  const readAnswer = (output) => output
    .split('\n\n')
    .map(frame => frame.replace(/^data: /, '').trim())
    .filter(frame => frame && frame !== '[DONE]')
    .map(frame => JSON.parse(frame))
    .map(json => json.choices?.[0]?.delta?.content || '')
    .join('')

  const streamRes = createMockResponse()
  await handleStreamResponse(streamRes, Readable.from(dualResponseFrames), false, false, { messages: [] }, {})
  assert.equal(readAnswer(streamRes.output), '巴黎')

  const nonStreamRes = createMockResponse()
  await handleNonStreamResponse(nonStreamRes, Readable.from(dualResponseFrames), false, false, { messages: [] }, {})
  assert.equal(JSON.parse(nonStreamRes.output).choices[0].message.content, '巴黎')
})
