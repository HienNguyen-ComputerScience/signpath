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

  // ── getCoachContext — shape + trend/fatigue/category logic
  console.log('getCoachContext')

  await test('first attempt with pendingScore → trend=first, attemptCount=1, previousBest=null', () => {
    const { prog } = makeProg()
    const ctx = prog.getCoachContext('Mẹ', { pendingScore: 60 })
    assert.strictEqual(ctx.sign.attemptCount, 1)
    assert.strictEqual(ctx.sign.trend, 'first')
    assert.strictEqual(ctx.sign.previousBest, null)
    assert.deepStrictEqual(ctx.sign.recentScores, [60])
    assert.strictEqual(ctx.sign.daysSinceLastAttempt, null)
  })

  await test('after three improving attempts → trend=improving, previousBest reflects history', () => {
    const engine = new MockEngine({}, DEFAULT_LESSONS)
    const { prog } = makeProg({ engine })
    prog.recordAttempt({ signKey: 'Mẹ', finalScore: 50, stars: 0, attemptId: 'm1' })
    prog.recordAttempt({ signKey: 'Mẹ', finalScore: 62, stars: 1, attemptId: 'm2' })
    const ctx = prog.getCoachContext('Mẹ', { pendingScore: 78 })
    assert.strictEqual(ctx.sign.attemptCount, 3)
    assert.strictEqual(ctx.sign.previousBest, 62)
    assert.deepStrictEqual(ctx.sign.recentScores, [50, 62, 78])
    assert.strictEqual(ctx.sign.trend, 'improving', '78 > 62 previousBest → improving')
  })

  await test('declining trend: last 3 drop by 5+ per step', () => {
    const { prog } = makeProg()
    prog.recordAttempt({ signKey: 'Mẹ', finalScore: 85, stars: 2, attemptId: 'x1' })
    prog.recordAttempt({ signKey: 'Mẹ', finalScore: 70, stars: 2, attemptId: 'x2' })
    const ctx = prog.getCoachContext('Mẹ', { pendingScore: 55 })
    assert.strictEqual(ctx.sign.trend, 'declining')
  })

  await test('plateaued: three similar attempts with no improvement', () => {
    const { prog } = makeProg()
    prog.recordAttempt({ signKey: 'Mẹ', finalScore: 70, stars: 2, attemptId: 'p1' })
    prog.recordAttempt({ signKey: 'Mẹ', finalScore: 68, stars: 1, attemptId: 'p2' })
    const ctx = prog.getCoachContext('Mẹ', { pendingScore: 69 })
    assert.strictEqual(ctx.sign.trend, 'plateaued')
  })

  await test('session tracking: attemptsThisSession reflects in-memory session, resets after 30+ min gap', () => {
    const clock = fakeClock('2026-04-17')
    const { prog } = makeProg({ clock })
    prog.recordAttempt({ signKey: 'Mẹ', finalScore: 60, stars: 1, attemptId: 's1' })
    prog.recordAttempt({ signKey: 'Bố', finalScore: 65, stars: 1, attemptId: 's2' })
    assert.strictEqual(prog.getCoachContext('Mẹ').session.attemptsThisSession, 2)
    // Jump forward 45 minutes → next attempt starts a fresh session
    clock.advanceDays(0); const t = clock.now()
    const laterNow = t + 45 * 60 * 1000
    prog.recordAttempt({ signKey: 'Mẹ', finalScore: 70, stars: 2, attemptId: 's3', timestamp: laterNow })
    assert.strictEqual(prog.getCoachContext('Mẹ').session.attemptsThisSession, 1)
  })

  await test('fatigueSignal: false for short sessions; true when tail avg ≥10 below head', () => {
    const { prog } = makeProg()
    // 9 attempts — under the 10-sample floor → always false
    for (let i = 0; i < 9; i++) {
      prog.recordAttempt({ signKey: 'Mẹ', finalScore: 80, stars: 2, attemptId: `a${i}` })
    }
    assert.strictEqual(prog.getCoachContext('Mẹ').session.fatigueSignal, false)
    // Now add 5 low-score attempts — head avg 80, tail avg ~50 → fatigue
    for (let i = 0; i < 5; i++) {
      prog.recordAttempt({ signKey: 'Mẹ', finalScore: 50, stars: 0, attemptId: `b${i}` })
    }
    assert.strictEqual(prog.getCoachContext('Mẹ').session.fatigueSignal, true)
  })

  await test('profile.weakCategory surfaces when a category averages 10+ below overall', () => {
    const { prog } = makeProg()
    // Strong at static signs
    for (const k of ['Có', 'Không', 'Một', 'Hai']) {
      prog.recordAttempt({ signKey: k, finalScore: 90, stars: 3, attemptId: `s_${k}` })
      prog.recordAttempt({ signKey: k, finalScore: 88, stars: 3, attemptId: `s2_${k}` })
    }
    // Weak at movement signs
    for (const k of ['Xe máy', 'Chạy', 'Đi']) {
      prog.recordAttempt({ signKey: k, finalScore: 55, stars: 1, attemptId: `m_${k}` })
      prog.recordAttempt({ signKey: k, finalScore: 60, stars: 1, attemptId: `m2_${k}` })
    }
    const ctx = prog.getCoachContext('Xe máy')
    assert.strictEqual(ctx.profile.weakCategory, 'dấu chuyển động')
    assert.strictEqual(ctx.profile.strongCategory, 'dấu tĩnh')
  })

  await test('profile categories are null when too little data', () => {
    const { prog } = makeProg()
    prog.recordAttempt({ signKey: 'Có', finalScore: 80, stars: 2, attemptId: 'c1' })
    const ctx = prog.getCoachContext('Có')
    assert.strictEqual(ctx.profile.weakCategory, null)
    assert.strictEqual(ctx.profile.strongCategory, null)
  })

  await test('signHistory is capped so localStorage does not grow unbounded', () => {
    const { prog } = makeProg()
    for (let i = 0; i < 25; i++) {
      prog.recordAttempt({ signKey: 'Mẹ', finalScore: 60 + i, stars: 1, attemptId: `cap_${i}` })
    }
    const raw = prog._getRawState()
    assert.ok(raw.signHistory['Mẹ'].length <= internals.SIGN_HISTORY_CAP,
      `signHistory should cap at ${internals.SIGN_HISTORY_CAP}, got ${raw.signHistory['Mẹ'].length}`)
  })

  // ── Rank ladder (v0.5) ─────────────────────────────────────────────
  console.log('Rank ladder')
  await test('rankForLevel spans the 5-tier ladder', () => {
    const r = internals.rankForLevel
    assert.strictEqual(r(1),  'Đồng')
    assert.strictEqual(r(9),  'Đồng')
    assert.strictEqual(r(10), 'Bạc')
    assert.strictEqual(r(19), 'Bạc')
    assert.strictEqual(r(20), 'Vàng')
    assert.strictEqual(r(29), 'Vàng')
    assert.strictEqual(r(30), 'Bạch kim')
    assert.strictEqual(r(39), 'Bạch kim')
    assert.strictEqual(r(40), 'Kim cương')
    assert.strictEqual(r(99), 'Kim cương')  // clamps at top
  })

  await test('getRank(xp) composes levelFromXp + rankForLevel', () => {
    const g = internals.getRank
    assert.strictEqual(g(0),    'Đồng')        // L1
    assert.strictEqual(g(99),   'Đồng')        // still L1
    assert.strictEqual(g(100),  'Đồng')        // L2
    // Level 10 needs cumulative XP = 100 * 9 * 10 / 2 = 4500
    assert.strictEqual(g(4500), 'Bạc')
    assert.strictEqual(g(4499), 'Đồng')
    // Level 20 needs 100 * 19 * 20 / 2 = 19_000
    assert.strictEqual(g(19_000), 'Vàng')
  })

  await test('prog.getRank() reads the current xp (derived, never stored)', () => {
    const { prog } = makeProg()
    assert.strictEqual(prog.getRank(), 'Đồng')
    prog._state.xp = 4500  // force L10
    assert.strictEqual(prog.getRank(), 'Bạc')
    prog._state.xp = 19_000
    assert.strictEqual(prog.getRank(), 'Vàng')
  })

  await test('getSnapshot includes rank alongside level', () => {
    const { prog } = makeProg()
    const snap = prog.getSnapshot()
    assert.strictEqual(typeof snap.rank, 'string')
    assert.strictEqual(snap.rank, 'Đồng')
  })

  await test('rank:up fires when a level-up crosses a 10-boundary', () => {
    const { prog } = makeProg()
    prog._state.xp = 4400  // L9, Đồng
    const seen = []
    prog.on('rank:up', d => seen.push(d))
    // A single attempt that tips past the L10 boundary.
    prog.recordAttempt({ signKey: 'Chào', finalScore: 100, stars: 3, attemptId: 'rk1' })
    assert.strictEqual(seen.length, 1, 'rank:up fires exactly once')
    assert.strictEqual(seen[0].newRank, 'Bạc')
    assert.strictEqual(seen[0].prevRank, 'Đồng')
    assert.ok(seen[0].newLevel >= 10)
    assert.ok(seen[0].prevLevel < 10)
  })

  await test('rank:up does NOT fire for level-ups inside the same tier', () => {
    const { prog } = makeProg()
    const seen = []
    prog.on('rank:up', d => seen.push(d))
    // Several L1→L2→... level-ups, all still Đồng.
    for (let i = 0; i < 8; i++) {
      prog.recordAttempt({ signKey: 'Chào', finalScore: 100, stars: 3, attemptId: `inside_${i}` })
    }
    assert.strictEqual(seen.length, 0, 'no rank:up while staying in Đồng')
  })

  await test('rank:up reports the NEW tier even when the jump skips over one', () => {
    // The XP formula caps per-attempt gain, so "skip multiple tiers in
    // one recordAttempt" isn't organically reachable. To prove the
    // contract from the spec ("fire one modal for the highest new rank
    // only") we pre-seed xp near a boundary such that levelBefore and
    // levelAfter ranks differ by one tier, and verify the event names
    // the correct endpoints.
    const { prog } = makeProg()
    // L19 (Bạc) is 100*18*19/2 = 17100 cumulative xp. 18999 is one xp
    // short of L20 (Vàng, at 19000). +100 from a 3★ attempt lands L20.
    prog._state.xp = 18999
    const seen = []
    prog.on('rank:up', d => seen.push(d))
    const r = prog.recordAttempt({ signKey: 'Chào', finalScore: 100, stars: 3, attemptId: 'boundary' })
    assert.strictEqual(seen.length, 1)
    assert.strictEqual(seen[0].prevRank, 'Bạc')
    assert.strictEqual(seen[0].newRank, 'Vàng')
    assert.strictEqual(r.rankChanged, true)
  })

  await test('recordAttempt return includes rankBefore/rankAfter/rankChanged', () => {
    const { prog } = makeProg()
    prog._state.xp = 4400  // L9 Đồng
    const r = prog.recordAttempt({ signKey: 'Chào', finalScore: 100, stars: 3, attemptId: 'rA' })
    assert.strictEqual(r.rankBefore, 'Đồng')
    assert.strictEqual(r.rankAfter, 'Bạc')
    assert.strictEqual(r.rankChanged, true)
  })

  await test('SignPathProgression.getRank static matches the instance method', () => {
    const { prog } = makeProg()
    prog._state.xp = 4500
    assert.strictEqual(SignPathProgression.getRank(4500), prog.getRank())
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
