# Frontend deployment — Netlify

Static site. Nothing to build; Netlify just publishes `signpath-test/`.

## Prereqs (one time)

1. Netlify account (already set up).
2. Netlify CLI installed:
   ```powershell
   npm install -g netlify-cli
   ```
3. Coach-proxy deployed on Render — URL hardcoded as the production fallback
   in [signpath-test/app.html](signpath-test/app.html): `https://signpath-coach.onrender.com`.
4. Gzipped templates built:
   ```powershell
   cd C:\SignPath
   python scripts\compress_templates.py
   ```
   This produces `signpath-test/models/sign-templates.json.gz` (~11 MB).
   Re-run whenever you rebuild `sign-templates.json`.

## One-time Netlify setup

```powershell
cd C:\SignPath
netlify login
netlify init
```

When prompted:
- **Create a new site** (or link to an existing one).
- **Team**: pick yours.
- **Site name**: anything — you can rename later, or accept the random name.
- **Build command**: leave blank (static site).
- **Publish directory**: `signpath-test` (matches `netlify.toml`).

Netlify writes `.netlify/state.json` to link this directory to the site.

## Every deploy

```powershell
cd C:\SignPath

# Preview deploy (no traffic impact) — good for smoke-testing.
netlify deploy

# Production deploy.
netlify deploy --prod
```

The CLI prints the live URL when it's done. First deploy takes 1–2 minutes;
incremental deploys are near-instant because Netlify hashes files and only
uploads what changed.

### After rebuilding templates

If you regenerate `sign-templates.json` (via `python build_templates.py`),
re-run the compressor before deploying:

```powershell
python scripts\compress_templates.py
netlify deploy --prod
```

## CORS — update Render after the first Netlify deploy

The coach-proxy's `ALLOWED_ORIGINS` and `ALLOWED_ORIGIN_SUFFIXES` env vars on
Render must include your Netlify URL, or browser requests to the coach will
fail with a CORS error.

1. Note your Netlify URL (e.g., `https://signpath-vsl.netlify.app`).
2. Render dashboard → signpath-coach → Environment:
   - `ALLOWED_ORIGINS` = `http://localhost:8000,https://<your-netlify>.netlify.app`
   - (Or) `ALLOWED_ORIGIN_SUFFIXES` = `.netlify.app` — covers any preview
     deploy subdomain too.
3. Save. Render redeploys automatically.

## Post-deployment smoke checks

Open the live URL in a new browser window, then:

1. **DevTools Console** — no red errors. Expect:
   - `[engine] Loaded 400 templates (60 frames each)` → templates loaded fine.
   - `[engine] Template handedness classification:` → preprocessing OK.
2. **DevTools Network**:
   - `sign-templates.json.gz` responds `200` with `Content-Encoding: gzip`,
     transfer size ~11 MB.
   - Reference videos (`/reference_videos/*.mp4`) return `200`.
3. **Camera permission** works (browser prompts once on first practice).
4. **Practice attempt** — try one sign. Confirm score + advice appear. The
   AI coach makes a POST to `<render-url>/coach`; if you see a CORS error,
   revisit the step above.

## Rollback

Netlify UI → **Deploys** → pick a previous successful deploy → **Publish deploy**.
This flips the live site to that deploy in ~5 seconds.

CLI alternative (if you still have the old build around):
```powershell
netlify deploy --prod --dir=<path-to-previous>
```

## Troubleshooting

### Templates fail to load (404 on sign-templates.json.gz)

The compressed file isn't in the deploy. Check:
```powershell
ls signpath-test\models\sign-templates.json.gz
```
If missing, run `python scripts\compress_templates.py` and redeploy.

### Templates load but score always 0

The engine probably fell back to the uncompressed JSON and got 404 too.
Look for `[engine] Loaded 0 templates` in the console, and verify the
`Content-Encoding: gzip` header is present on the `.gz` response.

### Coach produces no advice

Expected on low scores only (score < 75 triggers remote advice). When it
should fire, check:
- DevTools Network: POST to `<render>/coach` — should be 200.
- If CORS error: update Render env vars (see "CORS" above).
- If 500: Gemini key missing on Render. Set `GEMINI_API_KEY` and redeploy
  the proxy.
- If 401/403: API key invalid.

### Deploy is too large

Netlify CLI uploads everything in `signpath-test/`. If a stray 77 MB
`sign-templates.json` landed in there, it's wasted upload. `.netlifyignore`
in the publish dir is a hint, not enforced by all CLI versions — move or
delete the raw file manually before deploying if the upload feels slow:

```powershell
# Temporarily move the raw JSON out of the deploy dir
mv signpath-test\models\sign-templates.json C:\SignPath\sign-templates.json.bak
netlify deploy --prod
mv C:\SignPath\sign-templates.json.bak signpath-test\models\sign-templates.json
```

### Still 404 on the .gz after a fresh deploy

Verify `netlify.toml` at the repo root has `publish = "signpath-test"`, and
check the Netlify deploy logs — they list every uploaded path.

## Local development (unchanged)

Netlify deployment does not affect local dev. Continue using:

```powershell
cd C:\SignPath\signpath-test
python -m http.server 8000
# Open http://localhost:8000/app.html
```

Locally the app targets `http://localhost:3000` for the coach — run the
coach-proxy in another terminal if you want full AI advice locally:

```powershell
cd C:\SignPath\coach-proxy
npm start
```

Without it, the app silently falls back to `getLocalAdvice` (rule-based
tips only).
