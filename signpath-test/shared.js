/**
 * SignPath shared UI helpers
 * ==========================
 * One place for helpers that straddle the engine→UI boundary. Currently
 * hosts the `inflateScore` helper that maps engine output to the number
 * the user actually sees, plus the single hard pass/fail gate.
 *
 * WHY INFLATION LIVES HERE (and not in the engine):
 *   The scoring engine does a tight cosine-based comparison against averaged
 *   templates. Its raw output is honest but psychometrically harsh —
 *   beginners hitting a 48 on a well-formed sign go home demoralised. Product
 *   decision (v0.5): add +20 to every user-facing score and clamp to 100,
 *   with a HARD pass/fail gate at 50 post-inflation. This shifts the UX
 *   curve without touching the engine maths (cosine/bands/per-finger
 *   weights stay tuned against raw scores — changing them would have
 *   cascading effects on the template regression suite).
 *
 *   Net effect:
 *     raw 30  → inflated 50  → pass (bare minimum)
 *     raw 50  → inflated 70
 *     raw 80  → inflated 100 (ceilinged)
 *     raw 29  → inflated 49  → fail
 *
 *   passAt in SIM_THRESHOLDS is INTENTIONALLY IGNORED for UI gating now —
 *   that constant still shapes the engine's internal `passed` flag but the
 *   user-facing gate is solely `inflateScore(raw) >= 50`.
 *
 * Loaded both as a browser <script> (attaches to window.SP) and via Node
 * `require('./shared.js')` (CommonJS export) so tests can verify the math.
 */
;(function() {
  'use strict'

  const INFLATION_BONUS = 20
  const PASS_GATE = 50

  function inflateScore(raw) {
    if (typeof raw !== 'number' || !isFinite(raw)) return 0
    const n = Math.round(raw) + INFLATION_BONUS
    if (n < 0) return 0
    if (n > 100) return 100
    return n
  }

  function inflatedPass(raw) {
    return inflateScore(raw) >= PASS_GATE
  }

  const API = { inflateScore, inflatedPass, INFLATION_BONUS, PASS_GATE }

  if (typeof window !== 'undefined') {
    window.SP = window.SP || {}
    window.SP.inflateScore = inflateScore
    window.SP.inflatedPass = inflatedPass
    window.SP.INFLATION_BONUS = INFLATION_BONUS
    window.SP.PASS_GATE = PASS_GATE
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = API
  }
})();
