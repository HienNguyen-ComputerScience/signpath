/**
 * Tests for signpath-review.js
 * Run: node signpath-review.test.js
 */
'use strict'

const assert = require('assert')
const { SignPathReview } = require('./signpath-review.js')
const internals = SignPathReview._internals

let _failures = 0, _passed = 0
async function test(name, fn) {
  try { await fn(); _passed++; console.log(`  ✓ ${name}`) }
  catch (e) { _failures++; console.error(`  ✗ ${name}\n    ${e.message}`); if (process.env.DEBUG) console.error(e.stack) }
}

// ─── Mocks ───────────────────────────────────────────────────────────

class MockEngine {
  constructor(lessons, signProgress) {
    this._lessons = lessons || []
    this._sp = signProgress || {}
  }
  getLessons() { return this._lessons }
  getSignProgress(key) { return this._sp[key] || { stars: 0, best: 0, reps: 0 } }
}

class MockProgression {
  constructor() {
    this._mastery = {}
    this._attempts = {}
    this._unlocked = []
  }
  getMasteryLevel(key) { return this._mastery[key] || 0 }
  getAttempts(key) { return this._attempts[key] || 0 }
  getUnlockedLessons() { return this._unlocked.slice() }
  setMastery(key, m) { this._mastery[key] = m }
  setAttempts(key, n) { this._attempts[key] = n }
  unlock(...ids) { for (const id of ids) if (this._unlocked.indexOf(id) === -1) this._unlocked.push(id) }
}

function memStorage() {
  const mem = {}
  return {
    getItem(k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null },
    setItem(k, v) { mem[k] = String(v) },
    removeItem(k) { delete mem[k] },
  }
}

const DEFAULT_LESSONS = [
  { id: 'greetings', signs: [{ key: 'Chào' }, { key: 'Cảm ơn' }, { key: 'Xin lỗi' }] },
  { id: 'numbers', signs: [{ key: 'Một' }, { key: 'Hai' }, { key: 'Ba' }] },
  { id: 'colors', signs: [{ key: 'Màu đỏ' }, { key: 'Màu xanh' }] },
]

function makeReview(opts = {}) {
  const engine = opts.engine || new MockEngine(DEFAULT_LESSONS, {})
  const prog = opts.progression || new MockProgression()
  prog.unlock('greetings')
  const storage = opts.storage || memStorage()
  let tRef = { t: opts.startMs || new Date(2026, 3, 17, 12, 0, 0).getTime() }
  const clock = {
    now: () => tRef.t,
    advanceDays: (n) => { tRef.t += n * internals.DAY_MS },
    advanceMs: (ms) => { tRef.t += ms },
  }
  const review = new SignPathReview(engine, prog, { storage, now: clock.now })
  return { review, engine, prog, storage, clock }
}

// ─── Tests ───────────────────────────────────────────────────────────

async function run() {
  console.log('SignPathReview')

  // ── SM-2 schedule
  await test('first success seeds interval to 1 day', () => {
    const { review, clock } = makeReview()
    const r = review.markReviewed({ signKey: 'Chào', finalScore: 85, attemptId: 'a1' })
    assert.strictEqual(r.interval, 1)
    assert.strictEqual(r.nextReview, clock.now() + internals.DAY_MS)
  })

  await test('subsequent successes grow interval by * ease', () => {
    const { review, clock } = makeReview()
    // First: 0 → 1
    review.markReviewed({ signKey: 'Chào', finalScore: 85, attemptId: 'a1' })
    // Second: 1 * 2.5 = 2.5 → 3
    const r2 = review.markReviewed({ signKey: 'Chào', finalScore: 85, attemptId: 'a2' })
    assert.strictEqual(r2.interval, 3)
    // Third: 3 * 2.5 = 7.5 → 8
    const r3 = review.markReviewed({ signKey: 'Chào', finalScore: 85, attemptId: 'a3' })
    assert.strictEqual(r3.interval, 8)
    // Fourth: 8 * 2.5 = 20
    const r4 = review.markReviewed({ signKey: 'Chào', finalScore: 85, attemptId: 'a4' })
    assert.strictEqual(r4.interval, 20)
  })

  await test('failure resets interval to 1 day and decays ease', () => {
    const { review } = makeReview()
    review.markReviewed({ signKey: 'Chào', finalScore: 85, attemptId: 'a1' })
    review.markReviewed({ signKey: 'Chào', finalScore: 85, attemptId: 'a2' })
    review.markReviewed({ signKey: 'Chào', finalScore: 85, attemptId: 'a3' })
    const before = review.getSrsState('Chào')
    assert.ok(before.interval > 1)
    const r = review.markReviewed({ signKey: 'Chào', finalScore: 50, attemptId: 'fail1' })
    assert.strictEqual(r.interval, 1)
    const after = review.getSrsState('Chào')
    assert.ok(after.ease < before.ease, 'ease should decay')
    assert.ok(after.ease >= internals.MIN_EASE, 'ease floored')
  })

  await test('ease never drops below MIN_EASE', () => {
    const { review } = makeReview()
    for (let i = 0; i < 20; i++) {
      review.markReviewed({ signKey: 'Chào', finalScore: 30, attemptId: `f_${i}` })
    }
    assert.strictEqual(review.getSrsState('Chào').ease, internals.MIN_EASE)
  })

  await test('markReviewed dedupes by attemptId', () => {
    const { review } = makeReview()
    const r1 = review.markReviewed({ signKey: 'Chào', finalScore: 85, attemptId: 'same' })
    const r2 = review.markReviewed({ signKey: 'Chào', finalScore: 85, attemptId: 'same' })
    assert.strictEqual(r1.duplicate, false)
    assert.strictEqual(r2.duplicate, true)
    // State should only reflect one review
    assert.strictEqual(review.getSrsState('Chào').successes, 1)
  })

  await test('ring buffer evicts old IDs after 50', () => {
    const { review } = makeReview()
    for (let i = 0; i < 60; i++) {
      review.markReviewed({ signKey: 'Chào', finalScore: 85, attemptId: `id_${i}` })
    }
    // id_0 should be evicted; id_59 still in ring
    const r0 = review.markReviewed({ signKey: 'Chào', finalScore: 85, attemptId: 'id_0' })
    assert.strictEqual(r0.duplicate, false)
    const r59 = review.markReviewed({ signKey: 'Chào', finalScore: 85, attemptId: 'id_59' })
    assert.strictEqual(r59.duplicate, true)
  })

  // ── Queue prioritization
  await test('getNextSigns: due items come first, sorted by overdue', () => {
    const { review, prog, clock } = makeReview()
    prog.setMastery('Chào', 2); prog.setAttempts('Chào', 3)
    prog.setMastery('Cảm ơn', 2); prog.setAttempts('Cảm ơn', 3)

    // Review both, then advance past their nextReview times
    review.markReviewed({ signKey: 'Chào', finalScore: 85, attemptId: 'a' })
    review.markReviewed({ signKey: 'Cảm ơn', finalScore: 85, attemptId: 'b' })
    // Chào becomes more overdue
    clock.advanceDays(3)
    review.markReviewed({ signKey: 'Cảm ơn', finalScore: 85, attemptId: 'c' })  // refresh Cảm ơn
    clock.advanceDays(3)
    // Now: Chào is 5-6 days overdue, Cảm ơn is 0-1 days overdue (depending on its new interval)
    const queue = review.getNextSigns(5)
    const dueItems = queue.filter(x => x.reason === 'due_for_review')
    assert.ok(dueItems.length >= 1)
    assert.strictEqual(dueItems[0].signKey, 'Chào', 'most overdue first')
  })

  await test('getNextSigns: fills struggling then new when not enough due items', () => {
    const { review, prog } = makeReview()
    // Struggling: Chào at mastery 1, attempts=5
    prog.setMastery('Chào', 1); prog.setAttempts('Chào', 5)
    // Familiar: Cảm ơn at mastery 2, attempts=3 (should not show up as struggling)
    prog.setMastery('Cảm ơn', 2); prog.setAttempts('Cảm ơn', 3)
    // New: Xin lỗi mastery 0
    prog.setMastery('Xin lỗi', 0)

    const queue = review.getNextSigns(5)
    const reasons = queue.map(q => ({ k: q.signKey, r: q.reason }))
    assert.ok(reasons.find(x => x.k === 'Chào' && x.r === 'struggling'), 'Chào should be struggling')
    assert.ok(reasons.find(x => x.k === 'Xin lỗi' && x.r === 'new'), 'Xin lỗi should be new')
    assert.ok(reasons.find(x => x.k === 'Cảm ơn' && x.r === 'maintenance'), 'Cảm ơn (mastery 2, not due) → maintenance')
  })

  await test('getNextSigns: ignores signs in locked lessons', () => {
    const { review, prog } = makeReview()
    // Only greetings is unlocked (default). numbers/colors are locked.
    prog.setMastery('Một', 0)
    prog.setMastery('Màu đỏ', 0)
    const queue = review.getNextSigns(20)
    const keys = queue.map(q => q.signKey)
    assert.strictEqual(keys.indexOf('Một'), -1, 'locked numbers sign should not appear')
    assert.strictEqual(keys.indexOf('Màu đỏ'), -1, 'locked colors sign should not appear')
    assert.ok(keys.indexOf('Chào') !== -1, 'unlocked greetings should appear')
  })

  await test('getNextSigns: unlocking a lesson makes its signs visible', () => {
    const { review, prog } = makeReview()
    let queue = review.getNextSigns(20)
    assert.strictEqual(queue.filter(q => q.signKey === 'Một').length, 0)
    prog.unlock('numbers')
    queue = review.getNextSigns(20)
    assert.ok(queue.find(q => q.signKey === 'Một'))
  })

  await test('getNextSigns respects count limit', () => {
    const { review, prog } = makeReview()
    prog.unlock('numbers', 'colors')
    const queue = review.getNextSigns(3)
    assert.ok(queue.length <= 3)
  })

  await test('getNextSigns returns [] for count <= 0', () => {
    const { review } = makeReview()
    assert.deepStrictEqual(review.getNextSigns(0), [])
    assert.deepStrictEqual(review.getNextSigns(-1), [])
  })

  // ── getReviewQueue
  await test('getReviewQueue returns only due_for_review items', () => {
    const { review, prog, clock } = makeReview()
    prog.setMastery('Chào', 2); prog.setAttempts('Chào', 3)
    prog.setMastery('Cảm ơn', 0)  // new, not due
    review.markReviewed({ signKey: 'Chào', finalScore: 85, attemptId: 'a' })
    clock.advanceDays(2)  // past next review for Chào
    const q = review.getReviewQueue()
    assert.strictEqual(q.length, 1)
    assert.strictEqual(q[0].signKey, 'Chào')
    assert.strictEqual(q[0].reason, 'due_for_review')
  })

  // ── Persistence
  await test('SRS state survives across instances (same storage)', () => {
    const storage = memStorage()
    const engine = new MockEngine(DEFAULT_LESSONS, {})
    const prog = new MockProgression(); prog.unlock('greetings')
    const startMs = Date.now()
    const r1 = new SignPathReview(engine, prog, { storage, now: () => startMs })
    r1.markReviewed({ signKey: 'Chào', finalScore: 85, attemptId: 'x' })
    r1.markReviewed({ signKey: 'Chào', finalScore: 85, attemptId: 'y' })
    const before = r1.getSrsState('Chào')

    const r2 = new SignPathReview(engine, prog, { storage, now: () => startMs })
    assert.deepStrictEqual(r2.getSrsState('Chào'), before)
  })

  await test('successes and failures count correctly', () => {
    const { review } = makeReview()
    review.markReviewed({ signKey: 'Chào', finalScore: 85, attemptId: 'a' })
    review.markReviewed({ signKey: 'Chào', finalScore: 40, attemptId: 'b' })
    review.markReviewed({ signKey: 'Chào', finalScore: 75, attemptId: 'c' })
    const s = review.getSrsState('Chào')
    assert.strictEqual(s.successes, 2)
    assert.strictEqual(s.failures, 1)
  })

  await test('a successful attempt schedules nextReview strictly in the future', () => {
    const { review, clock } = makeReview()
    const r = review.markReviewed({ signKey: 'Chào', finalScore: 85, attemptId: 'a' })
    assert.ok(r.nextReview > clock.now(), 'nextReview must be in the future')
  })

  console.log(`\n${_passed} passed, ${_failures} failed`)
  if (_failures) process.exit(1)
}

run().catch(e => { console.error('Test runner crashed:', e); process.exit(1) })
