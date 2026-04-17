/**
 * Tests for signpath-session.js
 * Run: node signpath-session.test.js
 *
 * No deps. Uses require() + the IIFE pattern's attach-to-this-which-is-
 * module.exports-in-Node trick.
 */
'use strict'

const assert = require('assert')
const { SignPathSession } = require('./signpath-session.js')

// ─── Test harness ────────────────────────────────────────────────────

let _failures = 0
let _passed = 0

async function test(name, fn) {
  try {
    await fn()
    _passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    _failures++
    console.error(`  ✗ ${name}`)
    console.error(`    ${e.message}`)
    if (process.env.DEBUG) console.error(e.stack)
  }
}

// ─── Mocks ───────────────────────────────────────────────────────────

class MockEngine {
  constructor() {
    this._listeners = {}
    this._activeSign = null
    this._lang = 'vi'
    this._selectCalls = []
  }
  on(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn) }
  off(ev, fn) { const a = this._listeners[ev]; if (a) this._listeners[ev] = a.filter(f => f !== fn) }
  emit(ev, data) { (this._listeners[ev] || []).forEach(fn => fn(data)) }
  selectSign(k) { this._selectCalls.push(k); this._activeSign = k }
  clearSign() { this._activeSign = null }
  getLang() { return this._lang }
}

class MockCoach {
  constructor() {
    this.localCalls = []
    this.remoteCalls = []
    this._remoteImpl = async () => null
    this._localImpl = (dev, score) => `local advice (score=${score})`
  }
  getLocalAdvice(dev, score, lang) {
    this.localCalls.push({ dev, score, lang })
    return this._localImpl(dev, score, lang)
  }
  async getAdvice(dev, score, lang, buf) {
    this.remoteCalls.push({ dev, score, lang, buf })
    return this._remoteImpl(dev, score, lang, buf)
  }
  setRemote(impl) { this._remoteImpl = impl }
}

// Build a realistic engine compare-case score event.
function compareScore(signKey, score, extras = {}) {
  return {
    signKey,
    score,
    prediction: { gloss: signKey, similarity: score / 100, score },
    top3: [{ gloss: signKey, score, similarity: score / 100 }],
    top5: [{ gloss: signKey, score, similarity: score / 100 }],
    fingerScores: [],
    deviations: {
      signKey,
      signEn: signKey,
      handPosition: { xError: 0, yError: 0, zError: 0 },
      positionIssues: [],
      fingers: [], worstFingers: [],
      twoHanded: { needed: false, present: false, issue: null },
      motion: { userMotion: 0.5, templateMotion: 0.5, issue: null },
      faceProximity: { isFaceSign: false, issue: null, userDist: 9, tmplDist: 9 },
    },
    feedback: 'OK', tier: 'Tốt lắm!', tierEmoji: '👍',
    isMatch: true,
    bufferFrames: 30,
    ...extras,
  }
}

// Build an engine "no-hand" event (prediction null, waiting tier).
function waitingScore(signKey) {
  return {
    signKey,
    score: 0,
    prediction: null,
    top3: [],
    fingerScores: [],
    feedback: 'Đưa tay vào camera.',
    tier: 'Đang chờ',
    tierEmoji: '👋',
  }
}

// ─── Tests ───────────────────────────────────────────────────────────

async function run() {
  console.log('SignPathSession')

  await test('peak score is the max across samples, not last or avg', async () => {
    const engine = new MockEngine()
    const coach = new MockCoach()
    const session = new SignPathSession(engine, coach, { defaultDurationMs: 10_000, tickMs: 9999 })
    const p = session.startAttempt('Mẹ')
    engine.emit('score', compareScore('Mẹ', 40))
    engine.emit('score', compareScore('Mẹ', 60))
    engine.emit('score', compareScore('Mẹ', 80))
    engine.emit('score', compareScore('Mẹ', 50))
    engine.emit('score', compareScore('Mẹ', 30))
    session.stopAttempt()
    const r = await p
    assert.strictEqual(r.finalScore, 80, `finalScore: expected 80, got ${r.finalScore}`)
    assert.strictEqual(r.peakScore, 80)
    assert.strictEqual(r.avgScore, Math.round((40 + 60 + 80 + 50 + 30) / 5))  // 52
    assert.strictEqual(r.stars, 2, 'score 80 → 2 stars (threshold 70..<88)')
    assert.ok(r.advice && r.advice.indexOf('80') !== -1, 'advice should flow through from coach')
    assert.strictEqual(r.reason, 'manual')
  })

  await test('star thresholds: 50→1, 70→2, 88→3, below 50 → 0', async () => {
    const engine = new MockEngine()
    const session = new SignPathSession(engine, null, { defaultDurationMs: 10_000, tickMs: 9999 })
    const cases = [
      { score: 100, stars: 3 },
      { score: 88, stars: 3 },
      { score: 87, stars: 2 },
      { score: 70, stars: 2 },
      { score: 69, stars: 1 },
      { score: 50, stars: 1 },
      { score: 49, stars: 0 },
      { score: 0, stars: 0 },
    ]
    for (const c of cases) {
      const p = session.startAttempt('Mẹ')
      engine.emit('score', compareScore('Mẹ', c.score))
      session.stopAttempt()
      const r = await p
      assert.strictEqual(r.stars, c.stars, `score ${c.score} should map to ${c.stars} stars, got ${r.stars}`)
    }
  })

  await test('abort: no score events received → no_signing_detected', async () => {
    const engine = new MockEngine()
    const session = new SignPathSession(engine, null, { defaultDurationMs: 10_000, tickMs: 9999 })
    const p = session.startAttempt('Mẹ')
    session.stopAttempt()
    const r = await p
    assert.strictEqual(r.aborted, true)
    assert.strictEqual(r.reason, 'no_signing_detected')
  })

  await test('abort: only waiting events received → no_signing_detected', async () => {
    const engine = new MockEngine()
    const session = new SignPathSession(engine, null, { defaultDurationMs: 10_000, tickMs: 9999 })
    const p = session.startAttempt('Mẹ')
    engine.emit('score', waitingScore('Mẹ'))
    engine.emit('score', waitingScore('Mẹ'))
    engine.emit('score', waitingScore('Mẹ'))
    session.stopAttempt()
    const r = await p
    assert.strictEqual(r.aborted, true)
    assert.strictEqual(r.reason, 'no_signing_detected')
  })

  await test('cancelAttempt → user_cancelled abort + null advice', async () => {
    const engine = new MockEngine()
    const session = new SignPathSession(engine, null, { defaultDurationMs: 10_000, tickMs: 9999 })
    const p = session.startAttempt('Mẹ')
    engine.emit('score', compareScore('Mẹ', 75))
    session.cancelAttempt()
    const r = await p
    assert.strictEqual(r.aborted, true)
    assert.strictEqual(r.reason, 'user_cancelled')
  })

  await test('manual stop fires attempt:end immediately (not waiting for duration)', async () => {
    const engine = new MockEngine()
    const session = new SignPathSession(engine, null, { defaultDurationMs: 60_000, tickMs: 9999 })
    let endFired = false
    session.on('attempt:end', () => { endFired = true })
    const p = session.startAttempt('Mẹ')
    engine.emit('score', compareScore('Mẹ', 75))
    assert.strictEqual(endFired, false, 'attempt:end should not have fired before stop')
    session.stopAttempt()
    const r = await p
    assert.strictEqual(endFired, true)
    assert.strictEqual(r.reason, 'manual')
  })

  await test('duration timeout fires attempt:end with reason=duration', async () => {
    const engine = new MockEngine()
    const session = new SignPathSession(engine, null, { defaultDurationMs: 30, tickMs: 9999 })
    const p = session.startAttempt('Mẹ')
    engine.emit('score', compareScore('Mẹ', 75))
    const r = await p
    assert.strictEqual(r.reason, 'duration')
    assert.strictEqual(r.finalScore, 75)
  })

  await test('ignores score events with prediction:null (waiting branch)', async () => {
    const engine = new MockEngine()
    const session = new SignPathSession(engine, null, { defaultDurationMs: 10_000, tickMs: 9999 })
    const p = session.startAttempt('Mẹ')
    engine.emit('score', waitingScore('Mẹ'))
    engine.emit('score', compareScore('Mẹ', 65))
    engine.emit('score', waitingScore('Mẹ'))
    session.stopAttempt()
    const r = await p
    assert.strictEqual(r.finalScore, 65)
    assert.strictEqual(r.avgScore, 65)
  })

  await test('ignores score events with tier=Đang chờ even if prediction is non-null', async () => {
    // Defensive case: a future engine refactor might set prediction but keep
    // the waiting tier. Both filters must fire.
    const engine = new MockEngine()
    const session = new SignPathSession(engine, null, { defaultDurationMs: 10_000, tickMs: 9999 })
    const p = session.startAttempt('Mẹ')
    engine.emit('score', compareScore('Mẹ', 0, { tier: 'Đang chờ' }))
    engine.emit('score', compareScore('Mẹ', 0, { tier: 'Waiting' }))
    engine.emit('score', compareScore('Mẹ', 72))
    session.stopAttempt()
    const r = await p
    assert.strictEqual(r.finalScore, 72)
  })

  await test('ignores score events for a different signKey', async () => {
    const engine = new MockEngine()
    const session = new SignPathSession(engine, null, { defaultDurationMs: 10_000, tickMs: 9999 })
    const p = session.startAttempt('Mẹ')
    engine.emit('score', compareScore('Bố', 99))
    engine.emit('score', compareScore('Mẹ', 55))
    session.stopAttempt()
    const r = await p
    assert.strictEqual(r.finalScore, 55)
  })

  await test('attemptId is unique across attempts and present on every event', async () => {
    const engine = new MockEngine()
    const session = new SignPathSession(engine, null, { defaultDurationMs: 10_000, tickMs: 9999 })
    const ids = new Set()
    const events = []
    session.on('attempt:start', e => events.push({ ev: 'start', id: e.attemptId }))
    session.on('attempt:end',   e => events.push({ ev: 'end',   id: e.attemptId }))
    for (let i = 0; i < 3; i++) {
      const p = session.startAttempt('Mẹ')
      engine.emit('score', compareScore('Mẹ', 80))
      session.stopAttempt()
      const r = await p
      assert.ok(r.attemptId, `result ${i} missing attemptId`)
      ids.add(r.attemptId)
    }
    assert.strictEqual(ids.size, 3, 'three attempts should have three distinct IDs')
    // Every emitted event should carry an ID
    for (const e of events) assert.ok(e.id, `event ${e.ev} missing attemptId`)
  })

  await test('startAttempt rejects while already active', async () => {
    const engine = new MockEngine()
    const session = new SignPathSession(engine, null, { defaultDurationMs: 10_000, tickMs: 9999 })
    session.startAttempt('Mẹ')
    let threw = false
    try { await session.startAttempt('Bố') } catch (e) { threw = true }
    assert.strictEqual(threw, true)
    session.cancelAttempt()
  })

  await test('startAttempt rejects with missing signKey', async () => {
    const engine = new MockEngine()
    const session = new SignPathSession(engine, null)
    let threw = false
    try { await session.startAttempt(null) } catch (e) { threw = true }
    assert.strictEqual(threw, true)
  })

  await test('tick event: livePreviewScore is rolling max over last 3 samples', async () => {
    const engine = new MockEngine()
    const session = new SignPathSession(engine, null, { defaultDurationMs: 10_000, tickMs: 15 })
    const ticks = []
    session.on('attempt:tick', t => ticks.push(t))
    session.startAttempt('Mẹ')
    engine.emit('score', compareScore('Mẹ', 50))
    engine.emit('score', compareScore('Mẹ', 80))
    engine.emit('score', compareScore('Mẹ', 65))
    // Window is now [50, 80, 65] → max = 80
    await new Promise(r => setTimeout(r, 40))
    session.cancelAttempt()
    assert.ok(ticks.length > 0, 'should have received at least one tick')
    const lastRelevant = ticks.find(t => t.livePreviewScore === 80)
    assert.ok(lastRelevant, 'a tick should report livePreviewScore=80 (max of window)')
    // After one more sample, the window slides to [80, 65, X]
    // (We can't reliably test that here without more timing control; the max-of-3
    //  behaviour is what matters.)
  })

  await test('tick event carries bufferFrames from last processed score', async () => {
    const engine = new MockEngine()
    const session = new SignPathSession(engine, null, { defaultDurationMs: 10_000, tickMs: 15 })
    const ticks = []
    session.on('attempt:tick', t => ticks.push(t))
    session.startAttempt('Mẹ')
    engine.emit('score', compareScore('Mẹ', 60, { bufferFrames: 45 }))
    await new Promise(r => setTimeout(r, 30))
    session.cancelAttempt()
    const relevant = ticks.find(t => t.bufferFrames === 45)
    assert.ok(relevant, 'a tick should report bufferFrames=45 from last compare-case event')
  })

  await test('attempt:coach-update fires after end when remote returns', async () => {
    const engine = new MockEngine()
    const coach = new MockCoach()
    coach.setRemote(async () => 'upgraded remote advice')
    const session = new SignPathSession(engine, coach, { defaultDurationMs: 10_000, tickMs: 9999 })
    let updateEvent = null
    const endBeforeUpdate = { seen: false }
    session.on('attempt:end', () => { endBeforeUpdate.seen = true })
    session.on('attempt:coach-update', e => {
      updateEvent = e
      assert.strictEqual(endBeforeUpdate.seen, true, 'end must fire before coach-update')
    })
    const p = session.startAttempt('Mẹ')
    engine.emit('score', compareScore('Mẹ', 60))
    session.stopAttempt()
    await p
    // Give the microtask queue a moment for the async coach upgrade to land.
    await new Promise(r => setTimeout(r, 10))
    assert.ok(updateEvent, 'coach-update should have fired')
    assert.strictEqual(updateEvent.advice, 'upgraded remote advice')
  })

  await test('works with no coach (null) — no crashes, advice is null', async () => {
    const engine = new MockEngine()
    const session = new SignPathSession(engine, null, { defaultDurationMs: 10_000, tickMs: 9999 })
    const p = session.startAttempt('Mẹ')
    engine.emit('score', compareScore('Mẹ', 72))
    session.stopAttempt()
    const r = await p
    assert.strictEqual(r.advice, null)
    assert.strictEqual(r.finalScore, 72)
  })

  await test('isActive / getCurrentAttempt reflect lifecycle', async () => {
    const engine = new MockEngine()
    const session = new SignPathSession(engine, null, { defaultDurationMs: 10_000, tickMs: 9999 })
    assert.strictEqual(session.isActive(), false)
    assert.strictEqual(session.getCurrentAttempt(), null)
    const p = session.startAttempt('Mẹ')
    assert.strictEqual(session.isActive(), true)
    const cur = session.getCurrentAttempt()
    assert.ok(cur && cur.signKey === 'Mẹ' && cur.attemptId)
    session.stopAttempt()
    await p
    assert.strictEqual(session.isActive(), false)
    assert.strictEqual(session.getCurrentAttempt(), null)
  })

  await test('engine.selectSign is called with the signKey on startAttempt', async () => {
    const engine = new MockEngine()
    const session = new SignPathSession(engine, null, { defaultDurationMs: 10_000, tickMs: 9999 })
    session.startAttempt('Mẹ')
    session.cancelAttempt()
    session.startAttempt('Bố')
    session.cancelAttempt()
    assert.deepStrictEqual(engine._selectCalls, ['Mẹ', 'Bố'])
  })

  // ─── Quality tier pass-through (tests O, P, Q) ─────────────────────

  await test('O: attempt:end surfaces quality and passed top-level (high tier)', async () => {
    const engine = new MockEngine()
    const session = new SignPathSession(engine, null, { defaultDurationMs: 10_000, tickMs: 9999 })
    const p = session.startAttempt('Mẹ')
    engine.emit('score', compareScore('Mẹ', 82, {
      quality: 'high', passed: true, passAt: 70,
    }))
    session.stopAttempt()
    const r = await p
    assert.strictEqual(r.quality, 'high')
    assert.strictEqual(r.passed, true, `finalScore=${r.finalScore} should pass high threshold 70`)
    assert.strictEqual(r.stars, 2, 'score 82 → 2 stars on high thresholds [50,70,88]')
  })

  await test('P: low-quality score events use [55,70,80] star thresholds', async () => {
    const engine = new MockEngine()
    const session = new SignPathSession(engine, null, { defaultDurationMs: 10_000, tickMs: 9999 })
    // Same finalScore=82 should now give 3 stars under low thresholds.
    const p = session.startAttempt('Mẹ')
    engine.emit('score', compareScore('Mẹ', 82, {
      quality: 'low', passed: true, passAt: 55,
    }))
    session.stopAttempt()
    const r = await p
    assert.strictEqual(r.quality, 'low')
    assert.strictEqual(r.passed, true)
    assert.strictEqual(r.stars, 3, 'score 82 on low thresholds [55,70,80] → 3 stars')
  })

  await test('P2: low-quality score just above passAt gives passed=true and 1 star', async () => {
    const engine = new MockEngine()
    const session = new SignPathSession(engine, null, { defaultDurationMs: 10_000, tickMs: 9999 })
    const p = session.startAttempt('Mẹ')
    engine.emit('score', compareScore('Mẹ', 57, { quality: 'low', passAt: 55 }))
    session.stopAttempt()
    const r = await p
    assert.strictEqual(r.quality, 'low')
    assert.strictEqual(r.passed, true)
    assert.strictEqual(r.stars, 1, 'score 57 on low: above passAt 55, below 70 → 1 star')
  })

  await test('Q: score event without quality field defaults to high (back-compat)', async () => {
    const engine = new MockEngine()
    const session = new SignPathSession(engine, null, { defaultDurationMs: 10_000, tickMs: 9999 })
    const p = session.startAttempt('Mẹ')
    // Note: compareScore() in the existing helper doesn't set quality — this
    // mirrors what every pre-tier test emits.
    engine.emit('score', compareScore('Mẹ', 75))
    session.stopAttempt()
    const r = await p
    assert.strictEqual(r.quality, 'high', 'missing quality field defaults to high')
    assert.strictEqual(r.passed, true, 'finalScore=75 >= high passAt 70')
    assert.strictEqual(r.stars, 2, 'score 75 on high thresholds → 2 stars')
  })

  await test('Q2: missing passAt defaults per tier (70 for high, 55 for low)', async () => {
    const engine = new MockEngine()
    const session = new SignPathSession(engine, null, { defaultDurationMs: 10_000, tickMs: 9999 })
    // Low with no passAt in payload — session should default to 55.
    const p = session.startAttempt('Mẹ')
    engine.emit('score', compareScore('Mẹ', 56, { quality: 'low' }))
    session.stopAttempt()
    const r = await p
    assert.strictEqual(r.quality, 'low')
    assert.strictEqual(r.passed, true, 'finalScore 56 should pass default low passAt=55')
  })

  await test('score listener is detached after end (no leak)', async () => {
    const engine = new MockEngine()
    const session = new SignPathSession(engine, null, { defaultDurationMs: 10_000, tickMs: 9999 })
    const p = session.startAttempt('Mẹ')
    engine.emit('score', compareScore('Mẹ', 70))
    session.stopAttempt()
    await p
    // After end, engine should have no score listeners from this session
    const remaining = (engine._listeners['score'] || []).length
    assert.strictEqual(remaining, 0, 'session should detach its score listener on end')
  })

  console.log(`\n${_passed} passed, ${_failures} failed`)
  if (_failures) process.exit(1)
}

run().catch(e => {
  console.error('Test runner crashed:', e)
  process.exit(1)
})
