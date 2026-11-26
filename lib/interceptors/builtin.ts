import * as common from '../common.ts'
import handleRequest from '../handle-request.ts'
import { setGetRequestBody } from '../utils/node/index.ts'
import { BatchInterceptor } from '@mswjs/interceptors'
import { FetchInterceptor } from '@mswjs/interceptors/fetch'
import { HttpRequestInterceptor } from '@mswjs/interceptors/http'
import {
  discardCapturedRequestBody,
  installClientRequestBodyCapture,
  readCapturedRequestBody,
  uninstallClientRequestBodyCapture,
} from './client-request-body.ts'

const interceptor = new BatchInterceptor({
  name: 'intercept',
  interceptors: [new HttpRequestInterceptor(), new FetchInterceptor()],
})

function methodDisallowsFetchBody(method: string): boolean {
  return method === 'GET' || method === 'HEAD'
}

function activate() {
  installClientRequestBodyCapture()
  interceptor.apply()

  // Force msw to forward Nock's error instead of coerce it into 500 error
  interceptor.on('unhandledException', ({ controller, error }: any) => {
    controller.errorWith(error)
  })
  interceptor.on(
    'request',
    async function ({ request, controller, initiator }) {
      if (request.headers.get('expect') === '100-continue') {
        // We currently do not support mocking 100-continue responses, so they are passed through for now.
        return
      }

      // Fetch refuses bodies on GET and HEAD, and `@mswjs/interceptors`
      // therefore reports an empty body. Recover the bytes from the
      // underlying ClientRequest when that happens.
      let rawBody: ArrayBuffer | Buffer = await request.clone().arrayBuffer()
      if (methodDisallowsFetchBody(request.method)) {
        if (rawBody.byteLength === 0) {
          const captured = await readCapturedRequestBody(request, initiator)
          if (captured && captured.byteLength > 0) rawBody = captured
        } else {
          discardCapturedRequestBody(request, initiator)
        }
      }

      const requestBodyBuffer: ArrayBuffer = common.decompressRequestBody(
        rawBody as ArrayBuffer,
        request.headers.get('content-encoding') || '',
      ) as ArrayBuffer

      const decompressedRequest = new Request(request, {
        body:
          requestBodyBuffer.byteLength > 0 &&
          !methodDisallowsFetchBody(request.method)
            ? requestBodyBuffer
            : undefined,
      })
      if (
        requestBodyBuffer.byteLength > 0 &&
        methodDisallowsFetchBody(request.method)
      ) {
        setGetRequestBody(decompressedRequest, requestBodyBuffer)
      }

      const response = await handleRequest(decompressedRequest)
      if (response) {
        controller.respondWith(response)
      }
    },
  )
}

function deactivate() {
  interceptor.dispose()
  uninstallClientRequestBodyCapture()
}

export { activate, deactivate }
