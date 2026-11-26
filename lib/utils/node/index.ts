import { Readable as ReadableStream } from 'node:stream'

const kGetRequestBody: unique symbol = Symbol('kGetRequestBody') as any

function storedRequestBody(request: Request): Buffer | undefined {
  const body = Reflect.get(request, kGetRequestBody)
  return Buffer.isBuffer(body) ? body : undefined
}

function getGetRequestBody(request: Request) {
  if (request.method !== 'GET') {
    throw new Error('The request method must be GET')
  }
  // A GET with no body never stores one. Return an empty stream so reply
  // callbacks can read it without throwing.
  return ReadableStream.from(storedRequestBody(request) ?? [])
}

function setGetRequestBody(request: Request, body: ArrayBuffer) {
  Reflect.set(request, kGetRequestBody, Buffer.from(body))
}

function peekStoredRequestBody(request: Request): Buffer | undefined {
  return storedRequestBody(request)
}

export { getGetRequestBody, peekStoredRequestBody, setGetRequestBody }
