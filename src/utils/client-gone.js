const { consumeSSEStream } = require('./sse.js')
const { isTransportInterruption } = require('./upstream-error.js')

/**
 * The client of a request going away, as the server can actually see it
 * (Qwen2API-mxs).
 *
 * The signal is taken from the request and its socket, never from `res`: under
 * Bun `res` says nothing at all when its client leaves (no 'close', `destroyed`
 * undefined, `write` returning true), and a check built on `res` passes under
 * Node and is blind on prod — which is what every path here used to be.
 *
 * What each runtime reports was measured offline, with the client leaving while
 * the response idles or streams (Bun 1.3.14, Linux, the runtime of prod; Node 24,
 * the runtime of the gate), and with the request body read the way the
 * application reads every one — express.json, before any handler runs:
 *
 *  - Node: the socket emits 'end' and 'close' at once, `socket.destroyed` turns
 *    true, and `socket.address()` keeps returning an object with nothing in it.
 *  - Bun: no event, ever, and no flag; `socket.destroyed` stays false for as
 *    long as the response lasts, and `res.write` keeps returning true. Bun has
 *    closed the socket underneath all the same, and leaves one trace of it:
 *    `socket.address()` turns null and `remoteAddress` turns undefined — as a
 *    destroyed socket does under Node — a few milliseconds after the client left.
 *
 * With a request body nothing has read, Bun does emit `aborted` and `close` on
 * the request and `close` on the socket. That is the measurement of 24.11, which
 * found the signal on Bun; it does not describe the application, and a watch
 * built on those events alone closes nothing on prod.
 *
 * So two things are watched: the socket's 'close' (the one event every runtime
 * that reports a leaving reports), and — asked on every check and every quarter
 * of a second while a response is under way — whether the socket still has its
 * address.
 *
 * Two things are not signals, both measured: `close` on the request, which with
 * the body read has fired before any handler runs (it is how a request that
 * ended well is closed out), and `req.destroyed`, which is true after a normal
 * end too.
 */

const CLIENT_GONE = 'client_gone'

// How often the socket is asked whether it still has its address. Bun takes it
// off within milliseconds of the client leaving; the answer costs one call, and
// the timer never keeps the process alive.
const ADDRESS_POLL_MS = 250

/**
 * The upstream was closed because the client of the request is gone. Nothing
 * failed: it is how a read ends when there is nobody left to answer, and every
 * handler lets it out without logging it, charging an account or retrying.
 * A destroyed stream reports itself as ERR_STREAM_PREMATURE_CLOSE — the same
 * code as a transport that broke — so the closing is told apart here, where
 * it is known, and not guessed from the code downstream.
 */
class ClientGoneError extends Error {
  constructor () {
    super('The client went away: the upstream was closed for it')
    this.name = 'ClientGoneError'
    this.code = CLIENT_GONE
  }
}

const isClientGone = error => error instanceof ClientGoneError

const nothing = () => {}

/**
 * The socket's address, or null once it has none: a socket Bun closed underneath
 * the request answers null, and one Node closed answers with nothing in it.
 */
const addressOf = (socket) => {
  if (!socket || typeof socket.address !== 'function') return null
  const info = socket.address()
  return info && typeof info === 'object' && info.address !== undefined ? info : null
}

/**
 * Watch one request for its client going away.
 * @param {object} req - Express request
 * @param {{pollMs?: number}} [options] - How often to ask the socket; tests shorten it
 * @returns {{gone: () => boolean, onGone: (handler: () => void) => () => void, dispose: () => void}}
 *   `gone()` asks the socket each time, until `dispose`, and stays true once it was;
 *   `onGone` calls a handler at once when it already happened, and gives back its
 *   unsubscribe; `dispose` drops the listener and the asking — the socket outlives
 *   the request on keep-alive, and its closing later says nothing about this one.
 *   A request without a socket to ask (a bare object in the tests) is a client
 *   that stays, and the handlers read exactly as they did before.
 */
const watchClient = (req, { pollMs = ADDRESS_POLL_MS } = {}) => {
  const socket = req?.socket || null
  // A socket that can say where it is, is asked. One that cannot is not judged
  // by it; one that can and has no answer has already been closed.
  const canTell = Boolean(socket && typeof socket.address === 'function')
  const goneNow = () =>
    req?.aborted === true ||
    socket?.destroyed === true ||
    (canTell && addressOf(socket) === null)

  let gone = goneNow()
  let disposed = false
  const handlers = new Set()
  let poll = null

  const markGone = () => {
    if (gone) return
    gone = true
    clearInterval(poll)
    for (const handler of handlers) {
      try {
        handler()
      } catch (_) {
        // One handler failing must not keep the next from closing what it holds.
      }
    }
  }
  const check = () => {
    if (!disposed && goneNow()) markGone()
    return gone
  }

  if (!gone && canTell && Number.isFinite(pollMs) && pollMs > 0) {
    poll = setInterval(check, pollMs)
    poll.unref?.()
  }
  if (socket && typeof socket.on === 'function') socket.on('close', markGone)

  return {
    gone: check,
    onGone: (handler) => {
      if (typeof handler !== 'function') return nothing
      if (check()) {
        handler()
        return nothing
      }
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      clearInterval(poll)
      if (socket && typeof socket.removeListener === 'function') socket.removeListener('close', markGone)
      handlers.clear()
    }
  }
}

const closeUpstream = (stream) => {
  if (stream && typeof stream.destroy === 'function') stream.destroy()
}

/**
 * consumeSSEStream for as long as the client of the request stays.
 *
 * When the client goes away the upstream is closed at once. Waiting for the
 * next frame to stop (what `shouldStop` does) is not enough: a model thinking
 * sends nothing for a long while, and all of that time the generation goes on
 * and burns the account's quota for an answer nobody reads.
 *
 * Closing is all this does to the upstream. What the closing means belongs to
 * the stream: on the egress it ends the relay, and the worker cancels the fetch
 * inside the page when it sees the relay go.
 *
 * The read then ends in ClientGoneError. The stream this closed reports itself as
 * ERR_STREAM_PREMATURE_CLOSE, the code of a transport that broke: it must not read
 * as one. And a read that ended with the client gone is over whatever ended it —
 * a stop returns like a stop of the handler's own, and those go on to a gate that
 * may ask for another attempt.
 *
 * A failure that is not the closing stays what it was. A quota frame or a challenge is
 * thrown by the handler of the frame, and carries its account bookkeeping whoever is
 * left to read it; a fault that is neither (a relay out of shape, a bug) is not hidden
 * under the client's leaving.
 *
 * @param {AsyncIterable<Buffer|string>} stream - The upstream
 * @param {(frame: object) => Promise<void>|void} onFrame
 * @param {{client?: object, shouldStop?: () => boolean}} [options]
 *   `client` is what watchClient returns; without it this is consumeSSEStream.
 * @returns {Promise<{sawDone: boolean, eventCount: number, bytesRead: number, completed: boolean, stopped: boolean}>}
 * @throws {ClientGoneError} the upstream was closed because the client is gone
 */
const consumeWhileClientStays = async (stream, onFrame, { client = null, shouldStop = null } = {}) => {
  if (!client) return consumeSSEStream(stream, onFrame, shouldStop ? { shouldStop } : {})

  let closedForClient = false
  const unsubscribe = client.onGone(() => {
    closedForClient = true
    closeUpstream(stream)
  })
  // What a frame said the upstream decided (a quota frame, a challenge) is thrown by the
  // handler of the frame and carries the account's bookkeeping. It stays what it is.
  let saidByHandler = null
  try {
    let result
    try {
      result = await consumeSSEStream(stream, async (frame) => {
        try {
          await onFrame(frame)
        } catch (error) {
          saidByHandler = error
          throw error
        }
      }, shouldStop ? { shouldStop } : {})
    } catch (error) {
      // The stream this closed reports ERR_STREAM_PREMATURE_CLOSE, or whatever its
      // transport calls a cut: the code of a failure, and none happened. A transport
      // that broke under a client already gone is the same thing by another way.
      if (error !== saidByHandler &&
          (closedForClient || (client.gone() && isTransportInterruption(error)))) throw new ClientGoneError()
      throw error
    }
    if (client.gone()) throw new ClientGoneError()
    return result
  } finally {
    unsubscribe()
  }
}

/**
 * Throws ClientGoneError once the client has gone: what every step that is no
 * stream asks before it goes on — the token call, the upload and the parse of
 * a file (Qwen2API-4l1). A caller that brings no client reads as it did before.
 */
const assertClientStays = (client) => {
  if (client && client.gone()) throw new ClientGoneError()
}

/**
 * `sleep` for as long as the client stays: a client that goes away ends the
 * wait at once with ClientGoneError, instead of leaving the request asleep for
 * the rest of the pause (a file's parse is polled, a video task every twenty
 * seconds).
 */
const sleepWhileClientStays = (ms, client) => new Promise((resolve, reject) => {
  if (client && client.gone()) {
    reject(new ClientGoneError())
    return
  }
  let unsubscribe = null
  const timer = setTimeout(() => {
    if (unsubscribe) unsubscribe()
    resolve()
  }, ms)
  if (client) {
    unsubscribe = client.onGone(() => {
      clearTimeout(timer)
      reject(new ClientGoneError())
    })
  }
})

module.exports = {
  ClientGoneError,
  isClientGone,
  watchClient,
  consumeWhileClientStays,
  assertClientStays,
  sleepWhileClientStays
}
