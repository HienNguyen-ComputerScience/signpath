/**
 * Smoke tests for coach-proxy.
 * Run: node test.js
 *
 * Injects a mock callGemini so we don't hit the real API and don't need a
 * key in CI. If GEMINI_API_KEY is set, one extra live test runs at the end
 * to verify the real Gemini pipeline (otherwise skipped).
 */
'use strict'

const assert = require('assert')
const { createServer } = require('./server.js')

let _failures = 0, _passed = 0
async function test(name, fn) {
  try { await fn(); _passed++; console.log(`  ✓ ${name}`) }
  catch (e) { _failures++; console.error(`  ✗ ${name}\n    ${e.message}`); if (process.env.DEBUG) console.error(e.stack) }
}

function startOnRandomPort(overrides) {
  const silentLogger = () => {}
  const srv = createServer(Object.assign({
    apiKey: 'dummy-key',
    callGemini: async (prompt) => `echo: ${prompt.slice(0, 40)}`,
    allowedOrigins: ['http://test.local'],
    logger: silentLogger,
  }, overrides || {}))
  return new Promise((resolve, reject) => {
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      resolve({ srv, port, base: `http://127.0.0.1:${port}` })
    })
  })
}

async function closeServer(srv) {
  return new Promise(r => srv.close(() => r()))
}

async function run() {
  console.log('coach-proxy')

  await test('POST /coach with valid prompt returns { text }', async () => {
    const { srv, base } = await startOnRandomPort()
    try {
      const r = await fetch(`${base}/coach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Help me with Mẹ', lang: 'vi' }),
      })
      assert.strictEqual(r.status, 200)
      const body = await r.json()
      assert.ok(typeof body.text === 'string')
      assert.ok(body.text.indexOf('Help me with Mẹ') !== -1)
    } finally { await closeServer(srv) }
  })

  await test('POST /coach with missing prompt → 400', async () => {
    const { srv, base } = await startOnRandomPort()
    try {
      const r = await fetch(`${base}/coach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nope: true }),
      })
      assert.strictEqual(r.status, 400)
      const body = await r.json()
      assert.strictEqual(body.error, 'missing_prompt')
    } finally { await closeServer(srv) }
  })

  await test('POST /coach with invalid JSON → 400', async () => {
    const { srv, base } = await startOnRandomPort()
    try {
      const r = await fetch(`${base}/coach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{{{not json',
      })
      assert.strictEqual(r.status, 400)
      const body = await r.json()
      assert.strictEqual(body.error, 'invalid_json')
    } finally { await closeServer(srv) }
  })

  await test('GET /coach → 404 (only POST supported)', async () => {
    const { srv, base } = await startOnRandomPort()
    try {
      const r = await fetch(`${base}/coach`)
      assert.strictEqual(r.status, 404)
    } finally { await closeServer(srv) }
  })

  await test('POST /other-path → 404', async () => {
    const { srv, base } = await startOnRandomPort()
    try {
      const r = await fetch(`${base}/nope`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi' }),
      })
      assert.strictEqual(r.status, 404)
    } finally { await closeServer(srv) }
  })

  await test('OPTIONS /coach returns 204 with CORS headers for allowed origin', async () => {
    const { srv, base } = await startOnRandomPort()
    try {
      const r = await fetch(`${base}/coach`, {
        method: 'OPTIONS',
        headers: { Origin: 'http://test.local' },
      })
      assert.strictEqual(r.status, 204)
      assert.strictEqual(r.headers.get('access-control-allow-origin'), 'http://test.local')
      assert.ok(r.headers.get('access-control-allow-methods').indexOf('POST') !== -1)
    } finally { await closeServer(srv) }
  })

  await test('OPTIONS with disallowed origin omits Allow-Origin header', async () => {
    const { srv, base } = await startOnRandomPort()
    try {
      const r = await fetch(`${base}/coach`, {
        method: 'OPTIONS',
        headers: { Origin: 'http://evil.example' },
      })
      assert.strictEqual(r.status, 204)
      assert.strictEqual(r.headers.get('access-control-allow-origin'), null)
    } finally { await closeServer(srv) }
  })

  await test('rate limit returns 429 after threshold', async () => {
    const { srv, base } = await startOnRandomPort({ rateLimit: 3, rateWindowMs: 60_000 })
    try {
      const fire = () => fetch(`${base}/coach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'x' }),
      })
      const r1 = await fire(); assert.strictEqual(r1.status, 200)
      const r2 = await fire(); assert.strictEqual(r2.status, 200)
      const r3 = await fire(); assert.strictEqual(r3.status, 200)
      const r4 = await fire(); assert.strictEqual(r4.status, 429)
      const body = await r4.json()
      assert.strictEqual(body.error, 'rate_limited')
    } finally { await closeServer(srv) }
  })

  await test('upstream failure → 502 without leaking upstream error body', async () => {
    const { srv, base } = await startOnRandomPort({
      callGemini: async () => { throw new Error('secret-internal-error-with-api-key-abc123') },
    })
    try {
      const r = await fetch(`${base}/coach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi' }),
      })
      assert.strictEqual(r.status, 502)
      const body = await r.json()
      assert.strictEqual(body.error, 'upstream_error')
      assert.ok(JSON.stringify(body).indexOf('api-key-abc123') === -1, 'must not leak upstream error')
    } finally { await closeServer(srv) }
  })

  await test('oversized body → 413', async () => {
    const { srv, base } = await startOnRandomPort({ maxBodyBytes: 100 })
    try {
      const big = 'x'.repeat(200)
      const r = await fetch(`${base}/coach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: big }),
      })
      assert.strictEqual(r.status, 413)
    } finally { await closeServer(srv) }
  })

  await test('logger receives only metadata (no prompt body)', async () => {
    const entries = []
    const { srv, base } = await startOnRandomPort({ logger: e => entries.push(e) })
    try {
      await fetch(`${base}/coach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'SUPER_SECRET_PROMPT' }),
      })
      assert.ok(entries.length >= 1)
      for (const e of entries) {
        const serialized = JSON.stringify(e)
        assert.ok(serialized.indexOf('SUPER_SECRET_PROMPT') === -1, 'prompt must never appear in log entry')
      }
    } finally { await closeServer(srv) }
  })

  // ── Optional live test — only runs if you've configured a real key
  if (process.env.GEMINI_API_KEY && process.env.LIVE_TEST === '1') {
    await test('live: hits real Gemini and gets back non-empty text', async () => {
      const srv = createServer({})  // uses env
      await new Promise(r => srv.listen(0, '127.0.0.1', r))
      const port = srv.address().port
      try {
        const r = await fetch(`http://127.0.0.1:${port}/coach`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: 'Respond with the single word: OK', lang: 'en' }),
        })
        assert.strictEqual(r.status, 200)
        const body = await r.json()
        assert.ok(body.text && body.text.length > 0)
      } finally { await closeServer(srv) }
    })
  } else {
    console.log('  - live Gemini test skipped (set GEMINI_API_KEY and LIVE_TEST=1 to enable)')
  }

  console.log(`\n${_passed} passed, ${_failures} failed`)
  if (_failures) process.exit(1)
}

run().catch(e => { console.error('Test runner crashed:', e); process.exit(1) })
