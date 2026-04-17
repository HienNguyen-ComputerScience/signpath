/**
 * Tests for the two-tier template quality system in signpath-engine.js.
 * Run: node signpath-engine-quality.test.js
 *
 * Strategy: engine constructor has no browser deps, so we can instantiate
 * it in Node and populate its internals manually. Each integration test
 * stubs _templates + _frameBuffer + _activeSign then calls _compareAndScore
 * directly, capturing the emitted score event.
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

// ─── Vector helpers ──────────────────────────────────────────────────

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

function makeTemplate(gloss, meanVec, quality) {
  const mean = repeatFrame(meanVec)
  const wSq = quality === 'low' ? I.WEIGHTS_SQ_LOW : I.WEIGHTS_SQ_HIGH
  const fullNorms = new Float32Array(mean.length)
  for (let f = 0; f < mean.length; f++) fullNorms[f] = I._frameWeightedNorm(mean[f], wSq, 0, N)
  return { gloss, mean, fullNorms, quality, sampleCount: 50, consistency: 0.9 }
}

function stubEngine(templateDefs, activeSign, userVec) {
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
  engine._frameBuffer = repeatFrame(userVec)
  engine._smoothedScore = null
  engine._lastCompareTime = 0
  return engine
}

function captureScore(engine) {
  const events = []
  engine.on('score', e => events.push(e))
  engine._compareAndScore()
  return events[events.length - 1]
}

// ─── Tests ───────────────────────────────────────────────────────────

async function run() {
  console.log('signpath-engine (quality tier)')

  // A. _simToScore table for both tiers
  await test('A: _simToScore high/low table', () => {
    // High: floor=0.55, ceiling=0.95
    assert.strictEqual(I._simToScore(0.55, 'high'), 0)
    assert.strictEqual(I._simToScore(0.95, 'high'), 100)
    assert.strictEqual(I._simToScore(0.40, 'high'), 0)   // below floor clamps to 0
    assert.strictEqual(I._simToScore(0.75, 'high'), 50)  // midpoint
    // Low: floor=0.40, ceiling=0.85
    assert.strictEqual(I._simToScore(0.40, 'low'), 0)
    assert.strictEqual(I._simToScore(0.85, 'low'), 100)
    assert.strictEqual(I._simToScore(0.625, 'low'), 50) // midpoint
  })

  // B. _simToScore with missing/invalid quality THROWS
  await test('B: _simToScore throws without a valid quality tier', () => {
    assert.throws(() => I._simToScore(0.7))
    assert.throws(() => I._simToScore(0.7, null))
    assert.throws(() => I._simToScore(0.7, 'medium'))
    assert.throws(() => I._simToScore(0.7, ''))
  })

  // C. Same similarity: low mapping gives a higher numeric score
  await test('C: sim 0.7 → low score > high score', () => {
    const hi = I._simToScore(0.7, 'high')
    const lo = I._simToScore(0.7, 'low')
    assert.ok(lo > hi, `expected lo > hi, got hi=${hi} lo=${lo}`)
    // concrete values for golden check. Note: on paper (0.70-0.55)/0.40*100
    // is 37.5, but IEEE-754 makes the computed value 37.4999… so Math.round
    // returns 37, not 38. Don't "fix" this — just assert the real value.
    // high: ≈ 37.499… → 37
    // low:  ≈ 66.66… → 67
    assert.strictEqual(hi, 37)
    assert.strictEqual(lo, 67)
  })

  // D. Weighted cosine on identical / orthogonal vectors
  await test('D: weighted cosine — identical → 1, orthogonal → 0', () => {
    const a = vec({ 0: 1, 1: 0 })
    const b = vec({ 0: 1, 1: 0 })
    const c = vec({ 0: 0, 1: 1 })
    const wSq = I.WEIGHTS_SQ_HIGH
    const na = I._frameWeightedNorm(a, wSq, 0, N)
    const nb = I._frameWeightedNorm(b, wSq, 0, N)
    const nc = I._frameWeightedNorm(c, wSq, 0, N)
    assert.ok(Math.abs(I._cosineSimilarityWeightedPrenormed(a, b, wSq, 0, N, na, nb) - 1) < 1e-6)
    assert.ok(Math.abs(I._cosineSimilarityWeightedPrenormed(a, c, wSq, 0, N, na, nc) - 0) < 1e-6)
  })

  // E. Hands-match + pose-off → LOW sim > HIGH sim on same vectors
  await test('E: hand match + pose mismatch → low weights produce higher sim', () => {
    // user: hand at feature 0, pose at feature 126.
    // tmpl: hand matches at feature 0, pose orthogonal at feature 127.
    const user = vec({ 0: 1, 126: 1 })
    const tmpl = vec({ 0: 1, 127: 1 })
    const nUH = I._frameWeightedNorm(user, I.WEIGHTS_SQ_HIGH, 0, N)
    const nTH = I._frameWeightedNorm(tmpl, I.WEIGHTS_SQ_HIGH, 0, N)
    const nUL = I._frameWeightedNorm(user, I.WEIGHTS_SQ_LOW, 0, N)
    const nTL = I._frameWeightedNorm(tmpl, I.WEIGHTS_SQ_LOW, 0, N)
    const simHi = I._cosineSimilarityWeightedPrenormed(user, tmpl, I.WEIGHTS_SQ_HIGH, 0, N, nUH, nTH)
    const simLo = I._cosineSimilarityWeightedPrenormed(user, tmpl, I.WEIGHTS_SQ_LOW, 0, N, nUL, nTL)
    assert.ok(simLo > simHi, `low ${simLo} should exceed high ${simHi}`)
    // Golden values (derivable by hand — see QUALITY_TIER_REPORT.md):
    //   simHi = 1 / (sqrt(2) * sqrt(2)) = 0.5
    //   simLo = 2.25 / (sqrt(2.34) * sqrt(2.34)) ≈ 0.9615
    assert.ok(Math.abs(simHi - 0.5) < 1e-6)
    assert.ok(Math.abs(simLo - (2.25 / 2.34)) < 1e-6)
  })

  // F. Template normalization: missing → high, low → low, garbage → high
  await test('F: _normalizeQuality (missing/low/garbage)', () => {
    assert.strictEqual(I._normalizeQuality(undefined), 'high')
    assert.strictEqual(I._normalizeQuality(null), 'high')
    assert.strictEqual(I._normalizeQuality('high'), 'high')
    assert.strictEqual(I._normalizeQuality('low'), 'low')
    assert.strictEqual(I._normalizeQuality('medium'), 'high')
    assert.strictEqual(I._normalizeQuality(''), 'high')
    assert.strictEqual(I._normalizeQuality(123), 'high')
  })

  // G. getTemplateQuality returns tier, null for unknown
  await test('G: getTemplateQuality returns tier or null', () => {
    const engine = stubEngine([
      makeTemplate('HQ', vec({ 0: 1 }), 'high'),
      makeTemplate('LQ', vec({ 0: 1 }), 'low'),
    ], 'HQ', vec({ 0: 1 }))
    assert.strictEqual(engine.getTemplateQuality('HQ'), 'high')
    assert.strictEqual(engine.getTemplateQuality('LQ'), 'low')
    assert.strictEqual(engine.getTemplateQuality('unknown'), null)
  })

  // H. Star thresholds
  await test('H: _starsForScore thresholds per tier, throws on missing', () => {
    // high: 50/70/88
    assert.strictEqual(I._starsForScore(49,  'high'), 0)
    assert.strictEqual(I._starsForScore(50,  'high'), 1)
    assert.strictEqual(I._starsForScore(69,  'high'), 1)
    assert.strictEqual(I._starsForScore(70,  'high'), 2)
    assert.strictEqual(I._starsForScore(87,  'high'), 2)
    assert.strictEqual(I._starsForScore(88,  'high'), 3)
    assert.strictEqual(I._starsForScore(100, 'high'), 3)
    // low: 55/70/80
    assert.strictEqual(I._starsForScore(54,  'low'), 0)
    assert.strictEqual(I._starsForScore(55,  'low'), 1)
    assert.strictEqual(I._starsForScore(69,  'low'), 1)
    assert.strictEqual(I._starsForScore(70,  'low'), 2)
    assert.strictEqual(I._starsForScore(79,  'low'), 2)
    assert.strictEqual(I._starsForScore(80,  'low'), 3)
    // mandatory quality
    assert.throws(() => I._starsForScore(100))
    assert.throws(() => I._starsForScore(100, 'bogus'))
  })

  // I. _compareAndScore emits quality/passed/passAt/deviations.templateQuality
  await test('I: score event includes quality, passed, passAt', () => {
    // Active sign = HQ; user matches HQ exactly → sim=1, score=100 on high = passed.
    const engine = stubEngine([
      makeTemplate('HQ', vec({ 0: 1 }), 'high'),
    ], 'HQ', vec({ 0: 1 }))
    const ev = captureScore(engine)
    assert.strictEqual(ev.quality, 'high')
    assert.strictEqual(ev.passAt, 70)
    assert.strictEqual(ev.passed, true)
    assert.strictEqual(ev.score, 100)
    assert.strictEqual(ev.isMatch, true)
    assert.ok(ev.deviations)
    assert.strictEqual(ev.deviations.templateQuality, 'high')
  })

  // J. passed flips at passAt for both tiers
  await test('J: passed flips across passAt (both tiers)', () => {
    // High tier: sim=0.83 → score = round((0.83-0.55)/0.4*100) = round(70) = 70 → passed
    {
      const user = vec({ 0: 1 })
      // Build a template whose sim with user is exactly 0.83: tmpl = [0.83, sqrt(1-0.83²), 0,...] is unit.
      const s = 0.83
      const tmpl = vec({ 0: s, 1: Math.sqrt(1 - s * s) })
      const engine = stubEngine([makeTemplate('HQ', tmpl, 'high')], 'HQ', user)
      const ev = captureScore(engine)
      assert.strictEqual(ev.quality, 'high')
      assert.strictEqual(ev.score, 70)
      assert.strictEqual(ev.passAt, 70)
      assert.strictEqual(ev.passed, true)
    }
    // High tier: sim=0.82 → score = round((0.82-0.55)/0.4*100) = round(67.5) = 68 → not passed
    {
      const user = vec({ 0: 1 })
      const s = 0.82
      const tmpl = vec({ 0: s, 1: Math.sqrt(1 - s * s) })
      const engine = stubEngine([makeTemplate('HQ', tmpl, 'high')], 'HQ', user)
      const ev = captureScore(engine)
      assert.strictEqual(ev.passed, false, `expected not passed at score=${ev.score}`)
    }
    // Low tier: sim=0.6475 → score = round((0.6475-0.40)/0.45*100) = 55 → passed
    {
      const user = vec({ 0: 1 })
      const s = 0.6475
      const tmpl = vec({ 0: s, 1: Math.sqrt(1 - s * s) })
      const engine = stubEngine([makeTemplate('LQ', tmpl, 'low')], 'LQ', user)
      const ev = captureScore(engine)
      assert.strictEqual(ev.quality, 'low')
      assert.strictEqual(ev.passAt, 55)
      assert.ok(ev.passed, `expected passed at score=${ev.score}`)
    }
    // Low tier just below passAt
    {
      const user = vec({ 0: 1 })
      const s = 0.64
      const tmpl = vec({ 0: s, 1: Math.sqrt(1 - s * s) })
      const engine = stubEngine([makeTemplate('LQ', tmpl, 'low')], 'LQ', user)
      const ev = captureScore(engine)
      assert.strictEqual(ev.quality, 'low')
      assert.ok(!ev.passed, `expected NOT passed at score=${ev.score}`)
    }
  })

  // K. Top-5 ranks by similarity — the highest-value test.
  //    HQ template: sim=0.80 → score=63 (high tier)
  //    LQ template: sim=0.75 → score=78 (low tier, more generous mapping)
  //    LQ has the higher NUMERIC score but LOWER similarity. We must rank HQ first.
  await test('K: top-5 ranks by similarity — LQ higher score does not leapfrog HQ higher sim', () => {
    const user = vec({ 0: 1 })
    // HQ template: V = [0.80, 0.60] — cos(U, V) = 0.80
    const hq = vec({ 0: 0.80, 1: 0.60 })
    // LQ template: W = [0.75, sqrt(1-0.75²)] — cos(U, W) = 0.75
    const lq = vec({ 0: 0.75, 1: Math.sqrt(1 - 0.75 * 0.75) })
    const engine = stubEngine([
      makeTemplate('HQ_sign', hq, 'high'),
      makeTemplate('LQ_sign', lq, 'low'),
    ], 'HQ_sign', user)

    const ev = captureScore(engine)

    // Verify the numeric conflict actually exists
    const hqRow = ev.top5.find(r => r.gloss === 'HQ_sign')
    const lqRow = ev.top5.find(r => r.gloss === 'LQ_sign')
    assert.ok(hqRow && lqRow, 'both templates must appear in top5')
    assert.ok(hqRow.similarity > lqRow.similarity,
      `premise: HQ sim ${hqRow.similarity} must exceed LQ sim ${lqRow.similarity}`)
    assert.ok(lqRow.score > hqRow.score,
      `premise: LQ score ${lqRow.score} must exceed HQ score ${hqRow.score}`)
    // The actual assertion: similarity wins over score for ranking
    assert.strictEqual(ev.top5[0].gloss, 'HQ_sign', 'top-1 must be HQ despite LQ higher score')
    // Sanity: prediction is the top-1
    assert.strictEqual(ev.prediction.gloss, 'HQ_sign')
  })

  // L. isMatch includes the pass check
  await test('L: selected sign that passes its tier is isMatch even when not top-1', () => {
    // Setup: active = LQ_pass (sim=0.65 with user → LQ score = 56 ≥ passAt 55).
    // Top-1 is HQ_better (sim=0.75 with user). LQ_pass ranks #2.
    // Classic isMatch branches all FALSE for LQ_pass:
    //   - rank===0? no (rank 1)
    //   - top1Sim - selected.sim = 0.10 > 0.03? no (no, wait, 0.75 - 0.65 = 0.10, NOT < 0.03). So no.
    //   - rank<=2 && sim>0.7? selected.sim=0.65 NOT > 0.7. So no.
    // Only the new pass-check makes isMatch true.
    const user = vec({ 0: 1 })
    const hqBetter = vec({ 0: 0.75, 1: Math.sqrt(1 - 0.75 * 0.75) })
    const lqPass = vec({ 0: 0.65, 1: Math.sqrt(1 - 0.65 * 0.65) })
    const engine = stubEngine([
      makeTemplate('HQ_better', hqBetter, 'high'),
      makeTemplate('LQ_pass', lqPass, 'low'),
    ], 'LQ_pass', user)
    const ev = captureScore(engine)
    // Verify the classic branches don't match
    assert.strictEqual(ev.top5[0].gloss, 'HQ_better', 'HQ_better should be rank 1 by sim')
    const lqRow = ev.top5.find(r => r.gloss === 'LQ_pass')
    assert.ok((ev.top5[0].similarity - lqRow.similarity) > 0.03, 'margin must exceed 0.03')
    assert.ok(lqRow.similarity <= 0.7, 'selected sim must not clear the top-3 0.7 branch')
    // Verify passed is the reason isMatch is true
    assert.strictEqual(ev.passed, true)
    assert.strictEqual(ev.isMatch, true)
  })

  // M. deviations.templateQuality
  await test('M: deviations.templateQuality reflects selected sign', () => {
    const engineLow = stubEngine(
      [makeTemplate('LQ', vec({ 0: 1 }), 'low')],
      'LQ',
      vec({ 0: 1 })
    )
    const evLow = captureScore(engineLow)
    assert.strictEqual(evLow.deviations.templateQuality, 'low')

    const engineHigh = stubEngine(
      [makeTemplate('HQ', vec({ 0: 1 }), 'high')],
      'HQ',
      vec({ 0: 1 })
    )
    const evHigh = captureScore(engineHigh)
    assert.strictEqual(evHigh.deviations.templateQuality, 'high')
  })

  // N. Per-finger scores use quality-aware mapping
  await test('N: per-finger scores pick up the tier-specific mapping', () => {
    // Build user + template where the thumb-landmark (indices 1-4) similarity
    // is 0.7 — so the per-finger mapping diff is identical to test C.
    // Thumb occupies dominant-hand features at indices (1*3..4*3+2) = 3..14.
    // Set user thumb = [1, 0, ...12 floats...], tmpl thumb = [0.7, 0.7141, ...]
    // (unit vectors in first two thumb floats).
    const user = vec({ 3: 1 })
    const thumbTmplLow = vec({ 3: 0.7, 4: Math.sqrt(1 - 0.49) })

    const engine = new SignPathEngine()
    engine._templates = {
      TEST: {
        mean: repeatFrame(thumbTmplLow),
        fullNorms: (() => {
          const arr = new Float32Array(FRAME_COUNT)
          const mean = repeatFrame(thumbTmplLow)
          for (let f = 0; f < mean.length; f++) arr[f] = I._frameWeightedNorm(mean[f], I.WEIGHTS_SQ_LOW, 0, N)
          return arr
        })(),
        quality: 'low',
        sampleCount: 1, consistency: 0.5,
      }
    }
    engine._templateFrameCount = FRAME_COUNT
    const userFrames = repeatFrame(user)
    // Direct call — sidesteps _compareAndScore's frame buffer resampling.
    const scoresLow = engine._computeFingerScores(userFrames, 'TEST', 'low')
    const scoresHigh = engine._computeFingerScores(userFrames, 'TEST', 'high')
    // The thumb group (indices 1,2,3,4) should have cosine similarity of 0.7.
    const thumbLow = scoresLow.find(f => f.name === 'Cái' || f.name === 'Thumb')
    const thumbHigh = scoresHigh.find(f => f.name === 'Cái' || f.name === 'Thumb')
    assert.ok(thumbLow && thumbHigh)
    // sim ≈ 0.7 → high score 37 (IEEE float rounding, see test C),
    //           low score 67. Asserting the real numbers, not the textbook ones.
    assert.strictEqual(thumbHigh.score, 37)
    assert.strictEqual(thumbLow.score, 67)
  })

  // Bonus: init-side behaviour — template without quality field loads as high.
  await test('F2 (smoke): loader shape — template missing quality field → quality=high', () => {
    // This doesn't call init (which needs fetch + camera). It verifies the
    // one-liner logic via _normalizeQuality, mirroring what init does.
    const rawTemplates = {
      'Foo': { mean: [[1, 2, 3]], sampleCount: 1, consistency: 0.5 },
      'Bar': { mean: [[1, 2, 3]], sampleCount: 1, consistency: 0.5, quality: 'low' },
      'Baz': { mean: [[1, 2, 3]], sampleCount: 1, consistency: 0.5, quality: 'garbage' },
    }
    for (const k in rawTemplates) {
      const q = I._normalizeQuality(rawTemplates[k].quality)
      if (k === 'Bar') assert.strictEqual(q, 'low')
      else assert.strictEqual(q, 'high')
    }
  })

  console.log(`\n${_passed} passed, ${_failures} failed`)
  if (_failures) process.exit(1)
}

run().catch(e => { console.error('Test runner crashed:', e); process.exit(1) })
