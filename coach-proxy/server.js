/**
 * SignPath Coach Proxy — small server that wraps Gemini so the API key
 * never ships to the browser.
 *
 * Contract:
 *   POST /coach  { prompt: string, lang?: 'vi'|'en' }  →  { text: string }
 *   OPTIONS /coach                                    →  204 with CORS headers
 *   any other path                                     →  404 JSON
 *
 * Env vars (required unless noted):
 *   GEMINI_API_KEY    Google AI Studio key
 *   GEMINI_MODEL      default: gemini-2.5-flash
 *   PORT              default: 8787
 *   ALLOWED_ORIGINS   comma-separated CORS allowlist.
 *                     default: http://localhost:8000
 *
 * Design choices:
 *   - Node built-in http module only; no express/cors/dotenv. Keeps deploys
 *     trivial (copy server.js + set env vars, done).
 *   - In-memory per-IP rate limit, 30 req/min. No Redis / persistence —
 *     if you need that, you already outgrew this file.
 *   - Upstream Gemini errors are never returned verbatim; clients get a
 *     generic 502. Logs keep timestamp + IP + status + latency ONLY. The
 *     prompt itself is never logged (privacy-by-default).
 *   - When imported as a module (require.main !== module), createServer()
 *     is exported instead of auto-starting — lets tests inject a mock
 *     Gemini caller and pick their own port.
 */
'use strict'

const http = require('http')

const defaults = {
  port: Number(process.env.PORT) || 8787,
  apiKey: process.env.GEMINI_API_KEY,
  model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  allowedOrigins: (process.env.ALLOWED_ORIGINS || 'http://localhost:8000')
    .split(',').map(s => s.trim()).filter(Boolean),
  rateLimit: 30,
  rateWindowMs: 60_000,
  maxBodyBytes: 10_000,
}

// ─── Real Gemini call (stubbed out in tests via cfg.callGemini) ──────

async function defaultCallGemini(prompt, cfg) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${cfg.model}:generateContent`
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': cfg.apiKey,
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 200 },
    }),
  })
  if (!resp.ok) {
    // Don't forward the upstream error body — it can include API key echoes
    // or other details we don't want in client-facing responses.
    throw new Error(`gemini-upstream-${resp.status}`)
  }
  const data = await resp.json()
  const text = data && data.candidates && data.candidates[0]
    && data.candidates[0].content && data.candidates[0].content.parts
    && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text
  if (!text) throw new Error('gemini-empty-response')
  return text
}

// ─── Factory ─────────────────────────────────────────────────────────

function createServer(config) {
  const cfg = Object.assign({}, defaults, config || {})
  const callGemini = cfg.callGemini || (p => defaultCallGemini(p, cfg))
  const logger = cfg.logger || defaultLogger

  // Per-IP ring buffers of request timestamps (last RATE_WINDOW_MS).
  const rateBuckets = new Map()

  function rateLimited(ip) {
    const now = Date.now()
    let bucket = rateBuckets.get(ip) || []
    bucket = bucket.filter(t => now - t < cfg.rateWindowMs)
    if (bucket.length >= cfg.rateLimit) {
      rateBuckets.set(ip, bucket)
      return true
    }
    bucket.push(now)
    rateBuckets.set(ip, bucket)
    return false
  }

  function corsHeaders(origin) {
    const h = {
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    }
    if (origin && cfg.allowedOrigins.indexOf(origin) !== -1) {
      h['Access-Control-Allow-Origin'] = origin
    }
    return h
  }

  function sendJson(res, status, obj, extraHeaders) {
    res.writeHead(status, Object.assign(
      { 'Content-Type': 'application/json; charset=utf-8' },
      extraHeaders || {},
    ))
    res.end(JSON.stringify(obj))
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let total = 0
      let overLimit = false
      const chunks = []
      req.on('data', chunk => {
        if (overLimit) return  // drain silently to let 'end' fire cleanly
        total += chunk.length
        if (total > cfg.maxBodyBytes) {
          overLimit = true
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        if (overLimit) reject(new Error('body-too-large'))
        else resolve(Buffer.concat(chunks).toString('utf8'))
      })
      req.on('error', reject)
    })
  }

  const server = http.createServer(async (req, res) => {
    const startMs = Date.now()
    const ip = (req.socket && req.socket.remoteAddress) || 'unknown'
    const origin = req.headers.origin || ''
    const cors = corsHeaders(origin)

    const done = status => logger({ ts: new Date().toISOString(), ip, url: req.url, status, latencyMs: Date.now() - startMs })

    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors)
      res.end()
      return done(204)
    }

    if (req.method !== 'POST' || req.url !== '/coach') {
      sendJson(res, 404, { error: 'not_found' }, cors)
      return done(404)
    }

    if (rateLimited(ip)) {
      sendJson(res, 429, { error: 'rate_limited' }, cors)
      return done(429)
    }

    let raw
    try { raw = await readBody(req) } catch (e) {
      sendJson(res, 413, { error: 'body_too_large' }, cors)
      return done(413)
    }

    let parsed
    try { parsed = JSON.parse(raw) } catch (e) {
      sendJson(res, 400, { error: 'invalid_json' }, cors)
      return done(400)
    }

    const prompt = parsed && parsed.prompt
    if (typeof prompt !== 'string' || !prompt.length) {
      sendJson(res, 400, { error: 'missing_prompt' }, cors)
      return done(400)
    }

    try {
      const text = await callGemini(prompt)
      sendJson(res, 200, { text }, cors)
      return done(200)
    } catch (e) {
      sendJson(res, 502, { error: 'upstream_error' }, cors)
      return done(502)
    }
  })

  return server
}

function defaultLogger(entry) {
  // prompt/response bodies are NEVER logged. Only metadata.
  console.log(`[${entry.ts}] ${entry.ip} ${entry.url} ${entry.status} ${entry.latencyMs}ms`)
}

// ─── Startup (only when run as the main script) ──────────────────────

if (require.main === module) {
  if (!defaults.apiKey) {
    console.error('[coach-proxy] GEMINI_API_KEY is required')
    process.exit(1)
  }
  const srv = createServer({})
  srv.listen(defaults.port, () => {
    console.log(`[coach-proxy] listening on http://localhost:${defaults.port}`)
    console.log(`[coach-proxy] model: ${defaults.model}`)
    console.log(`[coach-proxy] allowed origins: ${defaults.allowedOrigins.join(', ')}`)
  })
}

module.exports = { createServer, defaults }
