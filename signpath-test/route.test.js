/**
 * Tests for route.js — the practice-route predicate used by the
 * result-modal guard in screens/modals.js.
 * Run: node route.test.js
 */
'use strict'

const assert = require('assert')
const { isPracticeRoute } = require('./route.js')

let _failures = 0
let _passed = 0

function test(name, fn) {
  try {
    fn()
    _passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    _failures++
    console.error(`  ✗ ${name}`)
    console.error(`    ${e.message}`)
    if (process.env.DEBUG) console.error(e.stack)
  }
}

console.log('route.isPracticeRoute')

test('matches #practice/<sign> (URL-encoded Vietnamese)', () => {
  assert.strictEqual(isPracticeRoute('#practice/Mẹ'), true)
  assert.strictEqual(isPracticeRoute('#practice/C%E1%BA%A3m%20%C6%A1n'), true)
})

test('matches bare #practice', () => {
  assert.strictEqual(isPracticeRoute('#practice'), true)
})

test('rejects every other route the app can reach', () => {
  assert.strictEqual(isPracticeRoute('#home'), false)
  assert.strictEqual(isPracticeRoute('#dictionary'), false)
  assert.strictEqual(isPracticeRoute('#progress'), false)
  assert.strictEqual(isPracticeRoute('#lesson/greetings'), false)
  assert.strictEqual(isPracticeRoute('#onboarding/1'), false)
  assert.strictEqual(isPracticeRoute(''), false)
})

test('does NOT false-match routes that happen to contain "practice"', () => {
  // '#practiceroom' should NOT pass — the guard must only admit the
  // literal #practice route or its /<sign> subroutes.
  assert.strictEqual(isPracticeRoute('#practiceroom'), false)
  assert.strictEqual(isPracticeRoute('#foo/practice'), false)
  assert.strictEqual(isPracticeRoute('#/practice'), false)
})

test('defensive: non-string input is never a practice route', () => {
  assert.strictEqual(isPracticeRoute(null), false)
  assert.strictEqual(isPracticeRoute(undefined), false)
  assert.strictEqual(isPracticeRoute(42), false)
  assert.strictEqual(isPracticeRoute({}), false)
})

// Integration-ish: simulate the modal route guard that sits at the top of
// showResult by exercising the same predicate the guard uses. If this
// passes, the guard will drop attempts that resolve after nav-away.
test('modal guard contract: result payload is silently dropped off-practice', () => {
  // Simulate `location.hash` for different screens and verify the
  // predicate's answer matches the product rule: only #practice/* renders.
  const simulatedHashes = ['#home', '#dictionary', '#progress', '#lesson/colors', '#onboarding/2']
  for (const h of simulatedHashes) {
    assert.strictEqual(isPracticeRoute(h), false,
      `expected modal to be suppressed on ${h}`)
  }
  // And the positive case still renders.
  assert.strictEqual(isPracticeRoute('#practice/Chào'), true)
})

console.log(`\n${_passed} passed, ${_failures} failed`)
if (_failures) process.exit(1)
