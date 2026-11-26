// https://github.com/nock/nock/issues/3047
import http from 'node:http'
import zlib from 'node:zlib'
import { expect } from 'chai'
import { text } from 'node:stream/consumers'
import nock from '../index.ts'
import { getGetRequestBody } from '../lib/utils/node/index.ts'

const payload = { ids: ['one'] }
const data = JSON.stringify(payload)

function send(method, body) {
  return new Promise((resolve, reject) => {
    const headers = {}
    if (body != null) {
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = Buffer.byteLength(body)
    }

    const req = http.request(
      'http://example.test/fixtures',
      { method, headers },
      res => {
        let responseBody = ''
        res.setEncoding('utf8')
        res.on('data', chunk => {
          responseBody += chunk
        })
        res.on('end', () =>
          resolve({ status: res.statusCode, body: responseBody }),
        )
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    if (body == null) req.end()
    else req.end(body)
  })
}

describe('native HTTP GET request body', () => {
  it('gives the JSON body to matchers and reply callbacks', async () => {
    let matcherBody
    const scope = nock('http://example.test')
      .get('/fixtures', body => {
        matcherBody = body
        return true
      })
      .reply(200, request => text(getGetRequestBody(request)))

    const result = await send('GET', data)

    expect(result).to.deep.equal({ status: 200, body: data })
    expect(matcherBody).to.deep.equal(payload)
    scope.done()
  })

  it('still matches a native POST body', async () => {
    let matcherBody
    const scope = nock('http://example.test')
      .post('/fixtures', body => {
        matcherBody = body
        return true
      })
      .reply(200, 'matched')

    const result = await send('POST', data)

    expect(result).to.deep.equal({ status: 200, body: 'matched' })
    expect(matcherBody).to.deep.equal(payload)
    scope.done()
  })

  it('matches a body-specific GET and consumes the mock', async () => {
    const scope = nock('http://example.test')
      .get('/fixtures', payload)
      .reply(200, 'matched fixture')

    const result = await send('GET', data)

    expect(result).to.deep.equal({ status: 200, body: 'matched fixture' })
    expect(scope.pendingMocks()).to.deep.equal([])
    scope.done()
  })

  it('does not throw for a GET without a body', async () => {
    let matcherBody = 'unset'
    const scope = nock('http://example.test')
      .get('/fixtures', body => {
        matcherBody = body
        return true
      })
      .reply(200, request => text(getGetRequestBody(request)))

    const result = await send('GET')

    expect(result).to.deep.equal({ status: 200, body: '' })
    expect(matcherBody).to.equal('')
    scope.done()
  })

  it('matches a GET body written across multiple chunks', async () => {
    let matcherBody
    const scope = nock('http://example.test')
      .get('/fixtures', body => {
        matcherBody = body
        return true
      })
      .reply(200, 'ok')

    const status = await new Promise((resolve, reject) => {
      const req = http.request(
        'http://example.test/fixtures',
        {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
          },
        },
        res => {
          res.resume()
          res.on('end', () => resolve(res.statusCode))
        },
      )
      req.on('error', reject)
      req.write(data.slice(0, 7))
      setImmediate(() => {
        req.end(data.slice(7))
      })
    })

    expect(status).to.equal(200)
    expect(matcherBody).to.deep.equal(payload)
    scope.done()
  })

  it('matches concurrent GET requests with different bodies', async () => {
    const scope = nock('http://example.test')
      .get('/fixtures', { ids: ['a'] })
      .reply(200, 'A')
      .get('/fixtures', { ids: ['b'] })
      .reply(200, 'B')

    function sendId(id) {
      return send('GET', JSON.stringify({ ids: [id] }))
    }

    const [first, second] = await Promise.all([sendId('a'), sendId('b')])

    expect(first).to.deep.equal({ status: 200, body: 'A' })
    expect(second).to.deep.equal({ status: 200, body: 'B' })
    scope.done()
  })

  it('decodes a gzip-encoded GET body before matching', async () => {
    const scope = nock('http://example.test')
      .get('/fixtures', payload)
      .reply(200)

    const compressed = zlib.gzipSync(data)
    const result = await new Promise((resolve, reject) => {
      const req = http.request(
        'http://example.test/fixtures',
        {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'Content-Encoding': 'gzip',
            'Content-Length': compressed.length,
          },
        },
        res => {
          let responseBody = ''
          res.setEncoding('utf8')
          res.on('data', chunk => {
            responseBody += chunk
          })
          res.on('end', () =>
            resolve({ status: res.statusCode, body: responseBody }),
          )
        },
      )
      req.on('error', reject)
      req.end(compressed)
    })

    expect(result.status).to.equal(200)
    scope.done()
  })
})
