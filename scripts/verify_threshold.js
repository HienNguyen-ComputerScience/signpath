/**
 * verify_threshold.js — run engine template-loader classification on the real
 * sign-templates.json and print the handedness summary. No browser deps used
 * (we only exercise the template-loading portion, which is pure JS + fetch).
 *
 * Run:  cd C:\SignPath && node scripts/verify_threshold.js
 */

'use strict'

const fs = require('fs')
const path = require('path')

// Polyfill fetch() so engine.init() can load the JSON as if it were in a browser.
globalThis.fetch = async (url) => {
  const p = path.resolve(path.dirname(require.resolve('../signpath-test/signpath-engine.js')), url)
  if (!fs.existsSync(p)) throw new Error(`not found: ${p}`)
  const text = fs.readFileSync(p, 'utf8')
  return { ok: true, status: 200, json: async () => JSON.parse(text) }
}

const { SignPathEngine } = require('../signpath-test/signpath-engine.js')

;(async () => {
  const engine = new SignPathEngine()
  // Fake video element — we only need to get through template loading.
  // engine.init will fail later trying to open the camera, but the
  // classification log is emitted by then.
  const fakeVideo = { srcObject: { getTracks: () => [] }, readyState: 0, play: async () => {} }
  try {
    await engine.init(fakeVideo)
  } catch (_) {
    // Expected — camera / MediaPipe won't work in Node. Classification log
    // already fired by the time we'd get here.
  }
  // Also print a direct summary in case console.log pipes got lost.
  const I = SignPathEngine._internals
  const T = I.NONDOM_MOTION_RATIO_THRESHOLD
  const summary = { total: 0, oneHanded: 0, twoHanded: 0, staticDom: 0 }
  for (const tmpl of Object.values(engine._templates)) {
    summary.total++
    const r = tmpl.nonDomMotionRatio
    if (r === 1.0) summary.staticDom++
    else if (r < T) summary.oneHanded++
    else summary.twoHanded++
  }
  console.log('\n─── verify_threshold.js summary ───')
  console.log('  threshold:  ', T)
  console.log('  total:      ', summary.total)
  console.log('  one-handed: ', summary.oneHanded)
  console.log('  two-handed: ', summary.twoHanded)
  console.log('  static-dom: ', summary.staticDom)
  process.exit(0)
})().catch(e => { console.error(e); process.exit(1) })
