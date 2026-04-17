/**
 * Tests for signpath-audio.js (Node-side only — verifies no-op + settings behaviour).
 * Browser audio output is verified manually via signpath-audio.harness.html.
 * Run: node signpath-audio.test.js
 */
'use strict'

const assert = require('assert')
const { SignPathAudio } = require('./signpath-audio.js')

let _failures = 0, _passed = 0
async function test(name, fn) {
  try { await fn(); _passed++; console.log(`  ✓ ${name}`) }
  catch (e) { _failures++; console.error(`  ✗ ${name}\n    ${e.message}`); if (process.env.DEBUG) console.error(e.stack) }
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

async function run() {
  console.log('SignPathAudio (Node-side)')

  await test('constructs without throwing in Node (no Web Audio / Speech)', () => {
    const a = new SignPathAudio({ storage: memStorage() })
    assert.ok(a)
    assert.strictEqual(a.isEnabled(), true)
  })

  await test('speak() resolves (no-op) when speech APIs missing', async () => {
    const a = new SignPathAudio({ storage: memStorage() })
    await a.speak('xin chào', 'vi')  // should not throw
  })

  await test('playTone() no-ops without Web Audio', () => {
    const a = new SignPathAudio({ storage: memStorage() })
    a.playTone('success')  // should not throw
    a.playTone('good')
    a.playTone('fail')
    a.playTone('star')
    a.playTone('unknown-tier')  // should silently skip
  })

  await test('getAvailableVoices returns [] when speech API missing', () => {
    const a = new SignPathAudio({ storage: memStorage() })
    assert.deepStrictEqual(a.getAvailableVoices(), [])
    assert.deepStrictEqual(a.getAvailableVoices('vi'), [])
  })

  await test('setEnabled persists to storage', () => {
    const storage = memStorage()
    const a = new SignPathAudio({ storage })
    a.setEnabled(false)
    assert.strictEqual(a.isEnabled(), false)
    assert.strictEqual(storage.getItem('sp_audio_enabled'), 'false')

    const a2 = new SignPathAudio({ storage })
    assert.strictEqual(a2.isEnabled(), false, 'setting restored on new instance')
  })

  await test('setVoice persists to storage; clear with null', () => {
    const storage = memStorage()
    const a = new SignPathAudio({ storage })
    a.setVoice('Google Vietnamese')
    assert.strictEqual(storage.getItem('sp_audio_voice'), 'Google Vietnamese')
    a.setVoice(null)
    assert.strictEqual(storage.getItem('sp_audio_voice'), null)
  })

  await test('speak is no-op when disabled', async () => {
    const a = new SignPathAudio({ storage: memStorage() })
    a.setEnabled(false)
    // Even if speech API existed, disabled should return immediately
    await a.speak('xin chào')
  })

  await test('tone catalogue matches the spec (4 tiers defined)', () => {
    const tones = SignPathAudio._internals.TONES
    assert.ok(tones.success)
    assert.ok(tones.good)
    assert.ok(tones.fail)
    assert.ok(tones.star)
  })

  await test('destroy() is safe to call even without an AudioContext', () => {
    const a = new SignPathAudio({ storage: memStorage() })
    a.destroy()  // should not throw
    a.destroy()  // idempotent
  })

  console.log(`\n${_passed} passed, ${_failures} failed`)
  if (_failures) process.exit(1)
}

run().catch(e => { console.error('Test runner crashed:', e); process.exit(1) })
