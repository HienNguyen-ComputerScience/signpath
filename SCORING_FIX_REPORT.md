# Scoring Fix Report

## Summary

Four coordinated fixes applied to address the finger-vs-headline score gap identified in `SCORING_DIAGNOSIS_REPORT.md`:

1. **Fix 1 — Skip non-dominant hand** when user one-handed + template non-dom energy below threshold. Narrow but surgical — targets the 7/400 templates where VSL400 residual non-dom artifact was actively hurting correct one-handed attempts.
2. **Fix 2 — Mild hand-emphasis weights** on high-quality templates (hand 1.15, pose/face 0.7 instead of all 1.0). Broad lever affecting every attempt on every template.
3. **Fix 3 — Observability**: `debug:score` event with per-band cosine breakdown when sim < 0.65, and `tracking:degraded` event when palm-fallback rate > 20%.
4. **Fix 4 — UI palm-fallback banner** in the practice screen plus framing guidance in onboarding step 2.

**Test totals: 107 → 122** (15 new, 0 regressions, 1 existing assertion updated for new weights).

## Risk summary

| Fix | Risk | Why |
|---|---|---|
| Fix 1 | **Low** | Only fires when both precondition flags are false; otherwise full-frame cosine as before. Defensive fallback when `deviations.twoHanded` is missing. Top-5 ranking unchanged (still full-frame). |
| Fix 2 | **Low-medium** | Touches every single scoring attempt. Expected effect is +5-15 points on hand-correct/pose-off attempts. Capped bump via `simToScore` ceiling 0.95. WEIGHTS_LOW untouched. |
| Fix 3 | **Low** | Pure observability — emits events, does not change scoring. Rate-limited. |
| Fix 4 | **Low** | Non-blocking UI banner. User can still record through the warning. Dismissible. |

## Files changed

| File | Change |
|---|---|
| [signpath-test/signpath-engine.js](signpath-test/signpath-engine.js) | `WEIGHTS_HIGH` (hand=1.15, pose/face=0.7); `_pickOrigin` returns `refType`; `_buildFrame` optional `outMeta` param; new `_cosineSimilarityWeightedMasked` and `_compareSequencesWeightedBand` helpers; `_onResults` tracks `_originHistory`; new `_maybeEmitDegraded` helper; `_compareAndScore` reads `deviations.twoHanded` and recomputes masked cosine for one-handed match; conditional `debug:score` emission; `_internals` exposes new helpers for tests |
| [signpath-test/signpath-api.js](signpath-test/signpath-api.js) | `EVENT_OWNERS` adds `debug:score` and `tracking:degraded`, both owned by engine |
| [signpath-test/screens/practice.js](signpath-test/screens/practice.js) | Palm-fallback warning banner element (hidden by default); `tracking:degraded` handler shows banner + resets 5s quiet timer; dismiss button; timer cleared on screen teardown |
| [signpath-test/screens/onboarding.js](signpath-test/screens/onboarding.js) | Framing-tips card added to step 2 (VI + EN) between the "why" details and the permission button |
| [signpath-test/signpath-engine-quality.test.js](signpath-test/signpath-engine-quality.test.js) | Test E hard-coded `simHi === 0.5` updated to `1.3225 / 1.8125 ≈ 0.7297` for new weights (see "Updated assertions" below) |
| [signpath-test/signpath-engine-fixes.test.js](signpath-test/signpath-engine-fixes.test.js) | **New** — 15 tests covering O1–O4, W1–W3, L1–L5 |

## Fix details

### Fix 1 — Skip non-dom hand on one-handed match

Engine logic at [signpath-engine.js:854-885](signpath-test/signpath-engine.js:854):

```js
if (deviations && deviations.twoHanded
    && deviations.twoHanded.needed === false
    && deviations.twoHanded.present === false
    && selectedEntry) {
  // Recompute cosine over [0..63) ∪ [126..162) for the selected sign only.
  // Top-5 ranking is unaffected — it still uses full-frame cosine.
  const maskedSim = … _cosineSimilarityWeightedMasked …
  selectedSim = maskedSim
  rawScore = _simToScore(maskedSim, selectedQuality)
  skippedNonDom = true
}
```

**Real-world impact:** Of 400 VSL400 templates, only **7** satisfy `tmplNonDomEnergy < 5`:
`Bánh chưng (4.5)`, `Bánh tét (3.9)`, `Hiệu trưởng (2.7)`, `Khăn quàng cổ (3.7)`, `Quả chuối (4.4)` — plus two others. Another 64 templates are in the 5-10 borderline zone. The remaining **329 templates have > 10 non-dom energy and are correctly considered two-handed**; Fix 1 won't activate for them, which is correct — a user signing those one-handed should be penalized.

**This means Fix 1 by itself is insufficient to lift the demo's one-handed Mẹ scenario.** Mẹ has non-dom energy 46.1, so its template is considered two-handed. For Mẹ (and 328 similar templates), Fix 2 is the lever that helps.

### Fix 2 — Hand-emphasis weights on high-tier

Change to `WEIGHTS_HIGH` at [signpath-engine.js:101-107](signpath-test/signpath-engine.js:101):

```js
const WEIGHTS_HIGH = (() => {
  const w = new Float32Array(NUM_FEATURES)
  for (let i = 0;   i < 63;  i++) w[i] = 1.15  // dominant hand
  for (let i = 63;  i < 126; i++) w[i] = 1.15  // non-dominant hand
  for (let i = 126; i < 147; i++) w[i] = 0.7   // pose
  for (let i = 147; i < 162; i++) w[i] = 0.7   // face
  return w
})()
```

`WEIGHTS_SQ_HIGH` regenerates automatically; template `fullNorms` recompute on load (pre-existing infrastructure). No schema change.

**Expected uplift (measured by the W3 test):** For a hand-correct + pose/face drift scenario, under new weights the whole-frame cosine rises modestly (test asserts new score ≥ old score AND uplift ≤ 40 points, avoiding over-tuning). WEIGHTS_LOW at 1.5/0.3 is unchanged, preserving the quality-tier distinction.

### Fix 3 — Observability

New events emitted from the engine:

**`debug:score`** — conditional on the selected sign's similarity being below 0.65. Payload:
```js
{
  signKey, overallSim, overallScore,
  perBandSim: { domHand, nonDomHand, pose, face },
  skippedNonDom,              // did Fix 1 fire?
  originFallbackActive,       // is the current frame palm-normalized?
  quality,
}
```

**`tracking:degraded`** — fires when the last 30 frames' palm-fallback rate exceeds 20%, rate-limited to one emit per 2000ms. Payload:
```js
{ reason: 'shoulders_not_visible', palmFallbackRate }
```

Both events registered in `EVENT_OWNERS` so the facade `app.on(...)` forwards them to UI subscribers.

### Fix 4 — UI warning + onboarding guidance

**Practice screen** ([screens/practice.js](signpath-test/screens/practice.js)):
- Warning banner element inserted above the two-column layout. Hidden by default (`display: none`).
- Subscribes to `tracking:degraded`. First event shows the banner (`display: flex`) with VI+EN copy and a dismiss (×) button. Each subsequent event resets a 5-second quiet timer.
- Auto-hides 5 consecutive seconds after the last event.
- Manual dismiss sticks for the screen instance (prevents re-appearance while the user is reading).
- Timer cleared in `teardown()` to avoid zombie timers on navigation.
- **Non-blocking** — Record button remains enabled; user can attempt at their own risk.

**Onboarding step 2** ([screens/onboarding.js](signpath-test/screens/onboarding.js)):
- Added a Framing-tips card between the "Why do we need this?" details and the "Cho phép & tiếp tục" button.
- VI-primary: "Ngồi cách camera khoảng một sải tay. Đảm bảo cả hai vai đều nằm trong khung hình và ánh sáng đủ sáng."
- EN secondary: "Sit at arm's length. Make sure both shoulders are in frame and there is enough light."
- **Decision note:** A live shoulder-detection indicator was considered but rejected — the existing auto-advance-after-400ms would flash the indicator for a fraction of a second, providing no value. Live detection happens on the practice screen via Fix 3's `tracking:degraded`.

## Test results

### Full suite

```
signpath-engine-quality.test.js    15 passed, 0 failed
signpath-engine-fixes.test.js      15 passed, 0 failed  (new)
signpath-session.test.js           25 passed, 0 failed
signpath-progression.test.js       25 passed, 0 failed
signpath-review.test.js            16 passed, 0 failed
signpath-api.test.js               17 passed, 0 failed
signpath-audio.test.js              9 passed, 0 failed
─────────────────────────────────────────────────────
TOTAL                             122 passed, 0 failed
```

Preserved: **107/107 existing tests pass** (the prompt said 118 but the actual count was 107; confirmed by counting test names in each file).

### New tests (15)

| Tag | Test | What it proves |
|---|---|---|
| O1 | one-handed user + one-handed tmpl with residual non-dom → Fix 1 activates, score improves | skip-non-dom fires when precondition met; full-band cosine would score below 100, masked cosine reaches 100 |
| O2 | two-handed user + two-handed tmpl → skip NOT activated | both `needed=true` and `present=true` → precondition fails → full-frame scoring preserved |
| O3 | one-handed user + two-handed tmpl → skip NOT activated (penalty correct) | `needed=true`, `present=false` → precondition fails → user correctly penalized for missing hand |
| O4 | `deviations.twoHanded` missing → defaults to full-frame, no crash | defensive fallback for malformed deviations |
| W1 | WEIGHTS_HIGH hand=1.15 pose/face=0.7 (8 index checks + LOW/SQ guards) | weights placed in the right bands at the specified values; LOW untouched; SQ matches W² |
| W2 | equal raw deviation — hand mismatch hurts more than pose mismatch | hand-emphasis ordering: `simA < simB` for hand-off vs pose-off |
| W3 | hand-correct + pose/face drift → modest score uplift | new ≥ old AND uplift ≤ 40 points (bounds prevent over-tuning) |
| L1a | `debug:score` emits when selected sim < 0.65 | conditional emission fires below threshold |
| L1b | `debug:score` does NOT emit on high-sim attempt | conditional emission skipped above threshold |
| L2 | `debug:score` payload has 4 bands + metadata | payload shape stable: domHand/nonDomHand/pose/face keys, bands in [-1,1], skippedNonDom boolean, quality, signKey |
| L3 | `tracking:degraded` fires when palm rate > 20% | 50% palm rate → emit with `reason: 'shoulders_not_visible'` |
| L3b | `tracking:degraded` does NOT fire at 10% palm rate | threshold guard |
| L3c | `tracking:degraded` does NOT fire with <15 frames | warm-up guard |
| L4 | `tracking:degraded` rate-limited to once per 2000ms | three back-to-back calls emit once; after cooldown, emits again |
| L5 | API facade EVENT_OWNERS registers both events | facade plumbing confirmed for subscribers |

### Updated assertions (existing tests)

**Only ONE assertion** required an expected-value update:

| File:line | Before | After | Reason |
|---|---|---|---|
| [signpath-engine-quality.test.js:142](signpath-test/signpath-engine-quality.test.js:142) | `assert.ok(Math.abs(simHi - 0.5) < 1e-6)` | `assert.ok(Math.abs(simHi - (1.3225 / 1.8125)) < 1e-6)` (new value ≈ 0.7297) | Test E constructs a vector with components in *different* weight bands (index 0 = hand, index 126 = pose). Under old all-1.0 weights, weighted-cos reduced to unweighted-cos → simHi = 0.5. Under new weights (hand²=1.3225, pose²=0.49), the weighted formula gives `1.3225 / 1.8125`. Corresponding comment updated to document the derivation. `simLo` assertion unchanged because `WEIGHTS_LOW` unchanged. |

All other assertions on specific score values were verified safe because:
- `_simToScore` tests (A, B, C, H) test the **pure mapping** from similarity to score using `SIM_THRESHOLDS`, which are unchanged.
- Most engine tests use vectors **entirely within one weight band** (e.g., indices 0 and 1 are both in the dom-hand band), so weighted-cos == unweighted-cos and numeric results don't change (tests I, J, K, L, M).
- Per-finger test N uses **unweighted** cosine internally — `_computeFingerScores` is weight-independent by design.
- Session/progression/review/API tests inject **pre-scored mock events**, never computing cosines.
- Identical-vector tests always yield sim=1 → score=100 regardless of weights (test I, S0).

## Behavior changes beyond the four fixes

None. All changes are scoped to the four fixes; no side effects observed. Specifically:
- `_pickOrigin`'s new `refType` field is additive (doesn't change existing `{ox, oy, oz, scale}` access patterns).
- `_buildFrame`'s new `outMeta` parameter is optional; existing code paths (none external) are unaffected.
- `_compareAndScore` still emits the `score` event with the same shape; per-band/observability emission goes through a separate `debug:score` event.
- Template loading semantics unchanged; 77MB `sign-templates.json` loads exactly as before (templates without `quality` field still default to `'high'` via `_normalizeQuality`).

## UI verification (manual testing guidance)

### Palm-fallback banner on the practice screen

**To reproduce live:**
1. Start the app: `cd signpath-test && python -m http.server 8000`, open `http://localhost:8000/app.html`
2. Navigate: onboarding → home → pick a lesson → pick a sign → practice screen
3. While on the practice screen, occlude your shoulders (e.g., cross your arms in front of your torso, or step very close to the camera so shoulders leave the frame, or stand up so only head is visible)
4. Within **2 seconds** (15-frame warm-up + 2000ms rate limit), an amber banner should appear above the two-column layout with:
   - Icon: ⚠ warning
   - Title: "Khung hình chưa đủ"
   - Body: "Lùi ra xa camera hoặc bật thêm ánh sáng · Step back from the camera or improve lighting"
   - Dismiss button (×)
5. Uncover your shoulders. The banner auto-hides after **5 seconds** of no new `tracking:degraded` events.
6. Occlude again → banner reappears.
7. Click × to dismiss manually → banner stays dismissed for the remainder of this practice-screen visit (reopens if you leave and return).

**Verified via simulation in the preview:**
- `app.engine._emit('tracking:degraded', {...})` → banner `display: flex`, renders VI+EN copy correctly.
- After 5 seconds → `display: none` confirmed.
- Record button remains enabled throughout (non-blocking).

### Framing tips in onboarding step 2

- Visit `#onboarding/2` (or clear `localStorage.removeItem('signpath:onboarded')` and reload).
- Between the "Why do we need this?" collapsible and the "Cho phép & tiếp tục" button, a yellow-tinted card with a lightbulb icon shows the framing tips.
- No interactive element; the user reads it once and continues.

## Recommendations for follow-up tuning

Once observability data (`debug:score` events) is collected from real practice attempts:

1. **Tune the 5.0 threshold in `_computeDeviations`** (`needsTwoHands = tmplNonDomEnergy > 5`). Currently 329/400 templates trip this. If the live telemetry shows Fix 1 never fires but users routinely score 40-60 on their dominant hand with correct form, consider raising the threshold to ~10 to let more templates benefit from Fix 1.

2. **Consider extending Fix 1 to a "dominant-hand-dominant weight" mode**: instead of completely skipping the non-dom band when `needed=false`, apply a 0.3 weight to it (same as pose/face). This preserves some signal for borderline templates without the hard penalty of current full-band scoring.

3. **Investigate per-band drift from `debug:score` logs.** If the telemetry consistently shows face sim < 0.5 across many users on high-score attempts, further reduce face weight (currently 0.7). Conversely, if pose is consistently good, the 0.7 pose weight can stay.

4. **Add a `'none'` origin metric.** Currently `_pickOrigin` returns null for frames where neither shoulders nor palm can be established. Those frames become all-zero and enter the buffer unconditionally. Worth counting these too — if "none" > 10% of frames, the user has a different problem (user is too far from camera entirely).

5. **Re-examine WEIGHTS_HIGH trade-off.** The current 1.15/0.7 is conservative. After real-world attempts, if average scores are too generous (users passing signs they clearly aren't performing), pull pose/face up toward 0.85. If scores are still too punitive despite Fix 2, pull pose/face down toward 0.5.

All of these are **data-dependent** — do not tune blind. The Fix 3 observability is exactly what makes this calibration possible.
