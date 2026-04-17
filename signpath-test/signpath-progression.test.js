/**
 * Tests for signpath-progression.js
 * Run: node signpath-progression.test.js
 */
'use strict'

const assert = require('assert')
const { SignPathProgression } = require('./signpath-progression.js')
const internals = SignPathProgression._internals

// ─── Harness ─────────────────────────────────────────────────────────

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
  constructor(signProgress, lessons) {
    this._sp = signProgress || {}
    this._lessons = lessons || []
  }
  getSignProgress(key) {
    return this._sp[key] || { stars: 0, best: 0, reps: 0 }
  }
  getLessons() { return this._lessons }
  setBest(key, best) {
    if (!this._sp[key]) this._sp[key] = { stars: 0, best: 0, reps: 0 }
    this._sp[key].best = best
  }
}

function memStorage() {
  const mem = {}
  return {
    getItem(k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null },
    setItem(k, v) { mem[k] = String(v) },
    removeItem(k) { delete mem[k] },
    _mem: mem,
  }
}

// A controllable fake clock. All time advances are explicit.
function fakeClock(startYmd) {
  // Start at noon of the given local date to avoid any DST edge weirdness.
  const [y, m, d] = startYmd.split('-').map(Number)
  let t = new Date(y, m - 1, d, 12, 0, 0).getTime()
  return {
    now: () => t,
    advanceDays(n) { t += n * 86400 * 1000 },
    setYmd(ymd) {
      const [yy, mm, dd] = ymd.split('-').map(Number)
      t = new Date(yy, mm - 1, dd, 12, 0, 0).getTime()
    },
  }
}

const DEFAULT_LESSONS = [
  { id: 'greetings', signs: [
    { key: 'Chào' }, { key: 'Cảm ơn' }, { key: 'Xin lỗi' },
    { key: 'Có' }, { key: 'Không' },
  ] },
  { id: 'numbers', signs: [
    { key: 'Một' }, { key: 'Hai' }, { key: 'Ba' },
  ] },
  { id: 'colors', signs: [
    { key: 'Màu đỏ' }, { key: 'Màu xanh' },
  ] },
]

function makeProg(opts = {}) {
  const engine = opts.engine || new MockEngine({}, DEFAULT_LESSONS)
  const storage = opts.storage || memStorage()
  const clock = opts.clock || fakeClock('2026-04-17')
  const prog = new SignPathProgression(engine, {
    storage,
    now: clock.now,
  })
  return { prog, engine, storage, clock }
}

// ─── Tests ───────────────────────────────────────────────────────────

async function run() {
  // ── XP formula
  console.log('XP formula')
  await test('xpForAttempt matches spec table', () => {
    const cases = [
      { score: 100, stars: 3, expected: 100 },     // 50 * 2
      { score: 88,  stars: 3, expected: 76 },      // 38 * 2
      { score: 75,  stars: 2, expected: 38 },      // 25 * 1.5 → rounded
      { score: 55,  stars: 1, expected: 5 },       // 5 * 1
      { score: 50,  stars: 1, expected: 0 },       // 0 * 1
      { score: 40,  stars: 0, expected: 0 },       // max(0,-10)*0
      { score: 70,  stars: 2, expected: 30 },      // 20 * 1.5
      { score: 88,  stars: 2, expected: 57 },      // 38 * 1.5 = 57
    ]
    for (const c of cases) {
      const got = internals.xpForAttempt(c.score, c.stars)
      assert.strictEqual(got, c.expected, `score=${c.score} stars=${c.stars}: expected ${c.expected}, got ${got}`)
    }
  })

  // ── Level thresholds
  console.log('Level thresholds')
  await test('levelFromXp: 0→L1, 100→L2, 300→L3, 600→L4, 1000→L5', () => {
    assert.strictEqual(internals.levelFromXp(0), 1)
    assert.strictEqual(internals.levelFromXp(99), 1)
    assert.strictEqual(internals.levelFromXp(100), 2)
    assert.strictEqual(internals.levelFromXp(299), 2)
    assert.strictEqual(internals.levelFromXp(300), 3)
    assert.strictEqual(internals.levelFromXp(599), 3)
    assert.strictEqual(internals.levelFromXp(600), 4)
    assert.strictEqual(internals.levelFromXp(999), 4)
    assert.strictEqual(internals.levelFromXp(1000), 5)
  })

  await test('nextThresholdForLevel matches spec (100, 300, 600, 1000)', () => {
    assert.strictEqual(internals.nextThresholdForLevel(1), 100)
    assert.strictEqual(internals.nextThresholdForLevel(2), 300)
    assert.strictEqual(internals.nextThresholdForLevel(3), 600)
    assert.strictEqual(internals.nextThresholdForLevel(4), 1000)
  })

  // ── Recording attempts + XP
  console.log('recordAttempt basic')
  await test('first attempt increases XP and emits xp:gained', () => {
    const { prog } = makeProg()
    let xpEvent = null
    prog.on('xp:gained', e => { xpEvent = e })
    const r = prog.recordAttempt({ signKey: 'Chào', finalScore: 100, stars: 3, attemptId: 'a1' })
    assert.strictEqual(r.xpGained, 100)
    assert.strictEqual(prog.getXp(), 100)
    assert.ok(xpEvent && xpEvent.amount === 100 && xpEvent.totalXp === 100)
  })

  await test('level-up fires level:up and includes achievement', () => {
    const { prog } = makeProg()
    let levelUp = null
    prog.on('level:up', e => { levelUp = e })
    const r = prog.recordAttempt({ signKey: 'Chào', finalScore: 100, stars: 3, attemptId: 'a1' })
    // 0 → 100 XP crosses threshold for L2
    assert.ok(levelUp)
    assert.strictEqual(levelUp.newLevel, 2)
    assert.strictEqual(levelUp.prevLevel, 1)
    assert.ok(r.achievementsUnlocked.find(a => a.type === 'level' && a.level === 2))
  })

  await test('recordAttempt is idempotent on duplicate attemptId', () => {
    const { prog } = makeProg()
    const r1 = prog.recordAttempt({ signKey: 'Chào', finalScore: 100, stars: 3, attemptId: 'same' })
    const r2 = prog.recordAttempt({ signKey: 'Chào', finalScore: 100, stars: 3, attemptId: 'same' })
    assert.strictEqual(r1.xpGained, 100)
    assert.strictEqual(r2.xpGained, 0)
    assert.strictEqual(r2.duplicateAttempt, true)
    assert.strictEqual(prog.getXp(), 100, 'XP should not double')
  })

  await test('ring buffer only holds last 50 IDs', () => {
    const { prog } = makeProg()
    // Record 60 unique attempts
    for (let i = 0; i < 60; i++) {
      prog.recordAttempt({ signKey: 'Chào', finalScore: 60, stars: 1, attemptId: `att_${i}` })
    }
    // The first 10 should have been evicted from the ring buffer
    const r = prog.recordAttempt({ signKey: 'Chào', finalScore: 60, stars: 1, attemptId: 'att_0' })
    assert.strictEqual(r.duplicateAttempt, false, 'att_0 evicted, should not dedupe')
    const r2 = prog.recordAttempt({ signKey: 'Chào', finalScore: 60, stars: 1, attemptId: 'att_59' })
    assert.strictEqual(r2.duplicateAttempt, true, 'att_59 still in ring, should dedupe')
  })

  // ── Streak
  console.log('Streak logic')
  await test('streak: first practice = 1', () => {
    const { prog } = makeProg({ clock: fakeClock('2026-04-17') })
    let ev = null
    prog.on('streak:updated', e => { ev = e })
    prog.recordAttempt({ signKey: 'Chào', finalScore: 80, stars: 2, attemptId: 'a1' })
    assert.strictEqual(prog.getStreak().current, 1)
    assert.strictEqual(prog.getStreak().longest, 1)
    assert.ok(ev && ev.didExtendToday)
  })

  await test('streak: consecutive days extend, missed day resets', () => {
    const clock = fakeClock('2026-04-17')
    const { prog } = makeProg({ clock })
    prog.recordAttempt({ signKey: 'Chào', finalScore: 80, stars: 2, attemptId: 'd1' })
    assert.strictEqual(prog.getStreak().current, 1)

    clock.advanceDays(1)
    prog.recordAttempt({ signKey: 'Chào', finalScore: 80, stars: 2, attemptId: 'd2' })
    assert.strictEqual(prog.getStreak().current, 2)

    clock.advanceDays(1)
    prog.recordAttempt({ signKey: 'Chào', finalScore: 80, stars: 2, attemptId: 'd3' })
    assert.strictEqual(prog.getStreak().current, 3)
    assert.strictEqual(prog.getStreak().longest, 3)

    clock.advanceDays(2)  // skip a day
    prog.recordAttempt({ signKey: 'Chào', finalScore: 80, stars: 2, attemptId: 'd4' })
    assert.strictEqual(prog.getStreak().current, 1, 'should reset')
    assert.strictEqual(prog.getStreak().longest, 3, 'longest preserved')
  })

  await test('streak: multiple attempts same day do not double-increment', () => {
    const clock = fakeClock('2026-04-17')
    const { prog } = makeProg({ clock })
    prog.recordAttempt({ signKey: 'Chào', finalScore: 80, stars: 2, attemptId: 'x1' })
    prog.recordAttempt({ signKey: 'Chào', finalScore: 80, stars: 2, attemptId: 'x2' })
    prog.recordAttempt({ signKey: 'Chào', finalScore: 80, stars: 2, attemptId: 'x3' })
    assert.strictEqual(prog.getStreak().current, 1)
  })

  await test('streak: attempt with 0 XP does not extend streak', () => {
    const clock = fakeClock('2026-04-17')
    const { prog } = makeProg({ clock })
    // Score 40 with 0 stars → 0 XP
    prog.recordAttempt({ signKey: 'Chào', finalScore: 40, stars: 0, attemptId: 'a' })
    assert.strictEqual(prog.getStreak().current, 0, 'no XP → no streak change')
    assert.strictEqual(prog.getStreak().didSignToday, false)
  })

  await test('streak: didSignToday flips true after a scoring attempt', () => {
    const clock = fakeClock('2026-04-17')
    const { prog } = makeProg({ clock })
    assert.strictEqual(prog.getStreak().didSignToday, false)
    prog.recordAttempt({ signKey: 'Chào', finalScore: 80, stars: 2, attemptId: 'a' })
    assert.strictEqual(prog.getStreak().didSignToday, true)
  })

  // ── Mastery
  console.log('Mastery')
  await test('mastery transitions: 0 → 1 → 2 → 3', () => {
    const engine = new MockEngine({}, DEFAULT_LESSONS)
    const { prog } = makeProg({ engine })
    // Initially 0 (new)
    assert.strictEqual(prog.getMasteryLevel('Chào'), 0)

    // After one low-score attempt (<70) → 1 (learning)
    engine.setBest('Chào', 60)
    prog.recordAttempt({ signKey: 'Chào', finalScore: 60, stars: 1, attemptId: 'a1' })
    assert.strictEqual(prog.getMasteryLevel('Chào'), 1)

    // Bump best to 75 → 2 (familiar)
    engine.setBest('Chào', 75)
    prog.recordAttempt({ signKey: 'Chào', finalScore: 75, stars: 2, attemptId: 'a2' })
    assert.strictEqual(prog.getMasteryLevel('Chào'), 2)

    // Hit 90 but <5 attempts → still 2
    engine.setBest('Chào', 90)
    prog.recordAttempt({ signKey: 'Chào', finalScore: 90, stars: 3, attemptId: 'a3' })
    assert.strictEqual(prog.getMasteryLevel('Chào'), 2, 'best>=88 but <5 attempts is still familiar')

    // One more → still 2 (4 attempts)
    prog.recordAttempt({ signKey: 'Chào', finalScore: 90, stars: 3, attemptId: 'a4' })
    assert.strictEqual(prog.getMasteryLevel('Chào'), 2)

    // Fifth attempt → 3 (mastered)
    prog.recordAttempt({ signKey: 'Chào', finalScore: 90, stars: 3, attemptId: 'a5' })
    assert.strictEqual(prog.getMasteryLevel('Chào'), 3)
  })

  await test('mastery:gained event fires on level change', () => {
    const engine = new MockEngine({}, DEFAULT_LESSONS)
    const { prog } = makeProg({ engine })
    const events = []
    prog.on('mastery:gained', e => events.push(e))
    engine.setBest('Chào', 60)
    prog.recordAttempt({ signKey: 'Chào', finalScore: 60, stars: 1, attemptId: 'a1' })
    engine.setBest('Chào', 75)
    prog.recordAttempt({ signKey: 'Chào', finalScore: 75, stars: 2, attemptId: 'a2' })
    assert.strictEqual(events.length, 2)
    assert.strictEqual(events[0].masteryLevel, 1)
    assert.strictEqual(events[1].masteryLevel, 2)
  })

  await test('getMasteredCount only counts mastery=3 signs', () => {
    const engine = new MockEngine({}, DEFAULT_LESSONS)
    const { prog } = makeProg({ engine })
    // Two signs at mastery 3, one at mastery 2
    engine.setBest('Chào', 90)
    engine.setBest('Cảm ơn', 90)
    engine.setBest('Xin lỗi', 75)
    for (let i = 0; i < 5; i++) {
      prog.recordAttempt({ signKey: 'Chào', finalScore: 90, stars: 3, attemptId: `c${i}` })
      prog.recordAttempt({ signKey: 'Cảm ơn', finalScore: 90, stars: 3, attemptId: `k${i}` })
    }
    prog.recordAttempt({ signKey: 'Xin lỗi', finalScore: 75, stars: 2, attemptId: 'x1' })
    assert.strictEqual(prog.getMasteredCount(), 2)
  })

  // ── Lesson unlocks
  console.log('Lesson unlocks')
  await test('first lesson unlocked on first recordAttempt', () => {
    const engine = new MockEngine({}, DEFAULT_LESSONS)
    const { prog } = makeProg({ engine })
    assert.strictEqual(prog.isLessonUnlocked('greetings'), false)
    prog.recordAttempt({ signKey: 'Chào', finalScore: 60, stars: 1, attemptId: 'a1' })
    assert.strictEqual(prog.isLessonUnlocked('greetings'), true)
  })

  await test('second lesson unlocks at ≥80% of first lesson at mastery 2+', () => {
    // Greetings has 5 signs; 80% = 4 familiar
    const engine = new MockEngine({}, DEFAULT_LESSONS)
    const { prog } = makeProg({ engine })
    const greetingKeys = ['Chào', 'Cảm ơn', 'Xin lỗi', 'Có', 'Không']
    // Make 3/5 familiar (60%) — not enough
    for (let i = 0; i < 3; i++) {
      engine.setBest(greetingKeys[i], 75)
      prog.recordAttempt({ signKey: greetingKeys[i], finalScore: 75, stars: 2, attemptId: `u_${i}` })
    }
    assert.strictEqual(prog.isLessonUnlocked('numbers'), false, '60% not enough')

    // Bring 4/5 to familiar (80%) — should unlock
    engine.setBest(greetingKeys[3], 75)
    let unlockEvents = []
    prog.on('lesson:unlocked', e => unlockEvents.push(e))
    prog.recordAttempt({ signKey: greetingKeys[3], finalScore: 75, stars: 2, attemptId: 'u_3' })
    assert.strictEqual(prog.isLessonUnlocked('numbers'), true, '80% should unlock')
    assert.ok(unlockEvents.find(e => e.lessonId === 'numbers'))
  })

  await test('lesson unlock achievement appears in recordAttempt result', () => {
    const engine = new MockEngine({}, DEFAULT_LESSONS)
    const { prog } = makeProg({ engine })
    const greetingKeys = ['Chào', 'Cảm ơn', 'Xin lỗi', 'Có']
    for (let i = 0; i < 3; i++) {
      engine.setBest(greetingKeys[i], 75)
      prog.recordAttempt({ signKey: greetingKeys[i], finalScore: 75, stars: 2, attemptId: `u_${i}` })
    }
    engine.setBest(greetingKeys[3], 75)
    const r = prog.recordAttempt({ signKey: greetingKeys[3], finalScore: 75, stars: 2, attemptId: 'u_3' })
    const lessonUnlock = r.achievementsUnlocked.find(a => a.type === 'lesson' && a.lessonId === 'numbers')
    assert.ok(lessonUnlock, 'result should list the newly unlocked lesson')
  })

  // ── Lesson completion
  console.log('Lesson completion')
  await test('lesson:completed fires when all signs in a lesson hit mastery 3', () => {
    const smallLessons = [
      { id: 'greetings', signs: [{ key: 'Chào' }, { key: 'Cảm ơn' }] },
    ]
    const engine = new MockEngine({}, smallLessons)
    const { prog } = makeProg({ engine })
    const events = []
    prog.on('lesson:completed', e => events.push(e))
    engine.setBest('Chào', 90)
    engine.setBest('Cảm ơn', 90)
    for (let i = 0; i < 5; i++) {
      prog.recordAttempt({ signKey: 'Chào', finalScore: 90, stars: 3, attemptId: `a${i}` })
    }
    for (let i = 0; i < 4; i++) {
      prog.recordAttempt({ signKey: 'Cảm ơn', finalScore: 90, stars: 3, attemptId: `b${i}` })
    }
    // Still not complete (Cảm ơn at 4 attempts)
    assert.strictEqual(events.length, 0)
    prog.recordAttempt({ signKey: 'Cảm ơn', finalScore: 90, stars: 3, attemptId: 'b5' })
    assert.strictEqual(events.length, 1, 'should fire once')
    assert.strictEqual(events[0].lessonId, 'greetings')

    // Further attempts should not re-fire
    prog.recordAttempt({ signKey: 'Chào', finalScore: 90, stars: 3, attemptId: 'b_extra' })
    assert.strictEqual(events.length, 1)
  })

  // ── Daily goal
  console.log('Daily goal')
  await test('daily goal tracks XP earned today only', () => {
    const clock = fakeClock('2026-04-17')
    const { prog } = makeProg({ clock })
    prog.setDailyGoal(50)
    prog.recordAttempt({ signKey: 'Chào', finalScore: 80, stars: 2, attemptId: 'a1' })  // max(0,30)*1.5 = 45 XP
    assert.strictEqual(prog.getDailyGoal().progress, 45)
    assert.strictEqual(prog.getDailyGoal().met, false)
    prog.recordAttempt({ signKey: 'Cảm ơn', finalScore: 88, stars: 3, attemptId: 'a2' })  // 38*2 = 76 XP
    assert.ok(prog.getDailyGoal().progress >= 50)
    assert.strictEqual(prog.getDailyGoal().met, true)

    // Advance to next day — progress should reset in getDailyGoal()
    clock.advanceDays(1)
    assert.strictEqual(prog.getDailyGoal().progress, 0, 'new day → fresh progress')
  })

  await test('setDailyGoal rejects non-positive values', () => {
    const { prog } = makeProg()
    const before = prog.getDailyGoal().target
    prog.setDailyGoal(0)
    prog.setDailyGoal(-10)
    prog.setDailyGoal('not a number')
    assert.strictEqual(prog.getDailyGoal().target, before)
    prog.setDailyGoal(100)
    assert.strictEqual(prog.getDailyGoal().target, 100)
  })

  // ── Persistence
  console.log('Persistence')
  await test('state persists across instances via storage', () => {
    const storage = memStorage()
    const clock = fakeClock('2026-04-17')
    const engine1 = new MockEngine({}, DEFAULT_LESSONS)
    const prog1 = new SignPathProgression(engine1, { storage, now: clock.now })
    engine1.setBest('Chào', 90)
    prog1.recordAttempt({ signKey: 'Chào', finalScore: 100, stars: 3, attemptId: 'a1' })
    const xp1 = prog1.getXp()
    const streak1 = prog1.getStreak().current

    // New instance, same storage
    const engine2 = new MockEngine({ Chào: { stars: 3, best: 90, reps: 1 } }, DEFAULT_LESSONS)
    const prog2 = new SignPathProgression(engine2, { storage, now: clock.now })
    assert.strictEqual(prog2.getXp(), xp1)
    assert.strictEqual(prog2.getStreak().current, streak1)
  })

  await test('corrupted storage falls back to defaults without throwing', () => {
    const storage = memStorage()
    storage.setItem('sp_progression_v1', 'not json {{{')
    const engine = new MockEngine({}, DEFAULT_LESSONS)
    const prog = new SignPathProgression(engine, { storage, now: () => Date.now() })
    assert.strictEqual(prog.getXp(), 0)
  })

  // ── getSnapshot
  console.log('Snapshot')
  await test('getSnapshot returns a full picture for UI render', () => {
    const engine = new MockEngine({}, DEFAULT_LESSONS)
    const { prog } = makeProg({ engine })
    prog.recordAttempt({ signKey: 'Chào', finalScore: 100, stars: 3, attemptId: 'a1' })
    const snap = prog.getSnapshot()
    assert.strictEqual(snap.xp, 100)
    assert.strictEqual(snap.level, 2)
    assert.strictEqual(snap.nextLevelThreshold, 300)
    assert.ok(snap.streak)
    assert.ok(snap.dailyGoal)
    assert.ok(Array.isArray(snap.unlockedLessons))
    assert.ok(snap.unlockedLessons.indexOf('greetings') !== -1)
  })

  // ── ymd helpers
  console.log('Date helpers')
  await test('ymdLocal and previousYmd survive month/year boundaries', () => {
    // New Year's Day 2026 at noon local
    const ts = new Date(2026, 0, 1, 12, 0, 0).getTime()
    assert.strictEqual(internals.ymdLocal(ts), '2026-01-01')
    assert.strictEqual(internals.previousYmd('2026-01-01'), '2025-12-31')
    assert.strictEqual(internals.previousYmd('2026-03-01'), '2026-02-28')
  })

  console.log(`\n${_passed} passed, ${_failures} failed`)
  if (_failures) process.exit(1)
}

run().catch(e => {
  console.error('Test runner crashed:', e)
  process.exit(1)
})
