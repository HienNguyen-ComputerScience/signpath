# SignPath Coach Proxy

Tiny HTTP server that wraps Gemini so the API key never ships to the browser.

## What it does

- **POST `/coach`** — accepts `{ prompt, lang? }`, returns `{ text }` from Gemini.
- **OPTIONS `/coach`** — CORS preflight for the allow-listed browser origins.
- In-memory rate limit (30 req/min per IP).
- Never logs prompt or response bodies. Only metadata: timestamp, IP, status, latency.
- Never forwards upstream error text — returns a generic 502 on any Gemini failure.

Zero dependencies. Requires Node 18+ (for built-in `fetch`).

## Run locally

```bash
cd coach-proxy
export GEMINI_API_KEY=your-key-from-ai-studio
node server.js
```

Output:

```
[coach-proxy] listening on http://localhost:8787
[coach-proxy] model: gemini-2.5-flash
[coach-proxy] allowed origins: http://localhost:8000
```

Quick test from another shell:

```bash
curl -s -X POST http://localhost:8787/coach \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Respond with just OK","lang":"en"}'
```

## Wire the browser to the proxy

In your SignPath app initialisation:

```js
coach.setProvider(SignPathCoach.createProxyProvider('http://localhost:8787/coach'))
```

After that, `coach.getAdvice(...)` posts to the proxy instead of going direct.

## Env vars

Copy `.env.example` to `.env` and fill in. The server **does not** load `.env`
automatically — use `export`, a process manager, or a docker-compose
`env_file` to inject them. Required vars:

| Var                | Default                       | Purpose                          |
|--------------------|-------------------------------|----------------------------------|
| `GEMINI_API_KEY`   | *(required)*                  | Google AI Studio key             |
| `GEMINI_MODEL`     | `gemini-2.5-flash`            | Model ID                         |
| `PORT`             | `8787`                        | Listen port                      |
| `ALLOWED_ORIGINS`  | `http://localhost:8000`       | CORS allowlist (comma-separated) |

## Deploy

Any Node 18+ host works: Fly.io, Railway, Render, bare VM, Cloud Run, Docker.

Example **systemd** unit (`/etc/systemd/system/signpath-coach.service`):

```ini
[Unit]
Description=SignPath Coach Proxy
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/signpath/coach-proxy
ExecStart=/usr/bin/node server.js
EnvironmentFile=/etc/signpath/coach.env
Restart=on-failure
User=signpath

[Install]
WantedBy=multi-user.target
```

Where `/etc/signpath/coach.env` contains your `GEMINI_API_KEY=...` etc.

Example **Dockerfile** (add one if you want container builds):

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json server.js ./
EXPOSE 8787
CMD ["node", "server.js"]
```

## Test

```bash
node test.js
```

Smoke tests use an injected mock Gemini caller — they don't hit the real API
and don't need a key. To additionally run a live end-to-end test against real
Gemini:

```bash
GEMINI_API_KEY=real-key LIVE_TEST=1 node test.js
```

## Not included on purpose

- Request/response logging of prompts. Privacy by default.
- Persistent rate limiting (Redis etc). Process restart resets the counters;
  that's fine for this scale.
- Auth. Put this behind a trusted gateway or on a private network if you need
  per-user limits.
