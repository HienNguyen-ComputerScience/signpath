# Two-Tier Template Quality — Build Report

_Adds per-template `quality: "high" | "low"` to the SignPath engine with
tier-aware scoring, thresholds, and feature weighting. Back-compatible:
templates without a `quality` field are treated as `"high"`, so the 77 MB
production `sign-templates.json` works unchanged._

## Tests

| Suite                                    | Before | After | New tests |
|------------------------------------------|--------|-------|-----------|
| `signpath-session.test.js`               | 20     | 25    | O, P, P2, Q, Q2 |
| `signpath-progression.test.js`           | 25     | 25    | —         |
| `signpath-review.test.js`                | 16     | 16    | —         |
| `signpath-audio.test.js`                 | 9      | 9     | —         |
| `signpath-api.test.js`                   | 16     | 17    | R         |
| `signpath-engine-quality.test.js` (new)  | —      | 15    | A–N + F2  |
| `coach-proxy/test.js`                    | 11     | 11    | —         |
| **Total**                                | **97** | **118**| **+21**  |

No pre-existing test expected-values needed updating. The full prior suite
passes unmodified — the defensive `quality: 'high'` defaults in both engine
(`_normalizeQuality`) and session (`_computeStars` + `PASS_THRESHOLDS`)
keep every legacy path numerically identical.

Reproduce:
```bash
cd signpath-test
for f in signpath-*.test.js; do node "$f" || exit 1; done
cd ../coach-proxy && node test.js
```

---

## What changed, per file

### `signpath-engine.js`

1. **New module-level constants** (replaces the old `SIM_FLOOR`, `SIM_CEILING`,
   `STAR_THRESHOLDS`):
   - `SIM_THRESHOLDS = { high: {floor, ceiling, passAt}, low: {...} }`
   - `STAR_THRESHOLDS_HIGH = [50, 70, 88]` (historical)
   - `STAR_THRESHOLDS_LOW  = [passAt, passAt+15, passAt+25] = [55, 70, 80]`
     (derived from `SIM_THRESHOLDS.low.passAt` so one number tunes the whole
     low-tier curve).
   - `WEIGHTS_HIGH` = Float32Array of 1.0 (162 entries)
   - `WEIGHTS_LOW`  = 1.5 on features 0–125 (hand bands), 0.3 on 126–161 (pose + face)
   - `WEIGHTS_SQ_HIGH`, `WEIGHTS_SQ_LOW` — precomputed w[i]² arrays so the hot
     loop doesn't re-square every feature every frame every template.

2. **Weighted cosine helpers** (replaces `_cosineSimilarityPrenormed` — the
   old unweighted fast path is gone, single code path now):
   - `_frameWeightedNorm(frame, wSq, start, len)` → √Σ w²·x²
   - `_cosineSimilarityWeightedPrenormed(a, b, wSq, start, len, normA, normB)`
     → `Σ w²·a·b / (normA·normB)`. With all-1 weights this reduces to plain
     cosine, so the high-tier hot path is numerically identical to the
     pre-change behaviour.

3. **`_simToScore(sim, quality)` — quality is now MANDATORY.** Calling without
   a tier (`_simToScore(0.7)`) throws. This catches the exact failure mode
   the prompt flagged — a low-tier template accidentally getting scored with
   high-tier numbers fails loudly instead of silently.

4. **New `_starsForScore(score, quality)`** — mirrors the new per-tier star
   arrays. Also mandatory-tier.

5. **New `_normalizeQuality(raw)`** helper. Accepts `'high'` or `'low'`;
   anything else (missing, `null`, typo'd strings) folds to `'high'`. Gives
   us one line at the boundaries and keeps the rest of the engine from
   branching on the null case.

6. **Template loader (in `init`)** reads `tmpl.quality`, normalises it, then
   precomputes `fullNorms` using the tier's weight profile. Back-compat:
   templates without `quality` get `'high'` and all-1 weights, so
   `fullNorms` equals the old plain L2 norm exactly.

7. **`_compareAndScore` rewire:**
   - Precomputes two user-norm arrays (one per tier). The low-tier array is
     only computed if at least one loaded template is low-quality.
   - Per-template scoring uses that template's own tier's weights + score
     mapping.
   - Top-5 ranking remains by **similarity**, not score — so a low-tier
     template's generous score mapping cannot leapfrog a higher-similarity
     high-tier template. Tested in `engine-quality test K`.
   - `isMatch` now includes the `passed` branch: a selected sign that
     crossed its tier's `passAt` is a stronger signal than ranking #1 on a
     sub-threshold attempt.
   - `score` event payload adds `quality`, `passed`, `passAt` at top level
     plus `quality` per row in `top3`/`top5`/`prediction`.

8. **`_computeFingerScores(userFrames, gloss, quality)`** — quality now
   mandatory. Finger cosine itself is still unweighted (every feature in
   this subset lives in the dominant-hand band, so weights cancel in the
   cosine ratio). Only the `_simToScore` mapping differs by tier, which is
   what keeps per-finger scores consistent with the whole-frame score.

9. **`_computeDeviations(userFrames, gloss, fingerScores, quality)`** —
   adds `templateQuality` to the returned object (top-level field).
   Structure otherwise unchanged — the coach can decide later to suppress
   pose-related tips for `'low'` templates if desired.

10. **`_updateProgress`** now uses `_starsForScore(score, tmpl.quality)`
    instead of the hardcoded `STAR_THRESHOLDS`.

11. **New public getter** `engine.getTemplateQuality(key)` →
    `'high' | 'low' | null` (null for unknown signs).

12. **Internals exposed for tests** via `SignPathEngine._internals` —
    mirrors the pattern used by session/progression/review/audio modules.

### `signpath-session.js`

1. **Module header** gained a "Template-quality defensive default" paragraph
   explaining why the session tolerates missing `quality` on a score event
   (defaults to `'high'`). This is the exact defensive behaviour requested.

2. **Constants** replaced `STAR_THRESHOLDS` with `STAR_THRESHOLDS_HIGH` +
   `STAR_THRESHOLDS_LOW` + a small `PASS_THRESHOLDS = { high: 70, low: 55 }`
   map used only as a fallback when the score event omits `passAt`.

3. **`_computeStars(score, quality)`** — now tier-aware. Missing/unknown
   quality falls through to high, matching the engine's own default.

4. **`_finish` (attempt:end builder)** reads `quality` + `passAt` from
   `current.lastPayload` with defensive defaults, then:
   - Computes `stars` with `_computeStars(finalScore, quality)` — so a
     score of 82 is 2 stars for high templates but 3 stars for low.
   - Computes `passed = finalScore >= passAt`.
   - Surfaces both `quality` and `passed` on the `attempt:end` payload
     alongside the existing fields.

5. **Legacy alias** `SignPathSession.STAR_THRESHOLDS` still points at
   `STAR_THRESHOLDS_HIGH` so anything that poked the internal name keeps
   working. Not expected to have external consumers.

### Files explicitly not touched

- `signpath-progression.js`, `signpath-review.js`, `signpath-audio.js`,
  `signpath-coach.js`: no change needed. None inspect score-event payloads
  beyond passing them through.
- `signpath-api.js`: no change. Event forwarding is wholesale
  (`mod.on(event, fn)` → `fn(entirePayload)`); the new fields reach UI
  subscribers automatically. Verified by `api.test.js` test **R**.
- `test.html`: intentionally untouched per prompt. Reference-video page
  will pick up the new fields when the UI work happens separately.
- `build_templates.py`, any Python under `vsl400/` / `models/`:
  untouched. Schema recommendations for Prompt 2's Python work are at the
  bottom of this document.

---

## Weight profiles and rationale

```
Feature band      | Index range | LOW weight | HIGH weight
------------------|-------------|------------|------------
Dominant hand     | 0..62       | 1.5        | 1.0
Non-dominant hand | 63..125     | 1.5        | 1.0
Pose subset       | 126..146    | 0.3        | 1.0
Face subset       | 147..161    | 0.3        | 1.0
```

These numbers are **a v1 best-guess**. All three knobs (the weight ratio,
the `SIM_THRESHOLDS.low.floor/ceiling`, and `passAt`) should be tuned
against real low-tier data once Prompt 2 has scraped it. They are kept as
module-level constants in `signpath-engine.js` so tuning is a one-line
edit — no restructuring needed.

### v1.5 tuning axis to flag: wrist-in-pose

`POSE_IDX = [11, 12, 13, 14, 15, 16, 0]` — that is **shoulders, elbows,
wrists, nose**. Landmarks 15 and 16 are the wrists, which are anatomically
the anchor points of the hand and behave more like hand features than
body-posture features. Yet they currently sit in the pose band at weight
0.3 for low-tier templates.

This is a candidate for a finer split (e.g. wrists at 0.8, rest-of-pose
at 0.2) **if** low-tier scoring under-performs on signs that involve big
arm movement. Deliberately not pre-optimising — we'll have real data to
eval against soon, and guessing fine weights before then is premature.

The feature layout is static and documented in
`_buildFrame` (signpath-engine.js), so splitting the pose band into
"wrist" vs "rest" is a 5-line change: add indices 126–131 (= `POSE_IDX[3]`
elbows × 3 + `POSE_IDX[4,5]` wrists × 3? — actually wrists are
`POSE_IDX[4]` and `POSE_IDX[5]` which map to feature indices 138–143) at
the higher weight, keep the others at 0.3. Will verify exact offsets when
doing the tuning pass.

---

## Tests flagged for spot-check

**No pre-existing expected values changed.** That was the design goal of
the defensive defaults. You can diff the old session tests and find that
every assertion that used to pass still passes without modification.

**Math.round float-imprecision surprise in NEW tests.** Noting because it
could mislead future readers:

On paper `(0.70 - 0.55) / (0.95 - 0.55) * 100 = 37.5`, which rounds up to
`38`. IEEE-754 in practice gives `37.4999…`, which rounds down to `37`.
The same thing hits the sim-to-score mapping at sim 0.70 and a couple of
other round numbers. Affected tests — **C** in `engine-quality.test.js`
(comparing the low/high score mapping at sim 0.70) and **N** (per-finger
scores at sim 0.70) — both assert the *actual* computed value (37), not
the paper one (38), with an inline comment explaining why. Don't "fix"
this by subtracting a small epsilon or tweaking the sim — the measured
value is the right answer for the engine's actual arithmetic.

---

## Notes for Prompt 2

### JSON schema the supplementary-template builder should emit

The engine already understands one shape of `sign-templates.json`. After
this change, the exact same shape still loads, with one optional per-entry
field:

```jsonc
{
  "version": "3.0" | whatever,
  "frameCount": 60,
  "featureCount": 162,
  "templates": {
    "<gloss>": {
      "mean":        [[/* 162 floats */], ... 60 frames],
      "sampleCount": <int>,
      "consistency": <float 0..1>,

      // NEW: optional tier marker. Defaults to "high" if absent.
      // Supplementary (single-signer) templates MUST set this to "low".
      "quality":     "high" | "low"
    },
    ...
  }
}
```

Engine behaviour on load:
- Missing `quality` → normalized to `"high"` (back-compat; the 77 MB
  VSL400 file needs no migration).
- `quality: "high"` or `"low"` → used as given.
- Any other value (typo, unknown string, non-string) → normalized to
  `"high"` with no warning. If Prompt 2 wants to catch typos pre-deploy,
  do it in the Python builder — the engine deliberately tolerates them.

### How to ship supplementary templates

Three patterns, any of which works — pick whichever fits the Prompt 2 flow:

1. **Merge into the existing file.** Simplest. Prompt 2 loads the current
   `sign-templates.json`, adds the 16-ish missing glosses with
   `"quality": "low"`, writes back the merged file. Engine loads it as
   always, zero engine changes needed.

2. **Two separate files.** Prompt 2 emits
   `sign-templates-supplementary.json` with the same top-level shape. UI
   bootstrap code fetches both and merges the `templates` dicts before
   handing to `engine.init({ templates: merged })`. This would need a
   small engine tweak to accept a pre-loaded templates object; flag it in
   that prompt if chosen.

3. **Single file, per-entry mix.** If the supplementary builder runs in
   the same pipeline as `build_templates.py`, have it emit one combined
   `sign-templates.json` with `"quality": "high"` on VSL400-derived
   entries and `"quality": "low"` on the scraped ones. Simplest long-term
   — requires `build_templates.py` to stamp `"quality": "high"` on its
   output, which is one line of Python.

Recommend **option 3** for v1 — it keeps the deploy shape uniform and
makes the quality tier visible at every template's record.

### What Python definitely needs to learn (for Prompt 2 to actually work)

- Write one `mean` array per sign, same shape as VSL400 templates — 60
  frames × 162 floats. The engine's feature layout is already committed in
  `_buildFrame` and mirrored in `extract_vsl400.py`'s
  `normalize_to_body` + `POSE_INDICES`/`FACE_INDICES` — re-use those.
- Set `quality: "low"` on every scraped template.
- Emit `sampleCount: 1` and some honest `consistency` measure (e.g., if
  scraping two takes of the same signer, the frame-wise variance of the
  normalized landmarks). Not load-bearing for scoring today but surfaced
  in UI via `getTemplate(key).consistency` later.
- Keep the feature-count invariant: 162, same preprocessing pipeline as
  `extract_vsl400.py`. A mismatch here would silently break scoring
  because the engine assumes a 162-wide frame throughout.
