/**
 * Integration test for signpath-api.js.
 * Run: node signpath-api.test.js
 *
 * Uses mock engine + coach; wires real progression / review / session /
 * audio sub-modules so practiceSign() exercises the full pipeline.
 */
'use strict'

const assert = require('assert')
const { SignPathApp } = require('./signpath-api.js')
const { SignPathSession } = require('./signpath-session.js')
const { SignPathProgression } = require('./signpath-progression.js')
const { SignPathReview } = require('./signpath-review.js')
const { SignPathAudio } = require('./signpath-audio.js')

let _failures = 0, _passed = 0
async function test(name, fn) {
  try { await fn(); _passed++; console.log(`  ✓ ${name}`) }
  catch (e) { _failures++; console.error(`  ✗ ${name}\n    ${e.message}`); if (process.env.DEBUG) console.error(e.stack) }
}

// ─── Mocks ───────────────────────────────────────────────────────────

class MockEngine {
  constructor() {
    this._listeners = {}
    this._activeSign = null
    this._lang = 'vi'
    this._lessons = [
      { id: 'greetings', goal: { vi: 'Chào hỏi', en: 'Greetings' }, icon: '👋', color: '#e07a3a', signs: [
        { key: 'Chào', vi: 'Chào', en: 'Hello' },
        { key: 'Cảm ơn', vi: 'Cảm ơn', en: 'Thank you' },
      ] },
      { id: 'numbers', goal: { vi: 'Số đếm', en: 'Numbers' }, icon: '🔢', color: '#d4922a', signs: [
        { key: 'Một', vi: 'Một', en: 'One' },
      ] },
    ]
    this._signs = {}
    for (const l of this._lessons) for (const s of l.signs) {
      this._signs[s.key] = Object.assign({}, s, { unitId: l.id, unitGoal: l.goal, unitIcon: l.icon })
    }
    this._progress = {}
  }
  on(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn) }
  off(ev, fn) { const a = this._listeners[ev]; if (a) this._listeners[ev] = a.filter(f => f !== fn) }
  emit(ev, data) { (this._listeners[ev] || []).forEach(fn => fn(data)) }
  selectSign(k) { this._activeSign = k }
  clearSign() { this._activeSign = null }
  getLang() { return this._lang }
  getLessons() { return this._lessons }
  getSign(k) { return this._signs[k] || null }
  getSignProgress(k) { return this._progress[k] || { stars: 0, best: 0, reps: 0 } }
  setBest(k, best) { this._progress[k] = this._progress[k] || { stars: 0, best: 0, reps: 0 }; this._progress[k].best = best }
  getTemplate(k) { return this._signs[k] ? { mean: [new Float32Array(10)], consistency: 0.8 } : null }
}

class MockCoach {
  async getAdvice() { return null }
}

function memStorage() {
  const mem = {}
  return {
    getItem(k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null },
    setItem(k, v) { mem[k] = String(v) },
    removeItem(k) { delete mem[k] },
  }
}

function compareScore(signKey, score) {
  return {
    signKey, score,
    prediction: { gloss: signKey, similarity: score / 100, score },
    top3: [{ gloss: signKey, score, similarity: score / 100 }],
    top5: [{ gloss: signKey, score, similarity: score / 100 }],
    fingerScores: [],
    deviations: { signKey, signEn: signKey, positionIssues: [], worstFingers: [] },
    feedback: '', tier: 'Tốt lắm!', tierEmoji: '👍',
    isMatch: true, bufferFrames: 30,
  }
}

// Audio mock we can assert on (doesn't hit Web Audio).
class SpyAudio {
  constructor() { this.tones = []; this.enabled = true }
  playTone(tier) { this.tones.push(tier) }
  speak() { return Promise.resolve() }
  setEnabled(b) { this.enabled = b }
  isEnabled() { return this.enabled }
  getAvailableVoices() { return [] }
  setVoice() {}
  destroy() {}
}

function buildApp(opts = {}) {
  const engine = opts.engine || new MockEngine()
  const coach = opts.coach || new MockCoach()
  const storage = opts.storage || memStorage()
  const audio = opts.audio || new SpyAudio()
  const progression = new SignPathProgression(engine, { storage, now: opts.now })
  const review = new SignPathReview(engine, progression, { storage, now: opts.now })
  const session = new SignPathSession(engine, coach, { defaultDurationMs: 10_000, tickMs: 9999 })
  const app = new SignPathApp({ engine, coach, progression, review, session, audio })
  return { app, engine, coach, storage, audio, progression, review, session }
}

// ─── Tests ───────────────────────────────────────────────────────────

async function run() {
  console.log('SignPathApp (integration)')

  await test('constructor wires all sub-modules', () => {
    const { app } = buildApp()
    assert.ok(app.engine)
    assert.ok(app.coach)
    assert.ok(app.session)
    assert.ok(app.progression)
    assert.ok(app.review)
    assert.ok(app.audio)
  })

  await test('practiceSign: full pipeline — XP recorded, SRS marked, tone played', async () => {
    const { app, engine, audio } = buildApp()
    engine.setBest('Chào', 82)
    const promise = app.practiceSign('Chào', 10_000)
    // Emit a single compare-case score; session.stopAttempt() would require
    // access to app.session — which we have, so use it directly.
    engine.emit('score', compareScore('Chào', 82))
    app.session.stopAttempt()
    const result = await promise
    assert.strictEqual(result.finalScore, 82)
    assert.strictEqual(result.stars, 2)
    assert.ok(result.progression)
    assert.strictEqual(result.progression.xpGained, 48)  // max(0, 82-50)*1.5 = 48
    assert.ok(result.review)
    assert.strictEqual(result.review.interval, 1, 'first successful review → interval=1')
    assert.ok(audio.tones.length >= 1, 'a tone should have played')
    assert.strictEqual(audio.tones[0], 'good', '2 stars → good tone')
  })

  await test('practiceSign: 3 stars plays success + star bonus tone', async () => {
    const { app, engine, audio } = buildApp()
    engine.setBest('Chào', 95)
    const promise = app.practiceSign('Chào', 10_000)
    engine.emit('score', compareScore('Chào', 95))
    app.session.stopAttempt()
    const result = await promise
    assert.strictEqual(result.stars, 3)
    assert.deepStrictEqual(audio.tones, ['success', 'star'])
  })

  await test('practiceSign: aborted attempt does NOT record XP or SRS', async () => {
    const { app, engine, audio } = buildApp()
    const xpBefore = app.progression.getXp()
    const promise = app.practiceSign('Chào', 10_000)
    // No score events — force an abort
    app.session.stopAttempt()
    const result = await promise
    assert.strictEqual(result.aborted, true)
    assert.strictEqual(result.progression, null, 'no progression record on abort')
    assert.strictEqual(result.review, null, 'no SRS mark on abort')
    assert.strictEqual(app.progression.getXp(), xpBefore, 'XP unchanged')
    // A tone may still play or not; test just that nothing crashed.
    assert.ok(audio.tones.length === 0 || audio.tones.length >= 0)
  })

  await test('practiceSign deduplicates via attemptId (no double XP on replay)', async () => {
    const { app, engine } = buildApp()
    engine.setBest('Chào', 80)
    const p = app.practiceSign('Chào', 10_000)
    engine.emit('score', compareScore('Chào', 80))
    app.session.stopAttempt()
    const r = await p
    const xp1 = app.progression.getXp()

    // Simulate a subscriber bug: record the same attempt twice into progression
    const r2 = app.progression.recordAttempt({
      signKey: r.signKey, finalScore: r.finalScore, stars: r.stars, attemptId: r.attemptId,
    })
    assert.strictEqual(r2.duplicateAttempt, true)
    assert.strictEqual(app.progression.getXp(), xp1, 'XP not doubled')

    // Same for review
    const rv2 = app.review.markReviewed({
      signKey: r.signKey, finalScore: r.finalScore, attemptId: r.attemptId,
    })
    assert.strictEqual(rv2.duplicate, true)
  })

  await test('app.on forwards engine score events', async () => {
    const { app, engine } = buildApp()
    const received = []
    app.on('score', d => received.push(d.score))
    engine.emit('score', compareScore('Chào', 77))
    assert.deepStrictEqual(received, [77])
  })

  await test('R: facade passes through new quality/passed/passAt fields without stripping', async () => {
    const { app, engine } = buildApp()
    const seen = []
    app.on('score', d => seen.push(d))
    engine.emit('score', Object.assign(compareScore('Chào', 68), {
      quality: 'low', passed: true, passAt: 55,
    }))
    assert.strictEqual(seen.length, 1)
    assert.strictEqual(seen[0].quality, 'low')
    assert.strictEqual(seen[0].passed, true)
    assert.strictEqual(seen[0].passAt, 55)
  })

  await test('app.on forwards session attempt events', async () => {
    const { app, engine } = buildApp()
    const ended = []
    app.on('attempt:end', d => ended.push(d.attemptId))
    const p = app.practiceSign('Chào', 10_000)
    engine.emit('score', compareScore('Chào', 80))
    app.session.stopAttempt()
    await p
    assert.strictEqual(ended.length, 1)
  })

  await test('app.on forwards progression xp:gained events', async () => {
    const { app, engine } = buildApp()
    const xp = []
    app.on('xp:gained', d => xp.push(d))
    const p = app.practiceSign('Chào', 10_000)
    engine.emit('score', compareScore('Chào', 95))
    app.session.stopAttempt()
    await p
    assert.strictEqual(xp.length, 1)
    assert.ok(xp[0].amount > 0)
  })

  await test('app.on warns on unknown events (does not throw)', () => {
    const { app } = buildApp()
    // Just verify it doesn't throw
    app.on('bogus-event', () => {})
    app.off('bogus-event', () => {})
  })

  await test('app.off removes a listener', async () => {
    const { app, engine } = buildApp()
    let hits = 0
    const fn = () => hits++
    app.on('score', fn)
    engine.emit('score', compareScore('Chào', 70))
    assert.strictEqual(hits, 1)
    app.off('score', fn)
    engine.emit('score', compareScore('Chào', 70))
    assert.strictEqual(hits, 1)
  })

  // ── Data facades
  await test('getHomeScreenData returns a full picture', () => {
    const { app } = buildApp()
    const data = app.getHomeScreenData()
    assert.ok(data.user)
    assert.ok(typeof data.user.xp === 'number')
    assert.ok(typeof data.user.level === 'number')
    assert.ok(data.streak)
    assert.ok(data.dailyGoal)
    assert.ok(Array.isArray(data.unlockedLessons))
    assert.ok(Array.isArray(data.nextSigns))
    assert.ok(typeof data.totalSigns === 'number')
  })

  await test('getLessonScreenData returns lesson + per-sign mastery', () => {
    const { app } = buildApp()
    const data = app.getLessonScreenData('greetings')
    assert.ok(data)
    assert.strictEqual(data.id, 'greetings')
    assert.strictEqual(data.signs.length, 2)
    assert.ok(data.signs[0].key === 'Chào')
    assert.ok(typeof data.signs[0].mastery === 'number')
  })

  await test('getLessonScreenData returns null for unknown lesson', () => {
    const { app } = buildApp()
    assert.strictEqual(app.getLessonScreenData('no-such-lesson'), null)
  })

  await test('getSignDetailData returns sign + engine/progression/review state', () => {
    const { app } = buildApp()
    const data = app.getSignDetailData('Chào')
    assert.ok(data)
    assert.strictEqual(data.key, 'Chào')
    assert.ok(typeof data.mastery === 'number')
    assert.ok(typeof data.attempts === 'number')
    assert.ok(data.hasTemplate)
  })

  await test('getSignDetailData returns null for unknown sign', () => {
    const { app } = buildApp()
    assert.strictEqual(app.getSignDetailData('not-a-sign'), null)
  })

  // ── Level progress fields
  await test('home screen: xpIntoLevel + xpForLevel for the progress bar', () => {
    const { app, engine } = buildApp()
    // Earn some XP
    for (let i = 0; i < 3; i++) {
      engine.setBest('Chào', 90)
      app.progression.recordAttempt({ signKey: 'Chào', finalScore: 90, stars: 3, attemptId: `a${i}` })
    }
    const d = app.getHomeScreenData()
    assert.strictEqual(d.user.xp, 240)        // 3 * (40 * 2)
    assert.strictEqual(d.user.level, 2)       // 240 is between 100 and 300
    assert.strictEqual(d.user.nextLevelThreshold, 300)
    assert.strictEqual(d.user.xpIntoLevel, 140)  // 240 - 100
    assert.strictEqual(d.user.xpForLevel, 200)   // 300 - 100
  })

  // ── Score inflation + hard fail gate (v0.5) ───────────────────────
  await test('practiceSign: pass attaches inflatedFinalScore + passed:true (raw stays raw)', async () => {
    const { app, engine } = buildApp()
    engine.setBest('Chào', 82)
    const p = app.practiceSign('Chào', 10_000)
    engine.emit('score', compareScore('Chào', 82))
    app.session.stopAttempt()
    const r = await p
    assert.strictEqual(r.finalScore, 82, 'raw finalScore preserved for engine consumers')
    assert.strictEqual(r.inflatedFinalScore, 100, 'inflated = min(100, 82+20)')
    assert.strictEqual(r.passed, true)
    assert.ok(r.progression, 'XP recorded on pass')
    assert.strictEqual(r.progression.xpGained, 48, 'XP formula still uses RAW score (48=max(0,82-50)*1.5)')
  })

  await test('practiceSign: hard fail when inflated < 50 (raw 20 → inflated 40)', async () => {
    const { app, engine, audio } = buildApp()
    const xpBefore = app.progression.getXp()
    const p = app.practiceSign('Chào', 10_000)
    engine.emit('score', compareScore('Chào', 20))
    app.session.stopAttempt()
    const r = await p
    assert.strictEqual(r.finalScore, 20, 'raw stays raw')
    assert.strictEqual(r.inflatedFinalScore, 40)
    assert.strictEqual(r.passed, false)
    assert.strictEqual(r.progression, null, 'no XP on hard fail')
    assert.strictEqual(r.review, null, 'no SRS mark on hard fail')
    assert.strictEqual(app.progression.getXp(), xpBefore, 'XP unchanged after fail')
    assert.strictEqual(r.toneTier, 'fail', 'fail tone only')
    assert.deepStrictEqual(audio.tones, ['fail'])
  })

  await test('practiceSign: bare-pass edge (raw 30 → inflated 50) records progression', async () => {
    const { app, engine } = buildApp()
    const p = app.practiceSign('Chào', 10_000)
    engine.emit('score', compareScore('Chào', 30))
    app.session.stopAttempt()
    const r = await p
    assert.strictEqual(r.inflatedFinalScore, 50)
    assert.strictEqual(r.passed, true, 'gate is >=, so 50 passes')
    assert.ok(r.progression, 'progression recorded on bare pass')
    assert.ok(r.review, 'SRS recorded on bare pass')
  })

  await test('practiceSign: raw 29 fails (inflated 49 is one below gate)', async () => {
    const { app, engine } = buildApp()
    const p = app.practiceSign('Chào', 10_000)
    engine.emit('score', compareScore('Chào', 29))
    app.session.stopAttempt()
    const r = await p
    assert.strictEqual(r.inflatedFinalScore, 49)
    assert.strictEqual(r.passed, false)
    assert.strictEqual(r.progression, null)
  })

  await test('practiceSign: aborted attempt stays aborted (no inflated fields added)', async () => {
    const { app } = buildApp()
    const p = app.practiceSign('Chào', 10_000)
    app.session.stopAttempt()
    const r = await p
    assert.strictEqual(r.aborted, true)
    assert.strictEqual(r.progression, null)
    assert.strictEqual(r.review, null)
    // aborted payload does NOT carry inflated fields — it has no meaningful
    // score to display.
    assert.strictEqual(r.inflatedFinalScore, undefined)
    assert.strictEqual(r.passed, undefined)
  })

  console.log(`\n${_passed} passed, ${_failures} failed`)
  if (_failures) process.exit(1)
}

run().catch(e => { console.error('Test runner crashed:', e); process.exit(1) })
