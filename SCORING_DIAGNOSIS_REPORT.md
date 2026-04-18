# Scoring Diagnosis Report

## Summary

The finger-vs-headline gap is **legitimate math behaviour**, not a bug. The per-finger score measures cosine similarity on a 12-feature sub-slice of the dominant hand — isolated from everything else. The whole-frame score measures cosine similarity on the full 162-feature vector, which includes **63 floats of non-dominant-hand data** and **21 floats of pose data** that together hold 55–62% of a typical template's vector energy. When any of those non-hand sections is misaligned, missing, or substituted via the palm-fallback coordinate system, the whole-frame score collapses while fingers stay perfect. The empirical test in `scripts/scoring_diagnostic.js` reproduces the exact symptom pattern (finger avg 100, whole-frame 21) just by zeroing pose+face — no math bug needed.

Most likely real-world trigger combines: (1) templates that carry non-dominant-hand energy even for nominally one-handed signs (user signs one-handed → 43% of Mẹ's template energy unmatched), (2) pose/face detection drops, or (3) shoulder detection fails so the engine silently swaps to a palm-based coordinate system that is incompatible with template coordinates.

## Findings

### Feature layout verification

**A. Total 162 features.** Breakdown is fixed by `_buildFrame` in [signpath-engine.js:325](signpath-test/signpath-engine.js:325) and mirrored exactly by `build_frame` in [build_templates.py:63](build_templates.py:63):

| Range | Count | Content |
|---|---|---|
| 0..62   | 63 | Dominant hand (21 landmarks × 3 coords) |
| 63..125 | 63 | Non-dominant hand (21 landmarks × 3) |
| 126..146 | 21 | Pose subset: `POSE_IDX = [11, 12, 13, 14, 15, 16, 0]` — shoulders, elbows, wrists, nose (7 × 3) |
| 147..161 | 15 | Face subset: `FACE_IDX = [1, 10, 152, 234, 454]` — nose tip, forehead, chin, ears (5 × 3) |

Confirmed against `model-config.json` which declares `"inputShape": [1, 90, 162]` (the 90 there is ONNX inputs for the unused classifier; template path is 60 frames). Consistent.

**B. Per-finger scoring compares 12 features per finger** (4 landmarks × 3 coords), all within the dominant hand section (0..62). From `_computeFingerScores` at [signpath-engine.js:810](signpath-test/signpath-engine.js:810):

```js
for (const li of fg.indices) {      // 4 landmarks
  for (let c = 0; c < 3; c++) {     // 3 coords each
    const a = userFrames[f][li * 3 + c]
    const b = tmpl.mean[f][li * 3 + c]
    ...
  }
}
```

FINGER_GROUPS indices are 1..20 within dominant hand — they **never see non-dom, pose, or face features**. Each finger is a completely isolated 12-dimensional cosine comparison.

### Normalization investigation

**D. Primary anchor: shoulder midpoint.** `_pickOrigin` in [signpath-engine.js:306](signpath-test/signpath-engine.js:306):
- origin = midpoint of pose[11] (L.shoulder) and pose[12] (R.shoulder)
- scale = 3-D distance between L.shoulder and R.shoulder
- Requires both shoulders with `visibility > SHOULDER_VIS (0.5)` and `scale > MIN_SHOULDER_W (0.01)`

**Fallback anchor: palm of dominant hand.**
- origin = hand landmark 0 (wrist)
- scale = distance wrist→middle-MCP (landmark 9)
- Requires `scale > MIN_PALM (0.001)`

If neither path yields an origin, `_pickOrigin` returns null and `_buildFrame` returns an all-zero Float32Array — but that frame is still pushed to `_frameBuffer` unconditionally on [signpath-engine.js:683](signpath-test/signpath-engine.js:683).

**E. Missing shoulders:** the engine silently falls back to the palm-based coordinate system. This is the **single most dangerous fallback**:
- User's frame is normalized by palm width (~0.05 in MediaPipe normalized coords) rather than shoulder width (~0.20).
- Pose and face landmarks — if detected — are then expressed in a coordinate system centered on the user's wrist, not on the user's torso.
- Template, by contrast, was always built with the shoulder coordinate system (the Python extractor writes `referenceType: "body"` almost always — palm fallback only fires for extracted samples where shoulders were invisible).
- The cosine between user's palm-normalized pose/face features and template's shoulder-normalized pose/face features will be close to random.

This mode is silent — no event, no warning, no log. You can only detect it by instrumenting `_pickOrigin` and observing `ref_type === "palm"` in production.

**F. Same normalization is used for user and template.** Verified against `build_templates.py::pick_origin` and `build_frame`:
- Same `POSE_INDICES = [11, 12, 13, 14, 15, 16, 0]` (line 27 vs engine line 35)
- Same `FACE_INDICES = [1, 10, 152, 234, 454]` (line 28 vs engine line 36)
- Same thresholds: `SHOULDER_VIS = 0.5`, `MIN_SHOULDER_W = 0.01`, `MIN_PALM = 0.001`
- Same primary/fallback origin logic (shoulders → palm → null)
- Same dominant-else-non-dominant swap rule
- Same linear resampling to 60 frames
- Template z-strips visibility with `lm[:3]` (line 116); engine just uses `lm.z || 0` (same effective behaviour)

**No Python-vs-JS drift.** One minor difference: the Python path has an explicit `extract_vsl400.py::normalize_to_body` that runs per-frame and falls back to **"none" (null frame)** if no origin is found. Those null frames become zero-filled in `build_templates.py::process_one_file` via `if np.any(vec[:63] != 0)` which **skips** frames with no dominant-hand data — so templates don't accumulate zero frames. User-side does accumulate zero frames. Net effect: templates are slightly more robust than user-buffer content during tracking dropouts.

**G. NaN / Infinity:** `_cosineSimilarity` and `_cosineSimilarityWeightedPrenormed` guard against near-zero norms (`< 1e-8`) by returning 0 — but they do **not** guard against NaN in individual features. If any feature in `a[i]` or `b[i]` is NaN, the accumulators `dot`, `normA`, `normB` become NaN, and the function returns NaN. Then:
- `_simToScore(NaN, 'high')` — `NaN <= 0.55` is false, `NaN >= 0.95` is false, falls into `Math.round(((NaN - 0.55) / 0.40) * 100)` which returns NaN.
- Per-frame NaN propagates into `totalSim += NaN` → `totalSim` is NaN → full sim is NaN → score is NaN → displayed as 0 or "NaN/100".

**Fingers can score normally while whole-frame is NaN**, because fingers operate on a different feature subset. If the NaN is in a pose or face feature, only the whole-frame path sees it. This is consistent with the observed symptom.

That said, MediaPipe landmarks are rarely NaN in practice — they're numerically clean unless a serialization bug intervenes. The engine's `||0` guards on `.z` cover most risk. NaN is a possibility but probably not the main cause.

### Feature indexing investigation

**H. Feature layout matches exactly** between JS engine's `_buildFrame` and Python's `build_frame`. Both write in the same order (dom, non-dom, pose, face) and at the same offsets (0, 63, 126, 147). No swap between the two; ruled out.

**I. Right/left hand swap:**

The rule at engine line 332 and Python line 88 is identical:
```js
let dom = rHand; let nonDom = lHand
if (!dom && nonDom) { dom = nonDom; nonDom = null }
```

This matches MediaPipe's own `rightHandLandmarks` / `leftHandLandmarks`, which label **by screen side** (not anatomical side). For a non-mirrored front-facing camera:
- User's **right hand** appears on the **left** of the screen → MediaPipe reports it in `leftHandLandmarks`
- User's **left hand** appears on the **right** of the screen → reported in `rightHandLandmarks`

So for a right-handed signer making a **one-handed** sign with the right hand: `rHand` will be `null` and `lHand` will have the right hand. The rule then correctly promotes `lHand` to dom. ✓

For a **two-handed** sign: both hands are populated. The engine's dom-slot gets whichever hand appears on the right of the screen (the user's left hand for a non-mirrored camera). The Python extractor did the same thing to build the template. So user and template agree on which hand is in which slot — consistent. ✓

**However, there is a subtle mirror-convention trap:**
- The practice screen's visible webcam element has `transform: scaleX(-1)` CSS (line in `screens/practice.js`), purely cosmetic — doesn't affect the stream MediaPipe consumes.
- MediaPipe sees the raw non-mirrored feed.
- If a user runs the app on a laptop/OS that applies hardware mirroring to the webcam **before** the stream reaches the browser (some corporate laptop software does this), the hand assignments in MediaPipe output are effectively flipped **compared to VSL400 recordings**. Template's dom would hold the signer's LEFT hand; user's dom would hold their RIGHT hand.
- This would produce a massive mismatch on the dominant hand — not consistent with the observed high finger scores. So probably not the mechanism here.

**The handedness debug code at [signpath-engine.js:637](signpath-test/signpath-engine.js:637) is commented out** but Phuong could uncomment it to verify against a specific camera setup.

**J. Face indices:** Python and JS agree: `[1, 10, 152, 234, 454]` on `face = results.faceLandmarks` (MediaPipe Holistic's 468-point face mesh). No facemesh-vs-pose-face mixup. Both engine and Python require `face.length > 454`, meaning both need a full face mesh detection. ✓

### NaN / Infinity safety check

**K.** If a single pose feature becomes NaN (e.g. `lm.z` returns NaN, which is unlikely given `||0` protection but not impossible for edge-case MediaPipe output), the per-frame cosine over [0..162) returns NaN. That frame's contribution to `totalSim` is NaN. `totalSim / nFrames` is NaN. `_simToScore(NaN)` is NaN. `Math.round(this._smoothedScore)` after `this._smoothedScore * 0.4 + NaN * 0.6` is NaN.

Per-finger path uses a different feature subset so it's immune. This is exactly the asymmetric pattern observed.

**L.** There is **no NaN-safe logging anywhere in `_compareAndScore`**. `console.log` in the loaded-templates path is the only existing diagnostic (line 529). If Phuong wants to confirm the hypothesis on Phuong's real attempts, the cheapest instrumentation would be:
- Log per-band cosine similarities (dom hand, non-dom hand, pose, face) whenever the overall `sim < 0.65`
- Log `isNaN(sim)` warnings
- Log `ref_type === "palm"` events (shoulder-fallback triggered)

This can be added without changing any scoring behaviour.

### Empirical test results

Ran `node scripts/scoring_diagnostic.js "Cảm ơn"` and `"Mẹ"`. Two scenarios dominate the results:

**For "Cảm ơn"** (57 signers, consistency 0.749). Template energy per frame:
- Dominant hand: 33.7 (39.7%)
- Non-dominant hand: 30.0 (35.3%)  ← two-handed sign
- Pose: 19.0 (22.4%)
- Face: 2.2 (2.6%)

| Scenario | Whole-frame sim | Score | Finger avg | Gap |
|---|---|---|---|---|
| S0 identical | 1.00 | 100 | 100 | 0 |
| S1 hand shifted 0.15 in Y | 0.996 | 100 | 99.6 | –0.4 |
| S2 face shifted 0.15 in Y | 0.999 | 100 | 100 | 0 |
| S3 pose shifted 0.15 in Y | 0.998 | 100 | 100 | 0 |
| **S4 non-dom hand zeroed** | **0.878** | **82** | **100** | **18** |
| **S5 pose + face zeroed** | **0.635** | **21** | **100** | **79** |
| S6 realistic small shifts | 0.993 | 100 | 100 | 0 |
| S7 S6 + non-dom zeroed | 0.871 | 80 | 100 | 20 |
| S8 all-small 0.05 shifts | 0.999 | 100 | 100 | 0 |

**For "Mẹ"** (57 signers, consistency 0.631). Template energy per frame:
- Dominant hand: 40.5 (37.8%)
- Non-dominant hand: 46.1 (43.1%)  ← also has non-dom energy despite Mẹ being nominally one-handed
- Pose: 17.5 (16.4%)
- Face: 2.9 (2.7%)

| Scenario | Whole-frame sim | Score | Finger avg | Gap |
|---|---|---|---|---|
| S0 identical | 1.00 | 100 | 100 | 0 |
| S1 hand shifted 0.15 in Y | 0.998 | 100 | 100 | 0 |
| **S4 non-dom hand zeroed** | **0.744** | **49** | **100** | **51** |
| S5 pose + face zeroed | 0.863 | 78 | 100 | 22 |
| S6 realistic small shifts | 0.996 | 100 | 100 | 0 |
| **S7 S6 + non-dom zeroed** | **0.739** | **47** | **100** | **53** |

**Interpretation:**
- **Small translations (0.05–0.15 in Y) do NOT meaningfully drop the whole-frame score.** This rules out "user sitting slightly differently from the VSL400 average" as the sole cause.
- **Zeroing pose+face** reproduces the symptom for Cảm ơn (gap 79) but less dramatically for Mẹ (gap 22). Effect depends on how much energy lives in pose+face for that specific template.
- **Zeroing the non-dom hand** reproduces the symptom for Mẹ (gap 51) but less so for Cảm ơn (gap 18). Effect depends on how much non-dom energy the template carries.
- **Combined — S7** (realistic skew + non-dom missing) gives gap 53 on Mẹ. Very consistent with attempt-1's reported gap of ≈67 points.

### Mathematical bounds check

**C. Is a 14/100 headline mathematically achievable given 81% average finger scores?** **Yes, comfortably.**

- 81% finger score ⇒ finger cosine avg ≈ 0.874 (`_simToScore⁻¹`: 0.55 + 0.81 × 0.40)
- 14/100 headline ⇒ whole-frame cosine ≈ 0.606

The hand section is 63 floats carrying ~40% of template energy on average. Per-finger cosines being ~0.87 doesn't guarantee the dominant-hand cosine is exactly 0.87 (finger sub-cosines aren't perfectly compositional), but it's usually close. Our S4 scenario with Mẹ produced: perfect fingers, dom-hand cosine 1.0, whole-frame cosine 0.744. That's a gap of 51 on score (finger avg 100 vs whole-frame 49). Attempt-1's 67-point gap is slightly larger but in the same regime.

The math is consistent. **No impossibility.**

## Root cause assessment

- [x] **Legitimate math behaviour.** The scoring is working exactly as designed. The per-finger and whole-frame scores measure different things:
  - Fingers: hand-shape match in isolation (translation-ish invariant, focused on 5 small regions)
  - Whole-frame: full-body match including non-dom hand, pose, and face
  
  When pose, face, or non-dom-hand features diverge from template (due to MediaPipe miss, user-vs-template body difference, one-handed user vs two-handed template, or shoulder-fallback to palm-coordinate system), the whole-frame score drops severely while fingers stay put.

- [ ] Bug in normalization
- [ ] Bug in feature indexing
- [ ] NaN/Infinity propagation *(theoretical risk, no evidence it fires in practice)*

**The gap is a design consequence, not an error.** The weighted cosine is WEIGHTS_HIGH = all-1.0, so pose and face get the same weight as hand features. That weighting is what makes "body position" dominate the score when fingers already match.

**Secondary observation:** the engine already has `WEIGHTS_LOW` defined (hand 1.5, pose 0.3, face 0.3) in [signpath-engine.js:87](signpath-test/signpath-engine.js:87) — designed for low-quality single-signer templates. The comments around it acknowledge the same concern Phuong is now hitting. High-tier templates currently don't get this reweighting.

## Recommended fixes

### Primary recommendation

**[Low risk, high impact] Apply hand-emphasizing weights to the high tier.**

Change `WEIGHTS_HIGH` (currently all-1.0) to a version that emphasizes the hand bands, matching or slightly less aggressive than `WEIGHTS_LOW`. Proposed values:

```js
const WEIGHTS_HIGH = (() => {
  const w = new Float32Array(NUM_FEATURES)
  for (let i = 0;   i < 63;  i++) w[i] = 1.2   // dominant hand (moderate boost)
  for (let i = 63;  i < 126; i++) w[i] = 1.2   // non-dominant hand
  for (let i = 126; i < 147; i++) w[i] = 0.5   // pose (halve)
  for (let i = 147; i < 162; i++) w[i] = 0.5   // face
  return w
})()
```

Rationale:
- A right-handed user signing at a different camera angle from the VSL400 average should not score 14/100 when their hand shape is correct.
- The existing finger-score path already demonstrates that hand-only cosines are a good proxy for intent.
- Weights 1.2 / 0.5 are less aggressive than WEIGHTS_LOW's 1.5 / 0.3 because high-tier templates are more trustworthy — we don't want to discount pose/face entirely.
- Because weighted cosine is computed via precomputed `WEIGHTS_SQ_HIGH` and `fullNorms`, changing weights requires regenerating `fullNorms` on template load (the existing code already does this — no structural change needed, just the constants).

Estimated impact: whole-frame scores for attempts with good hand shape should rise by ~15-30 points on average. Headline=14 attempts with good fingers would become headline ≈40-55.

**Risk**: tuning; might allow previously-rejected attempts with wrong body but correct hand. Mitigation: keep SIM_THRESHOLDS.high unchanged (so 2-star = score 70, 3-star = score 88 still require a real match) AND use the existing deviations pipeline (which flags hand_too_low, missing_second_hand, etc.) to refuse "match" when posture is clearly wrong.

### Secondary fix

**[Low risk, focused impact] Don't include non-dom-hand in the cosine when the user obviously isn't using a second hand.**

In `_compareAndScore`, if `_computeDeviations` flags `twoHanded.needed && !twoHanded.present`, recompute the whole-frame cosine over [0..63, 126..162) (skipping the non-dom slice). This avoids the 20–50 point penalty for templates that carry non-dom energy from signers whose second hand was at rest but in frame.

Estimated impact: on Mẹ (43% non-dom energy) this alone can move a user's whole-frame score from 49 to ~85 (S4 comparison). Coach advice already tells the user they're missing the second hand separately, so no information is lost.

**Risk**: low. The deviations check is cheap and already computed. Need to make sure it doesn't fire for genuinely two-handed signs where the user just happens to have their second hand.

### Secondary fix (observability)

**[Low risk, cheap] Log per-band cosines when score is suspiciously low.**

In `_compareAndScore`, if `sim < 0.65` for the selected sign, emit to `console.log` (or a new `debug` event) the four per-band cosines — dom hand, non-dom hand, pose, face. Also log when `_pickOrigin` returns a palm fallback.

This won't change scoring, but Phuong can verify from live attempts whether it's pose/face/non-dom that's actually tanking the score. Critical before tuning the weights further.

**Risk**: none (logging only). High value for continued diagnosis.

### Lower-priority fix

**[Medium risk, broad impact] Loosen SIM_THRESHOLDS.high.floor from 0.55 to 0.50.**

Currently, a cosine of 0.60 maps to score 13. That's very punitive — a 0.60 cosine on a 162-dim feature space is actually quite close to "right direction" in high-dimensional geometry. With floor=0.50, 0.60 cosine → score 25.

Estimated impact: inflates scores across the board by ~5-15 points. Paired with the weight change above, this may be redundant or excessive — tune only if Phuong still finds attempts unfairly low after primary fix.

**Risk**: medium. Easy to over-tune and let bad attempts pass. Not recommended before weights are adjusted.

### Do not fix (yet)

- The palm-fallback coordinate system in `_pickOrigin` is subtle but only affects users whose shoulders aren't visible. Rather than patching the math, the right fix is probably to **abort and prompt "Please stand back so we can see your shoulders"** when palm fallback fires. Out of scope for a scoring fix; do in UI layer.
- The NaN protection is absent but hasn't been empirically observed to bite. Add defensive guards only if the log instrumentation in the observability fix reveals actual NaN events.
- Mirror-convention handedness risk is real but would have produced LOW finger scores too. It doesn't match the observed data.

## Files inspected

- `signpath-test/signpath-engine.js` — read in full (1212 lines)
- `signpath-test/signpath-session.js` — scanned for `finalScore` / `peakScore` / score-event handling; did not fully read
- `signpath-test/models/model-config.json` — read in full (415 lines)
- `signpath-test/models/sign-templates.json` — scanned first 500 bytes + loaded via diagnostic
- `build_templates.py` — read in full (296 lines)
- `extract_vsl400.py` — scanned for normalization + feature-layout code; `normalize_to_body`, `build_frame` equivalents
- `signpath-test/reference_videos/manifest.json` — scanned structure only

Diagnostic script created:
- `scripts/scoring_diagnostic.js` — new, read-only Node CLI that reproduces the symptom pattern empirically. Does not import the engine; replicates the minimal math helpers. Does not mutate state. Invoked as `node scripts/scoring_diagnostic.js [gloss]`.

**No source files modified.**
