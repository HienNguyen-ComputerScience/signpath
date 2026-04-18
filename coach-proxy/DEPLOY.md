# Coach Proxy — Render.com Deployment

Zero-dependency Node HTTP proxy that wraps Gemini so the API key never ships to the browser. This document covers Render.com deployment (free tier, no credit card). For the archived Fly.io variant see [`_fly_archive/DEPLOY_FLY.md`](_fly_archive/DEPLOY_FLY.md).

> **Note on LLM provider.** The current code calls **Google Gemini** (`GEMINI_API_KEY`, `gemini-2.5-flash`). If Groq is now the required provider, `server.js::defaultCallGemini` needs to change first — deployment itself is provider-agnostic.

## First-time setup

Two paths — pick one. **Option A** (GitHub) is recommended because updates redeploy automatically on push.

### Option A — Deploy from GitHub (recommended)

1. **Push the repo to GitHub.** Private repos are fine — Render supports them on the free tier.

2. **Sign up at https://dashboard.render.com** — no credit card required.

3. **Create a new service:**
   - Click **"New +"** → **"Web Service"**.
   - Connect your GitHub account and select the SignPath repo.
   - Render will detect [`render.yaml`](render.yaml) and pre-fill most fields. Verify:
     - **Name**: `signpath-coach` (or any unique name — the URL will be `https://<name>.onrender.com`)
     - **Region**: Singapore
     - **Branch**: `main`
     - **Root Directory**: `coach-proxy`
     - **Runtime**: Docker
     - **Instance Type**: Free
     - **Health Check Path**: `/health`
     - **Auto-Deploy**: Yes

4. **Add secrets in the "Environment" section** (click "Advanced" if not visible):
   - `GEMINI_API_KEY` = your Gemini key from https://aistudio.google.com/apikey — **mark as secret**.
   - `ALLOWED_ORIGIN_SUFFIXES` = `.netlify.app` — accepts every Netlify preview URL. Not sensitive, but still set via env var so you can change it without a code deploy.

5. **Click "Create Web Service".** Build + first deploy takes 2-5 min.

6. **Record the public URL** — something like `https://signpath-coach.onrender.com`. You'll need it for the frontend deploy (Prompt 2).

### Option B — Deploy via ZIP upload (no GitHub)

1. Zip the `coach-proxy/` folder (make sure `.env` is NOT inside).
2. Dashboard → **"New +"** → **"Web Service"** → **"Deploy from Git or Zip"** → upload.
3. Same configuration as Option A, steps 3-4.

Updates require a fresh zip upload — no auto-deploy.

## Updating

- **GitHub path:** `git push origin main` → Render auto-deploys within ~30 seconds.
- **ZIP path:** re-upload via the dashboard → manually trigger a deploy.

Either way, tail live logs from the **"Logs"** tab while the deploy runs.

## Testing the deployed proxy

```powershell
# Health check — should be < 1s once the service is warm.
curl https://signpath-coach.onrender.com/health
# Expected: {"status":"ok"}

# CORS preflight for a Netlify preview URL
curl -i -X OPTIONS https://signpath-coach.onrender.com/coach `
  -H "Origin: https://deploy-preview-1--signpath.netlify.app" `
  -H "Access-Control-Request-Method: POST"
# Expect 204 with "Access-Control-Allow-Origin: https://deploy-preview-1--signpath.netlify.app"

# Real coach call
curl -X POST https://signpath-coach.onrender.com/coach `
  -H "Content-Type: application/json" `
  -H "Origin: https://signpath.netlify.app" `
  -d '{\"prompt\":\"Respond with the single word: OK\",\"lang\":\"en\"}'
# Expect {"text":"OK"} (or similar Gemini output)
```

## ⚠ Cold-start mitigation — CRITICAL FOR DEMO

**Render's free tier spins down after ~15 minutes of inactivity.** The first request after spin-down takes **30-50 seconds** while the container cold-boots. If a judge hits the practice screen 20 minutes after your last warmup, they wait 40 seconds for coach advice.

Mitigation layers — use ALL of them:

### 1. UptimeRobot external ping (primary — always runs)

1. Sign up at https://uptimerobot.com (free, no card).
2. **"Add New Monitor"**:
   - **Type**: HTTP(s)
   - **URL**: `https://signpath-coach.onrender.com/health`
   - **Monitoring Interval**: 5 minutes
3. UptimeRobot pings every 5 min → Render stays warm indefinitely.

### 2. Browser-side keep-warm (secondary — runs while the app is open)

When a user has the SignPath app open in a tab, the [`signpath-test/scripts/keep_warm.js`](../signpath-test/scripts/keep_warm.js) module pings `/health` every 10 minutes from their browser. Supplements UptimeRobot — if UptimeRobot is ever flaky, the user's own browser keeps their session warm.

### 3. Manual warmup before a high-stakes demo

2-3 minutes before the judges arrive:

```powershell
for ($i=0; $i -lt 3; $i++) { curl -s https://signpath-coach.onrender.com/health; Start-Sleep -s 2 }
```

Three pings with a 2s gap ensures the container is fully hot and ready before anyone uses the app.

## Environment variables

| Name | Required | Default | Purpose |
|---|---|---|---|
| `GEMINI_API_KEY` | **yes** | — | Google AI Studio key. Set in Render dashboard as SECRET. |
| `ALLOWED_ORIGIN_SUFFIXES` | yes for prod | (empty) | Host-suffix allowlist — `.netlify.app` covers every preview URL. |
| `ALLOWED_ORIGINS` | no | `http://localhost:8000` | Explicit origin allowlist (comma-separated). Useful for pinning a production URL. |
| `GEMINI_MODEL` | no | `gemini-2.5-flash` | Override the Gemini model if needed. |
| `NODE_ENV` | no | `production` (via render.yaml) | Standard Node convention. |
| `PORT` | no | auto-injected by Render | Do NOT override; Render assigns this dynamically. |

## Troubleshooting

| Symptom | Check |
|---|---|
| Deploy succeeds but `/health` returns 502 | Container isn't starting. Check **"Logs"** tab for stack trace. Usual cause: missing `GEMINI_API_KEY`. |
| Browser shows CORS error | Verify `ALLOWED_ORIGIN_SUFFIXES` matches your Netlify domain (`.netlify.app`, leading dot, no trailing slash). |
| First request after idle takes 30-50s | Expected cold start. Activate UptimeRobot (see above). |
| Build fails | Check **"Events"** tab for the error. Common cause: Dockerfile path wrong — must be `./Dockerfile` relative to `coach-proxy/`. |
| Deploy succeeds then crashes | Check memory — free tier has 512MB. This app uses ~40MB so shouldn't hit the limit, but a runaway prompt-buffer bug could. |

## Running tests locally

```powershell
cd C:\SignPath\coach-proxy
node test.js
# Expect 15 passed, 0 failed (live Gemini test skipped unless GEMINI_API_KEY + LIVE_TEST=1 are set)
```

## Files

- [`Dockerfile`](Dockerfile) — builds the runtime image. Non-root user, node:20-alpine. Unchanged from Fly config — same image works on both.
- [`.dockerignore`](.dockerignore) — keeps `.env`, tests, docs, and git metadata out of the image.
- [`render.yaml`](render.yaml) — Render declarative config. Auto-detected on first deploy from GitHub.
- [`server.js`](server.js) — the proxy itself. No changes needed for Render.
- [`_fly_archive/`](_fly_archive/) — original Fly.io config preserved in case of future pivot.
