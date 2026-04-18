/**
 * analyze_motion_ratios.js — READ-ONLY DATA EXPLORATION.
 *
 * Computes `nonDomMotionRatio` for every template in sign-templates.json and
 * produces a distribution analysis. Does NOT modify the engine, tests, or
 * template files.
 *
 * Outputs:
 *   - scripts/motion_ratios.json    (full per-sign table)
 *   - stdout:  distribution summary, histogram, validation table
 *
 * Run:
 *   cd C:\SignPath && node scripts/analyze_motion_ratios.js
 *   (optional) node scripts/analyze_motion_ratios.js --json-out=some-other-path.json
 */

'use strict'

const fs = require('fs')
const path = require('path')

// ─── Formula — replicated verbatim from signpath-engine.js _computeNonDomMotionRatio ──
// Deliberately standalone (no require of engine) to keep this script free of
// browser-side dependencies and to avoid any coupling that would make the
// analysis drift if the engine is later refactored.

function computeNonDomMotionRatio(meanFrames) {
  const nFrames = meanFrames.length
  if (nFrames < 2) return { ratio: 1.0, domMotion: 0, nonDomMotion: 0 }

  function handMotionAvg(startFeature) {
    let totalExtent = 0
    for (let li = 0; li < 21; li++) {
      const base = startFeature + li * 3
      let minX = Infinity, maxX = -Infinity
      let minY = Infinity, maxY = -Infinity
      let minZ = Infinity, maxZ = -Infinity
      for (let f = 0; f < nFrames; f++) {
        const x = meanFrames[f][base]
        const y = meanFrames[f][base + 1]
        const z = meanFrames[f][base + 2]
        if (x < minX) minX = x; if (x > maxX) maxX = x
        if (y < minY) minY = y; if (y > maxY) maxY = y
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
      }
      totalExtent += Math.max(maxX - minX, maxY - minY, maxZ - minZ)
    }
    return totalExtent / 21
  }

  const domMotion = handMotionAvg(0)
  const nonDomMotion = handMotionAvg(63)

  if (domMotion < 0.01) return { ratio: 1.0, domMotion, nonDomMotion, staticDom: true }

  return { ratio: nonDomMotion / domMotion, domMotion, nonDomMotion, staticDom: false }
}

// ─── CLI args ───────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { jsonOut: path.resolve(__dirname, 'motion_ratios.json') }
  for (const a of argv.slice(2)) {
    if (a.startsWith('--json-out=')) out.jsonOut = path.resolve(a.slice('--json-out='.length))
  }
  return out
}

// ─── Hand-labeled validation sets ──────────────────────────────────────
// Labels based on linguistic knowledge of VSL (and general sign-language
// conventions). Any uncertain ones are omitted rather than guessed.

const LIKELY_ONE_HANDED = [
  // Family (body-referential — dom hand points at/near self; non-dom rests)
  'Mẹ', 'Bố', 'Anh', 'Em', 'Cô', 'Dì', 'Chú', 'Cậu',
  'Ông nội', 'Bà nội', 'Con', 'Cháu',
  // Actions involving one hand moving to/from body
  'Ăn', 'Uống', 'Ngủ', 'Đau', 'Đi', 'Chạy',
  // Descriptors — body-height gesture with one hand
  'Cao (người)', 'Thấp (đồ vật)',
  // Emotions — one-hand facial/body gesture
  'Vui', 'Buồn',
  // Drinks & numbers & food — typically one-hand
  'Năm', 'Bia', 'Cà phê', 'Trứng',
  // Note: 'Tôi' (I/me), 'Muối', 'Đường' were in the prompt but I'll handle
  // absence gracefully during lookup — they may not be in the 400-sign set.
  'Tôi', 'Muối', 'Đường',
]

const LIKELY_TWO_HANDED = [
  // Gratitude / politeness — both hands meet (Cảm ơn, Xin lỗi involve hands
  // brought together at chest)
  'Cảm ơn', 'Xin lỗi',
  // Time — often uses a hand "holding/pointing at" a rotating second hand
  'Tháng', 'Tháng một', 'Tháng hai', 'Chủ nhật',
  // Objects requiring mimed two-hand manipulation
  'Bánh mì', 'Áo đầm', 'Đồng hồ (đeo tay)',
  'Bánh tét', 'Cầu lông',
  // Vehicles/appliances — classic two-hand mimes
  'Ô tô', 'Xe máy', 'Bàn phím', 'Máy giặt', 'Điện thoại',
  // Compound-institution signs — usually multi-hand
  'Gia đình', 'Trường học', 'Bệnh viện', 'Sân bay',
]

// ─── Main ────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv)
  const templatesPath = path.resolve(__dirname, '..', 'signpath-test', 'models', 'sign-templates.json')
  console.log('Loading templates from:', templatesPath)
  const raw = JSON.parse(fs.readFileSync(templatesPath, 'utf8'))
  const glosses = Object.keys(raw.templates)
  console.log(`Templates loaded: ${glosses.length}`)

  // Convert each mean to Float32Array frames for formula-match fidelity.
  const records = []
  for (const gloss of glosses) {
    const mean = raw.templates[gloss].mean.map(r => Float32Array.from(r))
    const { ratio, domMotion, nonDomMotion, staticDom } = computeNonDomMotionRatio(mean)
    records.push({
      gloss,
      ratio,
      domMotion,
      nonDomMotion,
      staticDom: !!staticDom,
      frameCount: mean.length,
      sampleCount: raw.templates[gloss].sampleCount,
    })
  }

  // ── Persist the full table ────────────────────────────────────────────
  fs.writeFileSync(args.jsonOut, JSON.stringify(records, null, 2), 'utf8')
  console.log('Full per-sign table saved to:', args.jsonOut)

  // ── Distribution summary ──────────────────────────────────────────────
  const sorted = records.map(r => r.ratio).slice().sort((a, b) => a - b)
  const pct = (p) => sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1))))]
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length
  const stats = {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean,
    median: pct(0.5),
    deciles: {
      p10: pct(0.10), p20: pct(0.20), p30: pct(0.30), p40: pct(0.40),
      p50: pct(0.50), p60: pct(0.60), p70: pct(0.70), p80: pct(0.80),
      p90: pct(0.90),
    },
  }
  console.log('\n─── Distribution summary ──────────────────────────────')
  console.log(`  n     = ${stats.count}`)
  console.log(`  min   = ${stats.min.toFixed(4)}  (${records.find(r => r.ratio === stats.min).gloss})`)
  console.log(`  max   = ${stats.max.toFixed(4)}  (${records.find(r => r.ratio === stats.max).gloss})`)
  console.log(`  mean  = ${stats.mean.toFixed(4)}`)
  console.log(`  median= ${stats.median.toFixed(4)}`)
  console.log('  Deciles:')
  for (const [k, v] of Object.entries(stats.deciles)) {
    console.log(`    ${k} = ${v.toFixed(4)}`)
  }

  // ── Histogram: buckets of width 0.05 from 0.0 to 1.2 + overflow ──────
  const bucketWidth = 0.05
  const bucketCount = 24  // 0.0 to 1.2
  const hist = new Array(bucketCount + 1).fill(0) // last = overflow (>1.2)
  for (const r of records) {
    if (r.ratio >= 1.2) hist[bucketCount]++
    else hist[Math.floor(r.ratio / bucketWidth)]++
  }
  console.log('\n─── Histogram (bucket width 0.05) ────────────────────')
  const maxCount = Math.max(...hist)
  const barScale = 60 / maxCount
  for (let i = 0; i < bucketCount; i++) {
    const lo = (i * bucketWidth).toFixed(2)
    const hi = ((i + 1) * bucketWidth).toFixed(2)
    const bar = '█'.repeat(Math.round(hist[i] * barScale))
    console.log(`  [${lo}-${hi})  ${String(hist[i]).padStart(3)} ${bar}`)
  }
  if (hist[bucketCount] > 0) {
    const bar = '█'.repeat(Math.round(hist[bucketCount] * barScale))
    console.log(`  [1.20+]       ${String(hist[bucketCount]).padStart(3)} ${bar}`)
  }

  // ── Largest gap in sorted ratios ─────────────────────────────────────
  console.log('\n─── Largest gaps in sorted order ─────────────────────')
  const gaps = []
  for (let i = 1; i < sorted.length; i++) {
    const d = sorted[i] - sorted[i - 1]
    gaps.push({ lo: sorted[i - 1], hi: sorted[i], gap: d })
  }
  gaps.sort((a, b) => b.gap - a.gap)
  console.log('  Top 5 gaps (sorted by size):')
  for (let i = 0; i < 5 && i < gaps.length; i++) {
    const g = gaps[i]
    const loSign = records.find(r => r.ratio === g.lo).gloss
    const hiSign = records.find(r => r.ratio === g.hi).gloss
    console.log(`    ${g.gap.toFixed(4)}: ${g.lo.toFixed(4)} (${loSign}) → ${g.hi.toFixed(4)} (${hiSign})`)
  }

  // ── Validation labels ────────────────────────────────────────────────
  console.log('\n─── Validation table ─────────────────────────────────')
  function lookupAndReport(label, list) {
    console.log(`\n  [${label}]`)
    const results = []
    for (const gloss of list) {
      const rec = records.find(r => r.gloss === gloss)
      if (!rec) { console.log(`    ${gloss.padEnd(22)}  (NOT IN CORPUS)`); continue }
      console.log(`    ${gloss.padEnd(22)}  ratio=${rec.ratio.toFixed(4)}  dom=${rec.domMotion.toFixed(3)}  nonDom=${rec.nonDomMotion.toFixed(3)}`)
      results.push({ gloss, expected: label, ratio: rec.ratio, domMotion: rec.domMotion, nonDomMotion: rec.nonDomMotion })
    }
    return results
  }

  const oneHandedResults = lookupAndReport('LIKELY ONE-HANDED', LIKELY_ONE_HANDED)
  const twoHandedResults = lookupAndReport('LIKELY TWO-HANDED', LIKELY_TWO_HANDED)

  // ── Threshold sensitivity — how labels separate ─────────────────────
  console.log('\n─── Threshold sensitivity on labeled set ─────────────')
  const combined = oneHandedResults.concat(twoHandedResults)
  console.log('  For each candidate threshold, count: ')
  console.log('    correct-1H: labeled one-handed AND ratio < T')
  console.log('    correct-2H: labeled two-handed AND ratio >= T')
  console.log('    wrong-1H:   labeled one-handed but ratio >= T (missed)')
  console.log('    wrong-2H:   labeled two-handed but ratio < T (false positive)')
  console.log('')
  const testThresholds = [0.3, 0.4, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8]
  console.log('  T      correct-1H  correct-2H  wrong-1H  wrong-2H  accuracy')
  for (const T of testThresholds) {
    let c1=0, c2=0, w1=0, w2=0
    for (const r of combined) {
      if (r.expected === 'LIKELY ONE-HANDED') {
        if (r.ratio < T) c1++; else w1++
      } else {
        if (r.ratio >= T) c2++; else w2++
      }
    }
    const total = c1 + c2 + w1 + w2
    const acc = total > 0 ? (c1 + c2) / total : 0
    console.log(`  ${T.toFixed(2)}   ${String(c1).padStart(9)}  ${String(c2).padStart(10)}  ${String(w1).padStart(8)}  ${String(w2).padStart(8)}  ${(acc * 100).toFixed(1)}%`)
  }

  // Return structured values for report consumption
  return { records, stats, hist, bucketWidth, gaps, oneHandedResults, twoHandedResults }
}

try {
  main()
} catch (e) {
  console.error('FATAL:', e.message)
  process.exit(1)
}
