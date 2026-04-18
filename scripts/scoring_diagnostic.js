/**
 * Scoring Diagnostic — READ-ONLY.
 *
 * Does NOT modify the engine. Replicates just enough of the scoring math
 * to measure how per-finger scores diverge from whole-frame scores under
 * controlled perturbations, using a REAL template from sign-templates.json.
 *
 * Run:   cd C:\SignPath && node scripts/scoring_diagnostic.js
 *        # optional: node scripts/scoring_diagnostic.js "Cảm ơn"
 *
 * What this tests:
 *   S0. User == template mean exactly                    → expect score 100.
 *   S1. Hand shifted 0.15 in Y across all 21 landmarks   → fingers vs whole-frame.
 *   S2. Face shifted 0.15; hand identical                → ≈ fingers unaffected, whole-frame?
 *   S3. Pose shifted 0.15; hand identical                → ≈ fingers unaffected, whole-frame?
 *   S4. Non-dominant hand zeroed (user uses 1 hand vs 2) → ≈ fingers unaffected, whole-frame?
 *   S5. Pose+face both zeroed (MediaPipe miss)           → ≈ fingers unaffected, whole-frame?
 *   S6. Attempt-1 plausible composite                    → hand shifted + face/pose skewed.
 */

'use strict'

const fs = require('fs')
const path = require('path')

// ─── Constants (copied verbatim from signpath-engine.js — read-only reference) ─
const NUM_FEATURES = 162
const SIM_THRESHOLDS = { high: { floor: 0.55, ceiling: 0.95, passAt: 70 } }

// Fingers within dominant hand (landmarks 1..20, organized in 5 groups)
const FINGER_GROUPS = [
  { name: 'Thumb',  vi: 'Cái',   indices: [1, 2, 3, 4] },
  { name: 'Index',  vi: 'Trỏ',   indices: [5, 6, 7, 8] },
  { name: 'Middle', vi: 'Giữa',  indices: [9, 10, 11, 12] },
  { name: 'Ring',   vi: 'Áp út', indices: [13, 14, 15, 16] },
  { name: 'Pinky',  vi: 'Út',    indices: [17, 18, 19, 20] },
]

// ─── Math helpers (replicated from engine to keep script standalone) ──────────

function simToScoreHigh(sim) {
  const t = SIM_THRESHOLDS.high
  if (sim <= t.floor) return 0
  if (sim >= t.ceiling) return 100
  return Math.round(((sim - t.floor) / (t.ceiling - t.floor)) * 100)
}

// Unweighted cosine over [start, start+len) of two frames.
function cosineUnweighted(a, b, start, len) {
  let dot = 0, nA = 0, nB = 0
  for (let i = start; i < start + len; i++) {
    dot += a[i] * b[i]
    nA += a[i] * a[i]
    nB += b[i] * b[i]
  }
  nA = Math.sqrt(nA); nB = Math.sqrt(nB)
  if (nA < 1e-8 || nB < 1e-8) return 0
  return dot / (nA * nB)
}

// Per-finger cosine — only the 12 floats in that finger's 4 landmarks.
// Mirrors _computeFingerScores in engine exactly.
function fingerCosineFrame(userFrame, tmplFrame, group) {
  let dot = 0, nA = 0, nB = 0
  for (const li of group.indices) {
    for (let c = 0; c < 3; c++) {
      const a = userFrame[li * 3 + c]
      const b = tmplFrame[li * 3 + c]
      dot += a * b; nA += a * a; nB += b * b
    }
  }
  nA = Math.sqrt(nA); nB = Math.sqrt(nB)
  return (nA < 1e-8 || nB < 1e-8) ? 0 : dot / (nA * nB)
}

// Average per-frame cosine over a sequence for a feature range.
function meanCosineOverFrames(userSeq, tmplSeq, start, len) {
  const n = Math.min(userSeq.length, tmplSeq.length)
  let tot = 0
  for (let f = 0; f < n; f++) tot += cosineUnweighted(userSeq[f], tmplSeq[f], start, len)
  return tot / n
}

function fingerScoreSeq(userSeq, tmplSeq, group) {
  const n = Math.min(userSeq.length, tmplSeq.length)
  let tot = 0
  for (let f = 0; f < n; f++) tot += fingerCosineFrame(userSeq[f], tmplSeq[f], group)
  const sim = tot / n
  return { sim, score: simToScoreHigh(sim) }
}

// ─── Load a real template ─────────────────────────────────────────────────────

function loadTemplate(gloss) {
  const p = path.resolve(__dirname, '..', 'signpath-test', 'models', 'sign-templates.json')
  const raw = fs.readFileSync(p, 'utf8')
  const data = JSON.parse(raw)
  const tmpl = data.templates[gloss]
  if (!tmpl) {
    const sample = Object.keys(data.templates).slice(0, 5).join(', ')
    throw new Error(`Template "${gloss}" not found. Samples: ${sample}…`)
  }
  // Convert to sequence of Float32Array for parity with engine
  const seq = tmpl.mean.map(row => Float32Array.from(row))
  return {
    gloss,
    seq,
    frameCount: seq.length,
    sampleCount: tmpl.sampleCount,
    consistency: tmpl.consistency,
  }
}

// ─── Frame construction helpers for test scenarios ────────────────────────────

function cloneSeq(seq) {
  return seq.map(row => Float32Array.from(row))
}

// Apply a (dx, dy, dz) shift to specific feature indices across every frame.
// featureRange: {start, end} both in indices of the 162-float vector.
function shiftRange(seq, start, end, dx, dy, dz) {
  for (const frame of seq) {
    for (let i = start; i < end; i += 3) {
      frame[i]   += dx
      frame[i+1] += dy
      frame[i+2] += dz
    }
  }
  return seq
}

// Zero out a range of features across every frame (simulate MediaPipe miss).
function zeroRange(seq, start, end) {
  for (const frame of seq) {
    for (let i = start; i < end; i++) frame[i] = 0
  }
  return seq
}

// ─── Frame magnitude breakdown (how much "energy" lives where) ───────────────

function energyBreakdown(seq) {
  let hand = 0, nonDom = 0, pose = 0, face = 0, n = 0
  for (const f of seq) {
    for (let i = 0;  i < 63;  i++) hand   += f[i] * f[i]
    for (let i = 63; i < 126; i++) nonDom += f[i] * f[i]
    for (let i = 126;i < 147; i++) pose   += f[i] * f[i]
    for (let i = 147;i < 162; i++) face   += f[i] * f[i]
    n++
  }
  const tot = hand + nonDom + pose + face
  return {
    framesAveraged: n,
    hand:   { ssq: hand/n,   pct: 100*hand/tot },
    nonDom: { ssq: nonDom/n, pct: 100*nonDom/tot },
    pose:   { ssq: pose/n,   pct: 100*pose/tot },
    face:   { ssq: face/n,   pct: 100*face/tot },
    totalSsqPerFrame: tot/n,
  }
}

// ─── Score a user sequence against a template ────────────────────────────────

function fullScenario(label, userSeq, tmplSeq, notes) {
  const wholeFrameSim = meanCosineOverFrames(userSeq, tmplSeq, 0, NUM_FEATURES)
  const wholeFrameScore = simToScoreHigh(wholeFrameSim)
  const domSim = meanCosineOverFrames(userSeq, tmplSeq, 0, 63)
  const nonDomSim = meanCosineOverFrames(userSeq, tmplSeq, 63, 63)
  const poseSim = meanCosineOverFrames(userSeq, tmplSeq, 126, 21)
  const faceSim = meanCosineOverFrames(userSeq, tmplSeq, 147, 15)

  const fingers = FINGER_GROUPS.map(fg => {
    const { sim, score } = fingerScoreSeq(userSeq, tmplSeq, fg)
    return { finger: fg.name + '/' + fg.vi, sim: round4(sim), score }
  })
  const fingerAvg = fingers.reduce((a, f) => a + f.score, 0) / fingers.length

  return {
    label,
    notes,
    wholeFrame: {
      sim: round4(wholeFrameSim),
      score: wholeFrameScore,
    },
    perBand: {
      domHandSim: round4(domSim),
      nonDomHandSim: round4(nonDomSim),
      poseSim: round4(poseSim),
      faceSim: round4(faceSim),
    },
    fingers,
    fingerAvgScore: Math.round(fingerAvg * 10) / 10,
    gap: Math.round((fingerAvg - wholeFrameScore) * 10) / 10,
  }
}

function round4(x) { return Math.round(x * 10000) / 10000 }

// ─── Pretty-printer ──────────────────────────────────────────────────────────

function printScenario(r) {
  console.log('\n────────────────────────────────────────────────────────────────')
  console.log(`  [${r.label}]`)
  if (r.notes) console.log(`  ${r.notes}`)
  console.log('────────────────────────────────────────────────────────────────')
  console.log(`  Whole-frame similarity: ${r.wholeFrame.sim}   →   score ${r.wholeFrame.score}/100`)
  console.log(`  Per-band sims: dom=${r.perBand.domHandSim}  nonDom=${r.perBand.nonDomHandSim}  pose=${r.perBand.poseSim}  face=${r.perBand.faceSim}`)
  console.log('  Finger   | sim    | score')
  for (const f of r.fingers) {
    console.log(`   ${f.finger.padEnd(13)}| ${String(f.sim).padStart(6)} | ${String(f.score).padStart(3)}/100`)
  }
  console.log(`  Finger avg score:  ${r.fingerAvgScore}/100`)
  console.log(`  GAP (finger avg − whole-frame score):  ${r.gap}`)
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  const glossArg = process.argv[2] || 'Cảm ơn'
  const t = loadTemplate(glossArg)
  console.log(`\n╔════════════════════════════════════════════════════════════════╗`)
  console.log(`║  SCORING DIAGNOSTIC — template "${t.gloss}"`)
  console.log(`║  ${t.frameCount} frames, ${t.sampleCount} source samples, consistency=${t.consistency}`)
  console.log(`╚════════════════════════════════════════════════════════════════╝`)

  const energy = energyBreakdown(t.seq)
  console.log('\n  Energy (sum-of-squares per frame) distribution in this template:')
  console.log(`    dom hand:      ${energy.hand.ssq.toFixed(3)}   (${energy.hand.pct.toFixed(1)}%)`)
  console.log(`    non-dom hand:  ${energy.nonDom.ssq.toFixed(3)}   (${energy.nonDom.pct.toFixed(1)}%)`)
  console.log(`    pose (7 pts):  ${energy.pose.ssq.toFixed(3)}   (${energy.pose.pct.toFixed(1)}%)`)
  console.log(`    face (5 pts):  ${energy.face.ssq.toFixed(3)}   (${energy.face.pct.toFixed(1)}%)`)
  console.log(`    TOTAL / frame: ${energy.totalSsqPerFrame.toFixed(3)}`)
  console.log(`  (The section with most energy contributes most to the denominator of the full-frame cosine.)`)

  // ── S0: identical ───────────────────────────────────────────────────
  {
    const user = cloneSeq(t.seq)
    printScenario(fullScenario('S0 — User == template exactly', user, t.seq,
      'Sanity check: identical sequences should score 100.'))
  }

  // ── S1: hand shifted 0.15 in Y, pose+face unchanged ─────────────────
  {
    const user = cloneSeq(t.seq)
    shiftRange(user, 0, 63, 0, 0.15, 0)  // dominant hand only
    printScenario(fullScenario('S1 — Dom hand shifted 0.15 in Y', user, t.seq,
      'Simulates "hand too low": whole dom hand (including wrist) translated downward.'))
  }

  // ── S2: face shifted, hand identical ───────────────────────────────
  {
    const user = cloneSeq(t.seq)
    shiftRange(user, 147, 162, 0, 0.15, 0)
    printScenario(fullScenario('S2 — Face shifted 0.15 in Y (hand identical)', user, t.seq,
      'User is sitting with head lower relative to shoulders than the template average.'))
  }

  // ── S3: pose shifted, hand identical ───────────────────────────────
  {
    const user = cloneSeq(t.seq)
    shiftRange(user, 126, 147, 0, 0.15, 0)
    printScenario(fullScenario('S3 — Pose shifted 0.15 in Y (hand identical)', user, t.seq,
      'Arms/elbows/nose in pose subset shifted relative to shoulder-midpoint origin.'))
  }

  // ── S4: non-dominant hand zeroed ───────────────────────────────────
  {
    const user = cloneSeq(t.seq)
    zeroRange(user, 63, 126)
    printScenario(fullScenario('S4 — Non-dominant hand zeroed', user, t.seq,
      'User signs one-handed; template of a two-handed sign expects the second hand.'))
  }

  // ── S5: pose + face zeroed ─────────────────────────────────────────
  {
    const user = cloneSeq(t.seq)
    zeroRange(user, 126, 162)
    printScenario(fullScenario('S5 — Pose + face zeroed (MediaPipe miss)', user, t.seq,
      'Pose/face detection lost for every frame; carry-forward was never seeded.'))
  }

  // ── S6: composite — hand small shift + pose/face medium shift ─────
  {
    const user = cloneSeq(t.seq)
    shiftRange(user, 0, 63, 0.02, 0.10, 0.02)       // hand modest offset
    shiftRange(user, 126, 147, 0.05, 0.15, 0.05)    // pose more off
    shiftRange(user, 147, 162, 0.08, 0.20, 0.05)    // face most off (user's camera angle differs from templates)
    printScenario(fullScenario('S6 — Attempt-1 plausible composite', user, t.seq,
      'Hand slightly low, user sits at a different camera angle — face + pose skewed vs VSL400 average.'))
  }

  // ── S7: same composite, but zero non-dom explicitly to mimic one-handed ──
  {
    const user = cloneSeq(t.seq)
    shiftRange(user, 0, 63, 0.02, 0.10, 0.02)
    shiftRange(user, 126, 147, 0.05, 0.15, 0.05)
    shiftRange(user, 147, 162, 0.08, 0.20, 0.05)
    zeroRange(user, 63, 126)
    printScenario(fullScenario('S7 — S6 plus non-dom hand zeroed', user, t.seq,
      'Same as S6, but user signed one-handed against a two-handed template.'))
  }

  // ── S8: only slight shifts everywhere ─────────────────────────────
  {
    const user = cloneSeq(t.seq)
    shiftRange(user, 0, 63, 0, 0.05, 0)
    shiftRange(user, 126, 147, 0, 0.05, 0)
    shiftRange(user, 147, 162, 0, 0.05, 0)
    printScenario(fullScenario('S8 — All-small shifts (0.05 Y everywhere)', user, t.seq,
      'Sanity: a genuinely-close attempt should score high.'))
  }

  console.log('\n────────────────────────────────────────────────────────────────')
  console.log('  Scenario summary (finger avg − whole-frame score gap):')
  console.log('  Larger gap = whole-frame scoring is more punishing than finger scoring.')
  console.log('────────────────────────────────────────────────────────────────\n')
}

try {
  main()
} catch (e) {
  console.error('FATAL:', e.message)
  process.exit(1)
}
