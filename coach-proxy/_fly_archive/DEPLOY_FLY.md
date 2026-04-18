# Coach Proxy — Fly.io Deployment

Preparing the service for deployment. The app runs a zero-dependency Node HTTP proxy that wraps the Gemini API so the key never ships to the browser.

> **Note on LLM provider.** The current code calls **Google Gemini** (`GEMINI_API_KEY`, `gemini-2.5-flash`). The original contest plan mentioned Groq; if Groq is now the required provider, `server.js::defaultCallGemini` needs to change first — deployment itself is provider-agnostic. Confirm with Phuong before setting the secret.

## First-time setup

1. **Install `flyctl` (Windows PowerShell)**
   ```powershell
   iwr https://fly.io/install.ps1 -useb | iex
   ```
   Re-open PowerShell so `flyctl` is on PATH.

2. **Log in**
   ```powershell
   flyctl auth login
   ```

3. **Launch the app (from `coach-proxy/`, one time only)**
   ```powershell
   cd C:\SignPath\coach-proxy
   flyctl launch --no-deploy
   ```
   - Accept the suggested app name, or provide your own. `fly.toml` will be updated in place.
   - Decline when asked to set up a Postgres DB or Upstash Redis — we don't need them.
   - Region should be `sin` (Singapore) — closest to Vietnam, lowest latency for the demo.

4. **Set secrets (NEVER committed)**
   ```powershell
   flyctl secrets set GEMINI_API_KEY=ya29-your-real-key-here
   ```
   Optional — tighten CORS for production. The Netlify preview wildcard is already accepted because of `ALLOWED_ORIGIN_SUFFIXES`; add the final Netlify URL once you have it:
   ```powershell
   flyctl secrets set `
     ALLOWED_ORIGINS="https://signpath.netlify.app,http://localhost:8000" `
     ALLOWED_ORIGIN_SUFFIXES=".netlify.app"
   ```
   If you skip this step, defaults apply: `ALLOWED_ORIGINS=http://localhost:8000`, `ALLOWED_ORIGIN_SUFFIXES=` (empty). Deployed previews will be rejected unless this is set.

5. **Deploy**
   ```powershell
   flyctl deploy
   ```
   First deploy takes ~2-3 min (image build + push + machine start).

6. **Verify**
   ```powershell
   flyctl status
   ```
   Machine should be `started` and `passing` on health checks. The public URL will be `https://<app-name>.fly.dev`.

7. **Save the URL for frontend deploy (Prompt 2)**
   Write it down. The frontend needs it as `COACH_ENDPOINT` or similar when deploying to Netlify.

## Updating

```powershell
cd C:\SignPath\coach-proxy
flyctl deploy
```

Tail live logs:
```powershell
flyctl logs
```

Restart after a config change:
```powershell
flyctl apps restart <app-name>
```

## Testing the deployed proxy

### Health check
```powershell
curl https://<app-name>.fly.dev/health
# {"status":"ok"}
```

### CORS preflight (simulates Netlify preview)
```powershell
curl -i -X OPTIONS https://<app-name>.fly.dev/coach `
  -H "Origin: https://deploy-preview-1--signpath.netlify.app" `
  -H "Access-Control-Request-Method: POST"
# Expect 204 and `Access-Control-Allow-Origin: https://deploy-preview-1--signpath.netlify.app`
```

### Real coach call
```powershell
curl -i -X POST https://<app-name>.fly.dev/coach `
  -H "Content-Type: application/json" `
  -H "Origin: https://signpath.netlify.app" `
  -d '{\"prompt\":\"Respond with the single word: OK\",\"lang\":\"en\"}'
# Expect 200 with {"text":"OK"} (or similar Gemini output)
```

### Local dev still works

```powershell
cd C:\SignPath\coach-proxy
# Export secrets for this shell only
$env:GEMINI_API_KEY = "..."
$env:ALLOWED_ORIGINS = "http://localhost:8000"
node server.js
# Serves on http://localhost:8787 by default
```

### Run the tests

```powershell
cd C:\SignPath\coach-proxy
node test.js
# Expect 15 passed, 0 failed (live Gemini test skipped unless LIVE_TEST=1)
```

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `GEMINI_API_KEY` | **yes** | — | Google AI Studio key. Set via `flyctl secrets set`, never in code. |
| `GEMINI_MODEL` | no | `gemini-2.5-flash` | Override model if needed. |
| `PORT` | no | `8787` local / `3000` in Fly | Listen port. Fly sets this via `fly.toml`. |
| `ALLOWED_ORIGINS` | no | `http://localhost:8000` | Comma-separated exact-match origins. |
| `ALLOWED_ORIGIN_SUFFIXES` | no | (empty) | Comma-separated host suffixes (e.g. `.netlify.app`). Matches subdomain of ANY depth. |

## Scaling notes

- `fly.toml` uses `auto_stop_machines = "stop"` — the container sleeps when idle, saves money, adds ~2 seconds to the first request after sleep.
- If you observe too-slow cold starts during the demo, set `min_machines_running = 1` in `fly.toml` and redeploy.
- Rate limit is 30 requests/minute per IP, in-process. Fine for a single-demo use case. If you need more, the code has no persistence — a single container scaling up is the simple path.

## Files

- `Dockerfile` — builds the runtime image. Runs as non-root `app` user.
- `.dockerignore` — keeps `.env`, tests, and docs out of the image.
- `fly.toml` — Fly.io app config. Auto-scales to zero between requests.
- `server.js` — the proxy itself. No code changes needed to deploy.
