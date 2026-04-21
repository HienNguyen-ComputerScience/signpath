/**
 * Tests for SCORING_FIX_REPORT.md fixes.
 * Run: node signpath-engine-fixes.test.js
 *
 * Coverage:
 *   O1-O4  Fix 1 — skip non-dominant hand when one-handed user matches one-handed template
 *   W1-W3  Fix 2 — mild hand-emphasis weights on high-tier templates
 *   L1-L5  Fix 3 — debug:score observability + tracking:degraded palm-fallback warning
 */
'use strict'

const assert = require('assert')
const { SignPathEngine } = require('./signpath-engine.js')
const I = SignPathEngine._internals

let _failures = 0, _passed = 0
async function test(name, fn) {
  try { await fn(); _passed++; console.log(`  ✓ ${name}`) }
  catch (e) { _failures++; console.error(`  ✗ ${name}\n    ${e.message}`); if (process.env.DEBUG) console.error(e.stack) }
}

// ─── Vector helpers (same pattern as signpath-engine-quality.test.js) ────

const N = I.NUM_FEATURES
const FRAME_COUNT = 60

function vec(components) {
  const v = new Float32Array(N)
  for (const k in components) v[Number(k)] = components[k]
  return v
}

function repeatFrame(frame, count = FRAME_COUNT) {
  const out = []
  for (let i = 0; i < count; i++) out.push(Float32Array.from(frame))
  return out
}

function makeTemplate(gloss, meanFrames, quality, opts) {
  opts = opts || {}
  // meanFrames may be a single Float32Array (replicated) or an array of them.
  const mean = Array.isArray(meanFrames) && meanFrames[0] instanceof Float32Array
    ? meanFrames.map(f => Float32Array.from(f))
    : repeatFrame(meanFrames)
  const wSq = quality === 'low' ? I.WEIGHTS_SQ_LOW : I.WEIGHTS_SQ_HIGH
  const fullNorms = new Float32Array(mean.length)
  for (let f = 0; f < mean.length; f++) fullNorms[f] = I._frameWeightedNorm(mean[f], wSq, 0, N)
  const tmpl = { gloss, mean, fullNorms, quality, sampleCount: 50, consistency: 0.9 }
  // [Fix 1 v2] Populate nonDomMotionRatio to match real engine loader behaviour.
  //   - opts.skipNonDomMotionRatio: true  → omit entirely (simulates a minimal
  //     mock, exercises engine's defensive fallback)
  //   - opts.nonDomMotionRatio: <num>     → explicit override
  //   - default                            → auto-compute from frames
  if (!opts.skipNonDomMotionRatio) {
    tmpl.nonDomMotionRatio = opts.nonDomMotionRatio !== undefined
      ? opts.nonDomMotionRatio
      : I._computeNonDomMotionRatio(mean)
  }
  return tmpl
}

function stubEngine(templateDefs, activeSign, userFrames) {
  const engine = new SignPathEngine()
  engine._templates = {}
  engine._signDB = {}
  engine._progress = {}
  for (const d of templateDefs) {
    engine._templates[d.gloss] = d
    engine._signDB[d.gloss] = { key: d.gloss, vi: d.gloss, en: d.gloss }
    engine._progress[d.gloss] = { stars: 0, best: 0, reps: 0 }
  }
  engine._templateFrameCount = FRAME_COUNT
  engine._templatesReady = true
  engine._activeSign = activeSign
  engine._frameBuffer = Array.isArray(userFrames) && userFrames[0] instanceof Float32Array
    ? userFrames.map(f => Float32Array.from(f))
    : repeatFrame(userFrames)
  engine._smoothedScore = null
  engine._lastCompareTime = 0
  return engine
}

function capture(engine) {
  const captured = { score: [], debugScore: [], degraded: [], _engine: engine }
  engine.on('score', e => captured.score.push(e))
  engine.on('debug:score', e => captured.debugScore.push(e))
  engine.on('tracking:degraded', e => captured.degraded.push(e))
  return captured
}

// ─── Tests ───────────────────────────────────────────────────────────────

async function run() {
  console.log('signpath-engine (fixes: non-dom skip, weights, observability)')

  // ══════════════════════════════════════════════════════════════════════
  // O — Fix 1 v2: skip non-dominant hand based on TEMPLATE motion only.
  //               Activation condition: tmpl.nonDomMotionRatio < 0.3
  // ══════════════════════════════════════════════════════════════════════

  // O1: Template classifies as one-handed (stubbed low ratio). Template has
  //     a small non-dom residual that drags the full-frame cosine. Skip
  //     should activate and lift the score.
  await test('O1: one-handed template (ratio 0.1) + residual non-dom → skip activates, score improves', () => {
    const userFrame = vec({ 0: 1 })
    const tmplFrame = vec({ 0: 1 })
    // Small non-dom residual, below "two-handed" amplitude — but the stubbed
    // ratio is what drives activation, not the residual magnitude.
    for (let i = 63; i < 126; i++) tmplFrame[i] = 0.07

    const captured = capture(stubEngine(
      [makeTemplate('ONE_H', tmplFrame, 'high', { nonDomMotionRatio: 0.1 })],
      'ONE_H', userFrame,
    ))
    const engine = captured._engine
    engine._compareAndScore()
    const ev = captured.score[0]

    // With skip active, pose+face have zero magnitude in both sides and dom
    // is identical → masked cosine = 1 → score 100.
    assert.strictEqual(ev.score, 100,
      `expected full score with non-dom band skipped, got ${ev.score}`)
  })

  // O2: Template classifies as two-handed (stubbed high ratio). Skip must
  //     NOT activate even if user frames happen to make the precondition
  //     look attractive — the sign's linguistic handedness wins.
  await test('O2: two-handed template (ratio 0.8) + matching user → skip NOT activated', () => {
    const tmplFrame = vec({ 0: 1 })
    for (let i = 63; i < 126; i++) tmplFrame[i] = 0.3    // substantial non-dom energy
    const userFrame = Float32Array.from(tmplFrame)       // user matches both hands

    const captured = capture(stubEngine(
      [makeTemplate('TWO_H', tmplFrame, 'high', { nonDomMotionRatio: 0.8 })],
      'TWO_H', userFrame,
    ))
    const engine = captured._engine
    engine._compareAndScore()
    const ev = captured.score[0]

    // Identical vectors → full-frame cosine 1 → score 100 (same as before
    // any fix). The point is that skip did NOT fire; to verify we check
    // debug:score — but sim is high so debug:score won't emit. Instead we
    // assert via a side effect: running a known-two-handed sign with a
    // one-handed user should NOT reach 100 (see O3). Here we just verify
    // the happy path yields the expected score.
    assert.strictEqual(ev.score, 100)
  })

  // O3: ** CRITICAL ** User signs one-handed for a two-handed sign
  //     (e.g., doing Cảm ơn with one hand). Skip must NOT activate; user
  //     is correctly penalized. This is the scenario that the user-side
  //     check in v1 was NOT supposed to accidentally bypass.
  await test('O3: user one-handed + two-handed template → skip NOT activated, user penalized', () => {
    const tmplFrame = vec({ 0: 1 })
    for (let i = 63; i < 126; i++) tmplFrame[i] = 0.3
    const userFrame = vec({ 0: 1 })                      // user has only dom hand

    const captured = capture(stubEngine(
      [makeTemplate('TWO_H', tmplFrame, 'high', { nonDomMotionRatio: 0.8 })],
      'TWO_H', userFrame,
    ))
    const engine = captured._engine
    engine._compareAndScore()
    const ev = captured.score[0]

    // Full-frame cosine must be < 1 because user's zero non-dom doesn't
    // match template's populated non-dom. The lower score is correct —
    // the user is missing half the sign.
    assert.ok(ev.score < 100,
      `expected partial credit for missing second hand, got ${ev.score}`)
  })

  // O4: Template loaded without nonDomMotionRatio (e.g. from a minimal mock
  //     or a legacy cached object) → engine defaults to NOT skip, runs
  //     full-frame cosine, no crash.
  await test('O4: tmpl without nonDomMotionRatio → defaults to no-skip, no crash', () => {
    const userFrame = vec({ 0: 1 })
    const tmplFrame = vec({ 0: 1 })
    const captured = capture(stubEngine(
      [makeTemplate('DEF', tmplFrame, 'high', { skipNonDomMotionRatio: true })],
      'DEF', userFrame,
    ))
    const engine = captured._engine
    // Guard: template really was constructed without the field.
    assert.strictEqual(engine._templates['DEF'].nonDomMotionRatio, undefined)
    assert.doesNotThrow(() => engine._compareAndScore())
    const ev = captured.score[0]
    assert.strictEqual(ev.score, 100, 'identical vectors still score 100')
  })

  // ══════════════════════════════════════════════════════════════════════
  // M — Fix 1 v2: the nonDomMotionRatio template metric
  // ══════════════════════════════════════════════════════════════════════

  // Helper to build 60-frame sequences where dom / non-dom hands each move
  // a specified amount across frames. Motion is a linear ramp in the x
  // coordinate of every landmark in that hand. Extent = specified motion.
  function buildMotionFrames({ domMotion, nonDomMotion }) {
    const frames = []
    for (let f = 0; f < FRAME_COUNT; f++) {
      const t = f / (FRAME_COUNT - 1)   // 0..1
      const v = new Float32Array(N)
      for (let li = 0; li < 21; li++) v[li * 3]      = domMotion * t
      for (let li = 0; li < 21; li++) v[63 + li * 3] = nonDomMotion * t
      frames.push(v)
    }
    return frames
  }

  // M1: Non-dom constant, dom moving → ratio near 0.
  await test('M1: stationary non-dom over moving dom → ratio ≈ 0', () => {
    const frames = buildMotionFrames({ domMotion: 1.0, nonDomMotion: 0 })
    const ratio = I._computeNonDomMotionRatio(frames)
    assert.ok(ratio >= 0 && ratio < 0.01, `expected ratio near 0, got ${ratio}`)
  })

  // M2: Both hands moving equally → ratio ≈ 1.
  await test('M2: dom + non-dom move equally → ratio ≈ 1.0', () => {
    const frames = buildMotionFrames({ domMotion: 1.0, nonDomMotion: 1.0 })
    const ratio = I._computeNonDomMotionRatio(frames)
    assert.ok(Math.abs(ratio - 1.0) < 1e-5, `expected ratio ≈ 1.0, got ${ratio}`)
  })

  // M3: Static dom (rare — static sign) → returns guard value 1.0.
  await test('M3: static dom (both hands stationary) → ratio = 1.0 (safe default)', () => {
    const frames = buildMotionFrames({ domMotion: 0, nonDomMotion: 0 })
    const ratio = I._computeNonDomMotionRatio(frames)
    assert.strictEqual(ratio, 1.0)
  })

  // M4: End-to-end — one-handed template + user with noisy non-dom.
  //     Skip activates regardless of user hand state (the v2 design point).
  await test('M4: one-handed template (real ratio) + noisy user non-dom → skip still activates', () => {
    // Template: dom moves across frames, non-dom is zero → ratio ≈ 0
    const tmplFrames = buildMotionFrames({ domMotion: 1.0, nonDomMotion: 0 })
    // User mirrors dom motion and adds noise in non-dom
    const userFrames = buildMotionFrames({ domMotion: 1.0, nonDomMotion: 0 })
    for (const f of userFrames) {
      for (let i = 63; i < 126; i++) f[i] = 0.5   // arbitrary non-dom noise
    }
    const captured = capture(stubEngine(
      [makeTemplate('ONE', tmplFrames, 'high')],   // auto-compute ratio from frames
      'ONE', userFrames,
    ))
    const engine = captured._engine
    // Sanity: ratio really is below threshold.
    assert.ok(engine._templates['ONE'].nonDomMotionRatio < I.NONDOM_MOTION_RATIO_THRESHOLD,
      `expected auto-computed ratio < ${I.NONDOM_MOTION_RATIO_THRESHOLD}, got ${engine._templates['ONE'].nonDomMotionRatio}`)
    engine._compareAndScore()
    const ev = captured.score[0]
    // With skip active, dom-only cosine is 1 (user mirrors dom), pose+face
    // zero on both sides → score 100 despite the user's non-dom noise.
    assert.strictEqual(ev.score, 100,
      `expected 100 when skip active (user's non-dom noise irrelevant), got ${ev.score}`)
  })

  // M5: End-to-end — two-handed template + user with empty non-dom → skip
  //     does NOT activate, user correctly penalized.
  await test('M5: two-handed template + empty user non-dom → skip NOT activated, penalty correct', () => {
    // Both hands move equally in the template → ratio ≈ 1.0 → > 0.3 threshold.
    const tmplFrames = buildMotionFrames({ domMotion: 1.0, nonDomMotion: 1.0 })
    // User has dom matching but NO non-dom activity.
    const userFrames = buildMotionFrames({ domMotion: 1.0, nonDomMotion: 0 })
    const captured = capture(stubEngine(
      [makeTemplate('TWO', tmplFrames, 'high')],
      'TWO', userFrames,
    ))
    const engine = captured._engine
    assert.ok(engine._templates['TWO'].nonDomMotionRatio >= I.NONDOM_MOTION_RATIO_THRESHOLD,
      `expected auto-computed ratio >= ${I.NONDOM_MOTION_RATIO_THRESHOLD}, got ${engine._templates['TWO'].nonDomMotionRatio}`)
    engine._compareAndScore()
    const ev = captured.score[0]
    assert.ok(ev.score < 100,
      `expected partial credit for missing second hand, got ${ev.score}`)
  })

  // M6: Integration — loader path caches nonDomMotionRatio on each template.
  //     Verify the value surfaces via debug:score along with skipNonDomActivated.
  //     Use orthogonal user/template dom directions so sim drops below 0.65
  //     and debug:score actually fires.
  await test('M6: debug:score exposes nonDomMotionRatio + skipNonDomActivated', () => {
    // Template dom ramps in X; user dom ramps in Y — orthogonal directions
    // give a near-zero cosine, forcing debug:score to emit.
    const tmplFrames = buildMotionFrames({ domMotion: 1.0, nonDomMotion: 0 })
    const userFrames = []
    for (let f = 0; f < FRAME_COUNT; f++) {
      const t = f / (FRAME_COUNT - 1)
      const v = new Float32Array(N)
      for (let li = 0; li < 21; li++) v[li * 3 + 1] = 0.5 + 0.3 * t   // Y direction
      userFrames.push(v)
    }
    const captured = capture(stubEngine(
      [makeTemplate('LOW_SIM', tmplFrames, 'high')],
      'LOW_SIM', userFrames,
    ))
    const engine = captured._engine
    engine._compareAndScore()
    const d = captured.debugScore.find(e => e.signKey === 'LOW_SIM')
    assert.ok(d, `expected debug:score to fire for LOW_SIM (sim below threshold)`)
    assert.strictEqual(typeof d.nonDomMotionRatio, 'number', 'nonDomMotionRatio present')
    assert.ok(d.nonDomMotionRatio < I.NONDOM_MOTION_RATIO_THRESHOLD,
      `expected ratio < threshold, got ${d.nonDomMotionRatio}`)
    assert.strictEqual(d.skipNonDomActivated, true,
      'skipNonDomActivated should reflect that the skip branch fired')
  })

  // ══════════════════════════════════════════════════════════════════════
  // W — Fix 2: WEIGHTS_HIGH now has mild hand emphasis
  // ══════════════════════════════════════════════════════════════════════

  // W1: weight constants live in the right bands and at the specified values.
  //     Values are stored in Float32Array so compare with epsilon.
  await test('W1: WEIGHTS_HIGH hand=1.15, pose/face=0.7', () => {
    const near = (a, b, tag) => assert.ok(Math.abs(a - b) < 1e-5, `${tag}: got ${a}, want ${b}`)
    near(I.WEIGHTS_HIGH[0],   1.15, 'dom-hand band (index 0)')
    near(I.WEIGHTS_HIGH[62],  1.15, 'dom-hand band (index 62)')
    near(I.WEIGHTS_HIGH[63],  1.15, 'non-dom-hand band (index 63)')
    near(I.WEIGHTS_HIGH[125], 1.15, 'non-dom-hand band (index 125)')
    near(I.WEIGHTS_HIGH[126], 0.7,  'pose band (index 126)')
    near(I.WEIGHTS_HIGH[146], 0.7,  'pose band (index 146)')
    near(I.WEIGHTS_HIGH[147], 0.7,  'face band (index 147)')
    near(I.WEIGHTS_HIGH[161], 0.7,  'face band (index 161)')
    // Guard: WEIGHTS_LOW is untouched (reserved for low-tier templates).
    near(I.WEIGHTS_LOW[0],   1.5, 'WEIGHTS_LOW hand')
    near(I.WEIGHTS_LOW[126], 0.3, 'WEIGHTS_LOW pose')
    // Guard: WEIGHTS_SQ_HIGH matches the squared weights.
    near(I.WEIGHTS_SQ_HIGH[0],   1.15 * 1.15, 'WEIGHTS_SQ_HIGH hand')
    near(I.WEIGHTS_SQ_HIGH[126], 0.7 * 0.7,   'WEIGHTS_SQ_HIGH pose')
  })

  // W2: Hand-band deviation costs more cosine than equal pose-band deviation.
  //     Both tmpl components have equal magnitude 0.5; we perturb the user's
  //     hand by 0.3 (scenario A) vs the user's pose by 0.3 (scenario B).
  //     With hand-emphasis weights, A should hurt cosine more than B.
  await test('W2: equal deviation — hand mismatch hurts more than pose mismatch', () => {
    const tmpl  = vec({ 0: 0.5, 126: 0.5 })
    const userA = vec({ 0: 0.2, 126: 0.5 })  // hand off by 0.3
    const userB = vec({ 0: 0.5, 126: 0.2 })  // pose off by 0.3

    const nT  = I._frameWeightedNorm(tmpl,  I.WEIGHTS_SQ_HIGH, 0, N)
    const nUA = I._frameWeightedNorm(userA, I.WEIGHTS_SQ_HIGH, 0, N)
    const nUB = I._frameWeightedNorm(userB, I.WEIGHTS_SQ_HIGH, 0, N)
    const simA = I._cosineSimilarityWeightedPrenormed(userA, tmpl, I.WEIGHTS_SQ_HIGH, 0, N, nUA, nT)
    const simB = I._cosineSimilarityWeightedPrenormed(userB, tmpl, I.WEIGHTS_SQ_HIGH, 0, N, nUB, nT)

    assert.ok(simA < simB,
      `expected hand-off sim ${simA} to be < pose-off sim ${simB} under hand-emphasis weights`)
  })

  // W3: Score uplift on a realistic "hand-correct, body-slightly-off" attempt.
  //     Under the old all-1.0 weights this kind of attempt produced a modest
  //     score; under new weights it should be modestly higher (not wildly).
  await test('W3: hand-correct + small pose/face drift → modest score uplift', () => {
    // Simulate: hand matches exactly, pose off by 0.15 per feature, face off by 0.15.
    const tmpl = vec({ 0: 1 })
    for (let i = 126; i < 162; i++) tmpl[i] = 0.4
    const user = Float32Array.from(tmpl)
    for (let i = 126; i < 162; i++) user[i] = 0.4 - 0.15  // small drift

    // Compare full-frame weighted cosine under HIGH weights (current)
    const nU = I._frameWeightedNorm(user, I.WEIGHTS_SQ_HIGH, 0, N)
    const nT = I._frameWeightedNorm(tmpl, I.WEIGHTS_SQ_HIGH, 0, N)
    const simHighNew = I._cosineSimilarityWeightedPrenormed(user, tmpl, I.WEIGHTS_SQ_HIGH, 0, N, nU, nT)
    const scoreHighNew = I._simToScore(simHighNew, 'high')

    // Compute the same under all-1.0 weights (simulates pre-Fix2 world)
    const WEIGHTS_SQ_ALL_ONE = new Float32Array(N).fill(1)
    const nU1 = I._frameWeightedNorm(user, WEIGHTS_SQ_ALL_ONE, 0, N)
    const nT1 = I._frameWeightedNorm(tmpl, WEIGHTS_SQ_ALL_ONE, 0, N)
    const simHighOld = I._cosineSimilarityWeightedPrenormed(user, tmpl, WEIGHTS_SQ_ALL_ONE, 0, N, nU1, nT1)
    const scoreHighOld = I._simToScore(simHighOld, 'high')

    // New score should be >= old score (emphasizing the correct hand helps)
    // AND the uplift should be modest — not above 100, not by more than 40
    // points (that would suggest we over-tuned toward WEIGHTS_LOW).
    assert.ok(scoreHighNew >= scoreHighOld,
      `new weights should not score lower than old — new=${scoreHighNew}, old=${scoreHighOld}`)
    assert.ok(scoreHighNew - scoreHighOld <= 40,
      `uplift should be modest — new=${scoreHighNew}, old=${scoreHighOld} (diff=${scoreHighNew - scoreHighOld})`)
  })

  // ══════════════════════════════════════════════════════════════════════
  // L — Fix 3: per-band debug:score emission + tracking:degraded
  // ══════════════════════════════════════════════════════════════════════

  // L1: debug:score fires when similarity is below the 0.65 threshold.
  await test('L1a: debug:score EMITS when selected sim < 0.65', () => {
    // Construct a low-similarity scenario: user points along feature 0, tmpl
    // points mostly along feature 2 (orthogonal) with a small overlap.
    const user = vec({ 0: 1 })
    const tmpl = vec({ 0: 0.55, 2: Math.sqrt(1 - 0.55 * 0.55) })  // cosine 0.55
    const engine = stubEngine([makeTemplate('LO', tmpl, 'high')], 'LO', user)
    const captured = capture(engine)
    engine._compareAndScore()
    assert.strictEqual(captured.debugScore.length, 1,
      `expected 1 debug:score emission on low-sim attempt, got ${captured.debugScore.length}`)
  })

  await test('L1b: debug:score does NOT emit on high-sim attempt', () => {
    const user = vec({ 0: 1 })
    const tmpl = vec({ 0: 1 })
    const engine = stubEngine([makeTemplate('HI', tmpl, 'high')], 'HI', user)
    const captured = capture(engine)
    engine._compareAndScore()
    assert.strictEqual(captured.debugScore.length, 0,
      `expected NO debug:score emission when sim is high, got ${captured.debugScore.length}`)
  })

  // L2: debug:score payload has all four per-band sims + meta fields.
  await test('L2: debug:score payload has all 4 bands and metadata', () => {
    const user = vec({ 0: 1 })
    const tmpl = vec({ 0: 0.5, 2: Math.sqrt(1 - 0.25) })
    const engine = stubEngine([makeTemplate('LO', tmpl, 'high')], 'LO', user)
    const captured = capture(engine)
    engine._compareAndScore()
    assert.strictEqual(captured.debugScore.length, 1)
    const d = captured.debugScore[0]
    assert.strictEqual(typeof d.perBandSim, 'object')
    assert.ok('domHand'    in d.perBandSim, 'domHand band missing')
    assert.ok('nonDomHand' in d.perBandSim, 'nonDomHand band missing')
    assert.ok('pose'       in d.perBandSim, 'pose band missing')
    assert.ok('face'       in d.perBandSim, 'face band missing')
    // Values in [-1, 1] (cosine range)
    for (const k of ['domHand','nonDomHand','pose','face']) {
      const v = d.perBandSim[k]
      assert.ok(v >= -1 - 1e-6 && v <= 1 + 1e-6, `${k} out of range: ${v}`)
    }
    assert.strictEqual(typeof d.overallSim, 'number')
    assert.strictEqual(typeof d.overallScore, 'number')
    assert.strictEqual(typeof d.skippedNonDom, 'boolean')
    assert.strictEqual(d.quality, 'high')
    assert.strictEqual(d.signKey, 'LO')
  })

  // L3: tracking:degraded fires when palm-fallback rate exceeds 20%.
  await test('L3: tracking:degraded fires when palm-fallback rate > 20%', () => {
    const engine = new SignPathEngine()
    const events = []
    engine.on('tracking:degraded', e => events.push(e))
    // Fill _originHistory with 10 palm + 10 shoulder (50%) → should fire.
    engine._originHistory = []
    for (let i = 0; i < 10; i++) engine._originHistory.push('palm')
    for (let i = 0; i < 10; i++) engine._originHistory.push('shoulder')
    engine._lastDegradedEmit = -1e12  // "long ago" — clears the 2000ms cooldown  // no cooldown in effect
    engine._maybeEmitDegraded()
    assert.strictEqual(events.length, 1, `expected 1 degraded emit, got ${events.length}`)
    assert.strictEqual(events[0].reason, 'shoulders_not_visible')
    assert.ok(events[0].palmFallbackRate > 0.20,
      `expected palmFallbackRate > 0.20, got ${events[0].palmFallbackRate}`)
  })

  await test('L3b: tracking:degraded does NOT fire at 10% palm rate (under threshold)', () => {
    const engine = new SignPathEngine()
    const events = []
    engine.on('tracking:degraded', e => events.push(e))
    engine._originHistory = []
    for (let i = 0; i < 3; i++)  engine._originHistory.push('palm')
    for (let i = 0; i < 27; i++) engine._originHistory.push('shoulder')  // 3/30 = 10%
    engine._lastDegradedEmit = -1e12  // "long ago" — clears the 2000ms cooldown
    engine._maybeEmitDegraded()
    assert.strictEqual(events.length, 0, 'must not emit at 10% palm rate')
  })

  await test('L3c: tracking:degraded does NOT fire with <15 frames (warm-up)', () => {
    const engine = new SignPathEngine()
    const events = []
    engine.on('tracking:degraded', e => events.push(e))
    engine._originHistory = ['palm','palm','palm','palm','palm']  // 100% palm but only 5 frames
    engine._lastDegradedEmit = -1e12  // "long ago" — clears the 2000ms cooldown
    engine._maybeEmitDegraded()
    assert.strictEqual(events.length, 0, 'must warm up to 15 frames before emitting')
  })

  // L4: rate-limiting — at most one emit per 2000ms.
  await test('L4: tracking:degraded rate-limited to once per 2000ms', () => {
    const engine = new SignPathEngine()
    const events = []
    engine.on('tracking:degraded', e => events.push(e))
    engine._originHistory = []
    for (let i = 0; i < 20; i++) engine._originHistory.push('palm')
    engine._lastDegradedEmit = -1e12  // "long ago" — clears the 2000ms cooldown
    engine._maybeEmitDegraded()  // fires
    engine._maybeEmitDegraded()  // rate-limited (same ms)
    engine._maybeEmitDegraded()  // still rate-limited
    assert.strictEqual(events.length, 1,
      `expected 1 emit (rate-limit holds), got ${events.length}`)
    // Simulate 2001ms passing → next call should fire again.
    engine._lastDegradedEmit = (typeof performance !== 'undefined' && performance.now)
      ? performance.now() - 2001
      : Date.now() - 2001
    engine._maybeEmitDegraded()
    assert.strictEqual(events.length, 2,
      `expected 2 emits after cooldown elapsed, got ${events.length}`)
  })

  // L5: API facade forwards both new events.
  await test('L5: API facade EVENT_OWNERS registers debug:score + tracking:degraded', () => {
    // Load signpath-api.js so its EVENT_OWNERS map is populated on the SignPathApp class.
    require('./signpath-api.js')
    const { SignPathApp } = require('./signpath-api.js')
    const owners = SignPathApp._eventOwners
    assert.strictEqual(owners['debug:score'], 'engine',
      `debug:score should be owned by engine, got ${owners['debug:score']}`)
    assert.strictEqual(owners['tracking:degraded'], 'engine',
      `tracking:degraded should be owned by engine, got ${owners['tracking:degraded']}`)
  })

  // ══════════════════════════════════════════════════════════════════════
  // LF — [Leniency] Fix 1: finger-score curve (FINGER_SIM_FLOOR/CEILING)
  // ══════════════════════════════════════════════════════════════════════

  // LF1: a clearly-recognisable finger (cosine 0.80) should score ≥85.
  await test('LF1: finger cosine 0.80 maps to score ≥85 under new curve', () => {
    const score = I._fingerSimToScore(0.80)
    assert.ok(score >= 85, `expected score >= 85 for sim 0.80, got ${score}`)
    // Golden number: (0.80-0.40)/(0.85-0.40)*100 = 40/45*100 = 88.89 → 89
    assert.strictEqual(score, 89)
  })

  // LF2: middle-of-range finger lands in [20, 40].
  await test('LF2: finger cosine 0.50 maps into [20, 40]', () => {
    const score = I._fingerSimToScore(0.50)
    assert.ok(score >= 20 && score <= 40,
      `expected 20 <= score <= 40 for sim 0.50, got ${score}`)
    // Golden: (0.50-0.40)/0.45*100 = 22.22 → 22
    assert.strictEqual(score, 22)
  })

  // LF3: floor and ceiling clamps
  await test('LF3: finger curve clamps at floor and ceiling', () => {
    assert.strictEqual(I._fingerSimToScore(0.40), 0)   // at floor
    assert.strictEqual(I._fingerSimToScore(0.30), 0)   // below floor
    assert.strictEqual(I._fingerSimToScore(0.85), 100) // at ceiling
    assert.strictEqual(I._fingerSimToScore(0.95), 100) // above ceiling
  })

  // ══════════════════════════════════════════════════════════════════════
  // LO — [Leniency] Fix 2: overall score curve (high-tier 0.45/0.88)
  // ══════════════════════════════════════════════════════════════════════

  // LO1: a 0.65 cosine on the overall (high) curve should score ≥40.
  await test('LO1: overall cosine 0.65 maps to score ≥40 on high tier', () => {
    const score = I._simToScore(0.65, 'high')
    assert.ok(score >= 40, `expected score >= 40 for sim 0.65, got ${score}`)
    // Golden: (0.65-0.45)/0.43*100 = 46.51 → 47
    assert.strictEqual(score, 47)
  })

  // LO2: a strong attempt (cosine 0.85) scores ≥90.
  await test('LO2: overall cosine 0.85 maps to score ≥90 on high tier', () => {
    const score = I._simToScore(0.85, 'high')
    assert.ok(score >= 90, `expected score >= 90 for sim 0.85, got ${score}`)
    // Golden: (0.85-0.45)/0.43*100 = 93.02 → 93
    assert.strictEqual(score, 93)
  })

  // LO3: threshold constants on the exposed API match the intent.
  await test('LO3: SIM_THRESHOLDS.high has new floor/ceiling, passAt unchanged', () => {
    assert.strictEqual(I.SIM_THRESHOLDS.high.floor, 0.45)
    assert.strictEqual(I.SIM_THRESHOLDS.high.ceiling, 0.88)
    assert.strictEqual(I.SIM_THRESHOLDS.high.passAt, 70,
      'passAt stays at 70 — only the curve shape loosens, not the pass bar')
    // Low tier intentionally untouched.
    assert.strictEqual(I.SIM_THRESHOLDS.low.floor, 0.40)
    assert.strictEqual(I.SIM_THRESHOLDS.low.ceiling, 0.85)
    assert.strictEqual(I.SIM_THRESHOLDS.low.passAt, 55)
  })

  // ══════════════════════════════════════════════════════════════════════
  // SB — [Leniency] Fix 3: shoulder-estimated origin middle-path
  // ══════════════════════════════════════════════════════════════════════

  // Helper: build a pose landmark array MediaPipe-style. We care about
  // indices 0 (nose), 11 (left shoulder), 12 (right shoulder). Fill the rest
  // with placeholders so the guard `pose.length > 16` passes.
  function buildPose({ lShoulder, rShoulder, nose }) {
    const pose = new Array(33)
    for (let i = 0; i < 33; i++) pose[i] = { x: 0, y: 0, z: 0, visibility: 0 }
    if (nose)      pose[0]  = Object.assign({ x: 0, y: 0, z: 0, visibility: 1 }, nose)
    if (lShoulder) pose[11] = Object.assign({ x: 0, y: 0, z: 0, visibility: 1 }, lShoulder)
    if (rShoulder) pose[12] = Object.assign({ x: 0, y: 0, z: 0, visibility: 1 }, rShoulder)
    return pose
  }

  // SB1: one shoulder visible, other cropped, nose visible → shoulder_estimated.
  await test('SB1: one shoulder visible (0.8), other cropped (0.2), nose visible → shoulder_estimated', () => {
    const pose = buildPose({
      lShoulder: { x: 0.30, y: 0.40, z: 0, visibility: 0.8 },
      rShoulder: { x: 0.70, y: 0.40, z: 0, visibility: 0.2 },  // partially cropped
      nose:      { x: 0.50, y: 0.25, z: 0, visibility: 0.9 },
    })
    const o = I._pickOrigin(pose, null, null)
    assert.ok(o, 'should return an origin')
    assert.strictEqual(o.refType, 'shoulder_estimated',
      `expected shoulder_estimated, got ${o ? o.refType : 'none'}`)
    // Estimated right shoulder: mirror of left about nose.x → 2*0.50 - 0.30 = 0.70.
    // Midpoint x: (0.30 + 0.70) / 2 = 0.50 (coincides with nose x, as symmetry implies).
    assert.ok(Math.abs(o.ox - 0.50) < 1e-6, `origin x should be 0.50, got ${o.ox}`)
    assert.ok(o.scale > 0.01, 'scale should be above MIN_SHOULDER_W')
  })

  // SB1b: mirror check the other way — right visible, left cropped.
  await test('SB1b: right shoulder visible, left cropped → shoulder_estimated (mirror other side)', () => {
    const pose = buildPose({
      lShoulder: { x: 0.30, y: 0.40, z: 0, visibility: 0.2 },  // cropped
      rShoulder: { x: 0.70, y: 0.40, z: 0, visibility: 0.8 },
      nose:      { x: 0.50, y: 0.25, z: 0, visibility: 0.9 },
    })
    const o = I._pickOrigin(pose, null, null)
    assert.ok(o && o.refType === 'shoulder_estimated')
  })

  // SB2: neither shoulder visible and no nose-based recovery path → palm.
  await test('SB2: no shoulders + no nose → falls back to palm', () => {
    const pose = buildPose({
      lShoulder: { x: 0.30, y: 0.40, z: 0, visibility: 0.1 },
      rShoulder: { x: 0.70, y: 0.40, z: 0, visibility: 0.1 },
      nose:      { x: 0.50, y: 0.25, z: 0, visibility: 0.1 },  // nose also not visible
    })
    const rHand = []
    // Need 10 landmarks for palm fallback; index 0 wrist, index 9 middle MCP.
    for (let i = 0; i < 21; i++) rHand.push({ x: 0.50, y: 0.50, z: 0 })
    rHand[0] = { x: 0.50, y: 0.50, z: 0 }
    rHand[9] = { x: 0.52, y: 0.52, z: 0 }  // distance ~0.028 > MIN_PALM
    const o = I._pickOrigin(pose, rHand, null)
    assert.ok(o, 'should return a palm origin')
    assert.strictEqual(o.refType, 'palm')
  })

  // SB3: tracking:degraded must NOT fire when origin is shoulder_estimated.
  await test('SB3: tracking:degraded does NOT fire for shoulder_estimated (acceptable mode)', () => {
    const engine = new SignPathEngine()
    const events = []
    engine.on('tracking:degraded', e => events.push(e))
    // All 30 frames use the new middle path — good framing for sitting users.
    engine._originHistory = []
    for (let i = 0; i < 30; i++) engine._originHistory.push('shoulder_estimated')
    engine._lastDegradedEmit = -1e12  // clear cooldown
    engine._maybeEmitDegraded()
    assert.strictEqual(events.length, 0,
      'shoulder_estimated is not degraded — banner must not fire')
  })

  // SB4: still fire when PALM is dominant even if some estimated mixed in.
  await test('SB4: tracking:degraded still fires when palm > 20% (estimated frames do not mask)', () => {
    const engine = new SignPathEngine()
    const events = []
    engine.on('tracking:degraded', e => events.push(e))
    engine._originHistory = []
    for (let i = 0; i < 10; i++) engine._originHistory.push('palm')
    for (let i = 0; i < 10; i++) engine._originHistory.push('shoulder_estimated')
    for (let i = 0; i < 10; i++) engine._originHistory.push('shoulder')
    engine._lastDegradedEmit = -1e12
    engine._maybeEmitDegraded()
    assert.strictEqual(events.length, 1,
      'palm count alone (10/30 = 33%) must still cross the 20% threshold')
  })

  // SB5: primary path still wins when both shoulders confidently visible.
  await test('SB5: both shoulders visible → refType="shoulder" (primary path unchanged)', () => {
    const pose = buildPose({
      lShoulder: { x: 0.30, y: 0.40, z: 0, visibility: 0.9 },
      rShoulder: { x: 0.70, y: 0.40, z: 0, visibility: 0.9 },
      nose:      { x: 0.50, y: 0.25, z: 0, visibility: 0.9 },
    })
    const o = I._pickOrigin(pose, null, null)
    assert.ok(o && o.refType === 'shoulder', `expected shoulder (primary), got ${o && o.refType}`)
  })

  console.log(`\n${_passed} passed, ${_failures} failed`)
  if (_failures) process.exit(1)
}

run().catch(e => { console.error('Test runner crashed:', e); process.exit(1) })
