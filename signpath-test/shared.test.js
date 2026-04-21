/**
 * Tests for shared.js — inflateScore / hard pass gate.
 * Run: node shared.test.js
 */
'use strict'

const assert = require('assert')
const { inflateScore, inflatedPass, INFLATION_BONUS, PASS_GATE } = require('./shared.js')

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

console.log('shared.inflateScore / hard pass gate')

test('constants: INFLATION_BONUS=20, PASS_GATE=50 (product spec v0.5)', () => {
  assert.strictEqual(INFLATION_BONUS, 20)
  assert.strictEqual(PASS_GATE, 50)
})

test('raw 0 → inflated 20 (no negative spill)', () => {
  assert.strictEqual(inflateScore(0), 20)
})

test('raw 30 → inflated 50 (bare pass floor)', () => {
  assert.strictEqual(inflateScore(30), 50)
})

test('raw 50 → inflated 70', () => {
  assert.strictEqual(inflateScore(50), 70)
})

test('raw 80 → inflated 100 (clamped at ceiling)', () => {
  assert.strictEqual(inflateScore(80), 100)
})

test('raw 95 → inflated 100 (still clamped)', () => {
  assert.strictEqual(inflateScore(95), 100)
})

test('raw 100 → inflated 100 (clamp invariant)', () => {
  assert.strictEqual(inflateScore(100), 100)
})

test('raw below -BONUS → 0 (floor clamp applies post-inflation)', () => {
  // -5 + 20 = 15 (positive, no clamp needed)
  assert.strictEqual(inflateScore(-5), 15)
  // -25 + 20 = -5 → clamped to 0
  assert.strictEqual(inflateScore(-25), 0)
  assert.strictEqual(inflateScore(-100), 0)
})

test('raw fractional rounds before inflation', () => {
  // 29.4 → round(29.4)=29 → 29+20=49 (fail)
  assert.strictEqual(inflateScore(29.4), 49)
  // 29.5 → round(29.5)=30 → 30+20=50 (pass)
  assert.strictEqual(inflateScore(29.5), 50)
})

test('non-number input → 0 (defensive)', () => {
  assert.strictEqual(inflateScore(null), 0)
  assert.strictEqual(inflateScore(undefined), 0)
  assert.strictEqual(inflateScore('82'), 0)
  assert.strictEqual(inflateScore(NaN), 0)
  assert.strictEqual(inflateScore(Infinity), 0)
})

test('inflatedPass gate: raw 29 fails, raw 30 passes', () => {
  assert.strictEqual(inflatedPass(29), false, 'raw 29 → inflated 49 → fail')
  assert.strictEqual(inflatedPass(30), true,  'raw 30 → inflated 50 → pass')
  assert.strictEqual(inflatedPass(100), true)
  assert.strictEqual(inflatedPass(0), false)
})

test('inflatedPass is idempotent: gate at PASS_GATE exactly', () => {
  // Raw that inflates to exactly 50 must pass (gate is >=, not >).
  assert.strictEqual(inflateScore(30), PASS_GATE)
  assert.strictEqual(inflatedPass(30), true)
})

console.log(`\n${_passed} passed, ${_failures} failed`)
if (_failures) process.exit(1)
