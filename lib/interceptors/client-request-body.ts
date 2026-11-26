import { ClientRequest } from 'node:http'

/**
 * `@mswjs/interceptors` builds a Fetch `Request` for every intercepted
 * `http.ClientRequest`. Fetch forbids a body on GET and HEAD, so the
 * interceptor drops that byte stream and `request.arrayBuffer()` is empty.
 * The bytes are still passed to `ClientRequest#write` / `#end`. Record them
 * and return them when the Fetch body is empty.
 */

const chunksByRequest = new WeakMap<ClientRequest, Buffer[]>()
const pending: ClientRequest[] = []

const patched = Symbol('nock.captureRequestBody')

let originalWrite: ClientRequest['write'] | undefined
let originalEnd: ClientRequest['end'] | undefined

function methodDisallowsFetchBody(method: string | undefined): boolean {
  const normalized = (method || 'GET').toUpperCase()
  return normalized === 'GET' || normalized === 'HEAD'
}

function toBuffer(chunk: unknown, encoding: unknown): Buffer | undefined {
  if (chunk == null || typeof chunk === 'function') return undefined
  const normalizedEncoding =
    typeof encoding === 'string' ? (encoding as BufferEncoding) : undefined
  if (typeof chunk === 'string') return Buffer.from(chunk, normalizedEncoding)
  if (Buffer.isBuffer(chunk)) return chunk
  if (chunk instanceof ArrayBuffer) return Buffer.from(chunk)
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  }
  return undefined
}

function record(
  request: ClientRequest,
  chunk: unknown,
  encoding: unknown,
): void {
  if (!methodDisallowsFetchBody(request.method)) return
  const buffer = toBuffer(chunk, encoding)
  if (!buffer || buffer.byteLength === 0) return

  let chunks = chunksByRequest.get(request)
  if (!chunks) {
    chunks = []
    chunksByRequest.set(request, chunks)
    pending.push(request)
  }
  chunks.push(buffer)
}

function clientRequestFrom(initiator: unknown): ClientRequest | undefined {
  if (initiator instanceof ClientRequest) return initiator
  // Node's socket keeps the `ClientRequest` that owns the write on
  // `_httpMessage`. The HTTP interceptor exposes that socket as `initiator`.
  const message = (initiator as { _httpMessage?: unknown } | null | undefined)
    ?._httpMessage
  if (message instanceof ClientRequest) return message
  return undefined
}

function sameTarget(clientRequest: ClientRequest, request: Request): boolean {
  if (
    (clientRequest.method || 'GET').toUpperCase() !==
    request.method.toUpperCase()
  ) {
    return false
  }

  let actual: URL
  try {
    actual = new URL(
      clientRequest.path || '/',
      `${clientRequest.protocol || 'http:'}//${clientRequest.host || 'localhost'}`,
    )
  } catch {
    return false
  }

  const expected = new URL(request.url)
  return (
    actual.origin === expected.origin &&
    actual.pathname === expected.pathname &&
    actual.search === expected.search
  )
}

function expectsBody(request: Request): boolean {
  const length = request.headers.get('content-length')
  if (length != null && Number(length) > 0) return true
  const encoding = request.headers.get('transfer-encoding')
  return encoding != null && encoding.toLowerCase().includes('chunked')
}

function waitUntilEnded(request: ClientRequest): Promise<void> {
  if (request.writableEnded || request.destroyed) return Promise.resolve()
  return new Promise(resolve => {
    const done = () => {
      request.removeListener('finish', done)
      request.removeListener('error', done)
      request.removeListener('close', done)
      resolve()
    }
    request.once('finish', done)
    request.once('error', done)
    request.once('close', done)
  })
}

function claimPending(request: Request): ClientRequest | undefined {
  const index = pending.findIndex(candidate => sameTarget(candidate, request))
  if (index === -1) return undefined
  const [match] = pending.splice(index, 1)
  return match
}

function forget(request: ClientRequest): void {
  const index = pending.indexOf(request)
  if (index !== -1) pending.splice(index, 1)
  chunksByRequest.delete(request)
}

function installClientRequestBodyCapture(): void {
  const prototype = ClientRequest.prototype as ClientRequest & {
    write: ClientRequest['write'] & { [patched]?: boolean }
    end: ClientRequest['end']
  }
  if (prototype.write[patched]) return

  originalWrite = prototype.write
  originalEnd = prototype.end

  function write(
    this: ClientRequest,
    chunk: unknown,
    encoding?: unknown,
    callback?: unknown,
  ) {
    record(this, chunk, encoding)
    return originalWrite!.call(
      this,
      chunk as never,
      encoding as never,
      callback as never,
    )
  }
  write[patched] = true

  function end(
    this: ClientRequest,
    chunk?: unknown,
    encoding?: unknown,
    callback?: unknown,
  ) {
    if (typeof chunk !== 'function') record(this, chunk, encoding)
    return originalEnd!.call(
      this,
      chunk as never,
      encoding as never,
      callback as never,
    )
  }

  prototype.write = write as ClientRequest['write']
  prototype.end = end as ClientRequest['end']
}

function uninstallClientRequestBodyCapture(): void {
  const prototype = ClientRequest.prototype as ClientRequest & {
    write: ClientRequest['write'] & { [patched]?: boolean }
  }
  if (!prototype.write[patched] || !originalWrite || !originalEnd) return
  prototype.write = originalWrite
  prototype.end = originalEnd
  originalWrite = undefined
  originalEnd = undefined
  pending.length = 0
}

function resolveClientRequest(
  request: Request,
  initiator: unknown,
): ClientRequest | undefined {
  const direct = clientRequestFrom(initiator)
  if (direct && methodDisallowsFetchBody(direct.method)) {
    const stillOpen = !direct.writableEnded && !direct.destroyed
    if (chunksByRequest.has(direct) || stillOpen) {
      const index = pending.indexOf(direct)
      if (index !== -1) pending.splice(index, 1)
      return direct
    }
  }
  return claimPending(request)
}

async function readCapturedRequestBody(
  request: Request,
  initiator: unknown,
): Promise<Buffer | undefined> {
  if (!methodDisallowsFetchBody(request.method)) return undefined

  const clientRequest = resolveClientRequest(request, initiator)
  if (!clientRequest) return undefined

  if (
    !clientRequest.writableEnded &&
    (chunksByRequest.has(clientRequest) || expectsBody(request))
  ) {
    await waitUntilEnded(clientRequest)
  }

  const chunks = chunksByRequest.get(clientRequest)
  forget(clientRequest)
  if (!chunks || chunks.length === 0) return undefined
  return Buffer.concat(chunks)
}

function discardCapturedRequestBody(
  request: Request,
  initiator: unknown,
): void {
  const direct = clientRequestFrom(initiator)
  if (direct && chunksByRequest.has(direct)) {
    forget(direct)
    return
  }
  const match = claimPending(request)
  if (match) chunksByRequest.delete(match)
}

export {
  discardCapturedRequestBody,
  installClientRequestBodyCapture,
  readCapturedRequestBody,
  uninstallClientRequestBodyCapture,
}
