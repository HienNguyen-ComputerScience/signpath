# Scoring Fix V2 Report — Template-Side One-Handed Detection

## Summary

Replaced Fix 1's activation logic. The user-side check (`deviations.twoHanded.needed===false && present===false`) is gone; activation is now driven entirely by a **template-side motion metric** `nonDomMotionRatio`, computed once at template load and cached on each template record. If the ratio is below threshold `0.3`, the template represents a one-handed sign and the non-dom band is skipped from the cosine — regardless of what the user's hands are doing.

Rationale: for a linguistically one-handed sign, the user's non-dom hand state is irrelevant to correctness. Whether they have one hand, two hands, or are gesturing with a second hand — none of it affects the sign's meaning. Removing the user-side check eliminates an edge case (user one-handed + template has noisy non-dom falsely tripping activation) and removes a second threshold to tune.

Fixes 2, 3, and 4 from the previous session are unchanged.

**CRITICAL FINDING:** with the spec's threshold of `0.3`, **zero out of 400 VSL400 templates classify as one-handed**. See "Classification results" below — the threshold doesn't match the empirical motion distribution. **Flagged for Phuong's decision; threshold not adjusted in this session.**

## Test totals: 128 → 128 (target met)

- 107 existing tests preserved
- 6 previous-session fix tests (W1-W3, L1-L5 including L1a/L1b/L3a/L3b/L3c) preserved, 15 total in fixes file
- 4 O tests rewritten per v2 logic
- 6 new M tests for the motion metric

```
signpath-engine-quality.test.js    15 passed, 0 failed
signpath-engine-fixes.test.js      21 passed, 0 failed  (4 O + 6 M + 3 W + 8 L)
signpath-session.test.js           25 passed, 0 failed
signpath-progression.test.js       25 passed, 0 failed
signpath-review.test.js            16 passed, 0 failed
signpath-api.test.js               17 passed, 0 failed
signpath-audio.test.js              9 passed, 0 failed
─────────────────────────────────────────────────────
TOTAL                             128 passed, 0 failed
```

## What changed

### New helper + threshold

[signpath-engine.js:66-70](signpath-test/signpath-engine.js:66) — threshold constant:
```js
const NONDOM_MOTION_RATIO_THRESHOLD = 0.3
```

[signpath-engine.js:412-448](signpath-test/signpath-engine.js:412) — motion-ratio helper:
```js
function _computeNonDomMotionRatio(meanFrames) {
  // For each hand (dom at 0..62, non-dom at 63..125):
  //   For each of 21 landmarks:
  //     extent = max(rangeX, rangeY, rangeZ) across 60 frames
  //   motionAvg = sum(extent) / 21
  // return nonDomMotion / domMotion
  // Guard: domMotion < 0.01 → return 1.0 (safe default for static signs)
}
```

### Template loader caches the ratio

[signpath-engine.js:524-527](signpath-test/signpath-engine.js:524):
```js
this._templates[gloss] = {
  mean, fullNorms, quality, sampleCount, consistency,
  nonDomMotionRatio: _computeNonDomMotionRatio(mean),
}
```

Computed once at init. Classification summary and specific-signs breakdown logged immediately after the loader loop.

### Activation condition in `_compareAndScore`

[signpath-engine.js:922-933](signpath-test/signpath-engine.js:922) — replaces the old `deviations.twoHanded.needed===false && present===false` gate:

```js
const isOneHandedMatch = selectedEntry
  && tmplRec
  && typeof tmplRec.nonDomMotionRatio === 'number'
  && tmplRec.nonDomMotionRatio < NONDOM_MOTION_RATIO_THRESHOLD
if (isOneHandedMatch) {
  // Recompute masked cosine over [0..63) ∪ [126..162) — same as before.
  ...
}
```

Missing `nonDomMotionRatio` → conservative default: NOT skip (safe for minimal test mocks and legacy cached objects).

### `debug:score` payload updated

Added two new fields per spec:
- `nonDomMotionRatio` (the cached metric)
- `skipNonDomActivated` (the boolean decision — alias of the existing `skippedNonDom`, kept for both names for clarity)

Removed: no `userIsOneHanded` was ever surfaced; nothing to drop.

### `_computeDeviations` untouched

The coach still receives `twoHanded.needed/present` as before. The deviations pipeline's role is to tell the user "you need your second hand" — separate from scoring activation. Per spec explicitly out of scope.

## Classification results — real 400-template corpus

Ran `_computeNonDomMotionRatio` against all 400 templates with threshold `0.3`:

```
Total:        400
One-handed:     0    (ratio < 0.3)
Two-handed:   400    (ratio ≥ 0.3)
Static-dom:     0    (guard triggered)
```

**Distribution (percentiles of nonDomMotionRatio):**

| Percentile | Ratio |
|---|---|
| p10 | 0.468 |
| p25 | 0.561 |
| p50 (median) | 0.822 |
| p75 | 0.948 |
| p90 | 0.979 |

**Bottom 10 (most one-handed-like, closest to triggering activation):**

| Gloss | Ratio |
|---|---|
| `Thấp (đồ vật)` | 0.329 |
| `Dở` | 0.332 |
| `Lùn` | 0.353 |
| `Khoe khoang` | 0.361 |
| `Máy bay` | 0.366 |
| `Quạt (đứng)` | 0.369 |
| `Tốt bụng` | 0.374 |
| `Cái áo` | 0.393 |
| `Cao (người)` | 0.393 |
| `Trung Quốc` | 0.396 |

**Top 10 (most two-handed-like, excluding static ratio=1.0):**

All between 1.08 and 1.19 — the non-dom hand's motion extent exceeds the dom hand's in these signs. Examples: `Chạy`, `Nhảy dây`, `Bóng đá`, `Giúp đỡ`, `Quả đu đủ`. Note that ratio can exceed 1.0 because the non-dom can move through a larger range than the dom (e.g., the non-dom sweeps while the dom stays still).

## Specific-sign breakdown

| Sign | Ratio | Classified | Expected | Correct? |
|---|---|---|---|---|
| `Mẹ` | 0.681 | two-handed | one-handed | **❌ MISCLASSIFIED** |
| `Bố` | 0.613 | two-handed | one-handed | **❌ MISCLASSIFIED** |
| `Anh` | 0.559 | two-handed | one-handed | **❌ MISCLASSIFIED** |
| `Em` | 0.528 | two-handed | one-handed | **❌ MISCLASSIFIED** |
| `Cảm ơn` | 0.964 | two-handed | two-handed | ✓ |
| `Xin lỗi` | 0.991 | two-handed | two-handed | ✓ |
| `Xin` | 0.968 | two-handed | two-handed | ✓ |
| `Năm` | 0.892 | two-handed | two-handed | ✓ |
| `Có` | 0.45 | two-handed | one-handed | **❌ MISCLASSIFIED** |
| `Vợ` | 0.719 | two-handed | (two-handed) | ✓ |
| `Chồng` | 0.793 | two-handed | (two-handed) | ✓ |
| `Cháu` | 0.998 | two-handed | (two-handed) | ✓ |
| `Ông nội` | 0.452 | two-handed | (one-handed) | **❌ MISCLASSIFIED** |
| `Bà nội` | 0.47 | two-handed | (one-handed) | **❌ MISCLASSIFIED** |
| `Phở` | 0.959 | two-handed | (one-handed, typical) | **❌ MISCLASSIFIED** |
| `Bia` | 0.486 | two-handed | (one-handed) | **❌ MISCLASSIFIED** |
| `Cà phê` | 1.008 | two-handed | (two-handed) | ✓ |
| `Nhà` | 0.926 | two-handed | (two-handed) | ✓ |
| `Xe máy` | 0.922 | two-handed | (two-handed) | ✓ |
| `Mưa` | 0.93 | two-handed | (two-handed) | ✓ |
| `Nắng` | 0.468 | two-handed | (one-handed) | **❌ MISCLASSIFIED** |

**Not in corpus** (outside VSL400): `Chào`, `Không`, `Ba`, `Mười`. These are expected gaps — VSL400 doesn't cover every sign in the curriculum.

## ⚠️ Threshold miscalibration — flagged for Phuong

**Per the spec:**
> If Mẹ classifies as two-handed, the threshold 0.3 is wrong — FLAG in the report, don't just raise the threshold.

Mẹ classifies as two-handed. So do Bố, Anh, Em, and several others that should be one-handed. The threshold of 0.3 does not match the VSL400 motion distribution.

### Why the VSL400 ratios are all so high

Two compounding factors:
1. **Natural incidental motion.** VSL400 signers' non-dom hands didn't truly rest — they drifted, adjusted posture, moved in sympathy with the dom hand, etc. Even for nominally one-handed signs, the non-dom landmark positions shift meaningfully across 60 frames.
2. **Mean-template smoothing.** The template is averaged across 57+ signers. Each signer's non-dom happened to be in a slightly different position, and different across frames → after averaging, the mean's non-dom trajectory is smoothed but still shows motion extent comparable to the dom hand's smoothed trajectory (which is also averaged).

The current metric `max(rangeX, rangeY, rangeZ)` per landmark measures "how much the mean trajectory varies across 60 frames" — and for averaged templates, that's closer to the dom-hand motion than we'd hoped.

### Recommended paths forward (NOT implemented this session)

**Option A — Raise threshold to separate known one-handed from known two-handed:**

Looking at the specific signs above, a threshold around `0.55` would correctly classify Mẹ, Bố, Anh, Em, Có, Ông nội, Bà nội, Bia, Nắng as one-handed while keeping Cảm ơn, Xin lỗi, Xin, Năm, Phở (arguable), Cà phê, Nhà, Xe máy, Mưa, Cháu, Vợ, Chồng as two-handed.

Cost: some "borderline" signs (Vợ at 0.719, Chồng at 0.793 — both probably two-handed so still correct) would still classify correctly. But borderline signs near the threshold will be sensitive to small changes in the template data. A threshold of `0.55` would put ~11-15% of the corpus (60+ templates) into the one-handed bucket based on the p25 mark at 0.561.

Risk: signs like `Nắng` (ratio 0.468) and `Có` (0.45) would activate skip — if any of those ARE truly two-handed, they'd be under-penalized.

**Option B — Replace the metric:**

The ratio-of-extents approach is noisy because both hands show averaging-induced motion. Alternatives:
- Measure **absolute non-dom motion** (just `nonDomMotion` without normalizing by dom). Then "one-handed" = non-dom motion below some absolute threshold. Avoids the ratio's scale sensitivity.
- Measure **non-dom landmark dispersion per-frame, not per-landmark-across-frames**. A resting hand has landmarks in a fixed relative configuration (always forming a hand shape); a signing hand has landmarks moving relative to each other.
- Measure **non-dom velocity distribution**. Resting = mostly near zero; signing = sustained non-zero.

**Option C — Classify via external signal:**

If VSL has a known one-handed/two-handed classification (linguistic metadata), add it to `sign-templates.json` at build time and skip the motion-based detection entirely. This is more work but more correct.

### My recommendation

Options A and B are data-tuning; C is scope-creep. The quickest ship-it path for the contest:

1. Run `debug:score` telemetry on 10-20 live attempts first (with current 0.3 threshold → zero activations, so everything goes through full-frame cosine — same behaviour as pre-Fix 1).
2. Collect the per-band sim data from `debug:score` events.
3. Decide then whether raising the threshold to 0.55 is worth it. At current 0.3, Fix 1 is dormant — the scoring behaviour is entirely driven by Fix 2 weights + the rest of the pipeline.

**Bottom line:** Fix 1 v2 is correctly implemented and tested, but the spec's threshold value of `0.3` produces **zero activations** against the real corpus. The scoring system is safe to ship with `0.3` — Fix 1 just won't fire. Tune or re-design before shipping a threshold that activates, because the current metric miscategorizes known one-handed family signs.

## Test changes

### O tests — rewritten (4)

All four O tests restructured around the new `nonDomMotionRatio` signal. Setup patterns:

| Tag | Old setup | New setup | Assertion (unchanged intent) |
|---|---|---|---|
| O1 | mock `deviations.twoHanded = {needed:false, present:false}` | `makeTemplate(..., { nonDomMotionRatio: 0.1 })` stubs the ratio | skip activates → score = 100 on identical dom hands |
| O2 | mock user has 2 hands matching template's 2 hands | `makeTemplate(..., { nonDomMotionRatio: 0.8 })` + user mirrors both hands | score = 100 for identical two-handed attempt; skip does NOT fire |
| O3 | user one-handed vs tmpl two-handed (needs flag) | user frames have empty non-dom + `nonDomMotionRatio: 0.8` | score < 100 (user correctly penalized for missing hand); **skip must NOT activate** |
| O4 | monkey-patched `_computeDeviations` to omit `twoHanded` | `makeTemplate(..., { skipNonDomMotionRatio: true })` constructs a tmpl without the field | no crash, defaults to full-frame scoring |

Test helper `makeTemplate` gained `opts.nonDomMotionRatio` (explicit override) and `opts.skipNonDomMotionRatio` (omit the field entirely). The `capture()` helper now returns the engine reference on `captured._engine` for assertion convenience.

### M tests — new (6)

| Tag | What it proves |
|---|---|
| M1 | Stationary non-dom over moving dom → ratio ≈ 0. Confirms the metric measures what we think it does. |
| M2 | Dom + non-dom moving equally → ratio ≈ 1.0. Sanity for the symmetric case. |
| M3 | Static dom (both hands stationary) → returns guard value 1.0. Safe default for edge case. |
| M4 | End-to-end: one-handed template + user with **noisy non-dom** → skip still activates. **This is the v2 design point — user's non-dom state is irrelevant.** |
| M5 | End-to-end: two-handed template + user with empty non-dom → skip does NOT activate; user correctly penalized. Critical inverse of M4. |
| M6 | `debug:score` payload exposes `nonDomMotionRatio` and `skipNonDomActivated`. Telemetry contract. |

Test utility `buildMotionFrames({ domMotion, nonDomMotion })` constructs a 60-frame sequence with specified motion extents for empirical ratio verification.

### Existing tests preserved

Zero regressions on the 122 previously-passing tests. The `signpath-engine-fixes.test.js` file grew from 15 to 21 tests.

## Files changed

| File | Change |
|---|---|
| [signpath-test/signpath-engine.js](signpath-test/signpath-engine.js) | Added `NONDOM_MOTION_RATIO_THRESHOLD`; added `_computeNonDomMotionRatio` helper; loader caches `nonDomMotionRatio` on each template; init-time classification log; `_compareAndScore` uses the new activation condition (removed old two-handed flag gate); `debug:score` exposes `nonDomMotionRatio` + `skipNonDomActivated`; `_internals` exports updated |
| [signpath-test/signpath-engine-fixes.test.js](signpath-test/signpath-engine-fixes.test.js) | `makeTemplate` accepts `opts.nonDomMotionRatio` / `opts.skipNonDomMotionRatio`; `capture()` returns `_engine`; O1-O4 rewritten; M1-M6 added; `buildMotionFrames` helper |

No changes to: `signpath-api.js`, `signpath-session.js`, `signpath-progression.js`, `signpath-review.js`, `signpath-coach.js`, `signpath-audio.js`, `_computeDeviations` (explicitly out of scope), any UI files, Python pipeline files.
