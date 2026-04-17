/**
 * SignPath Session v1.0 — Attempt lifecycle
 * ==========================================
 * Wraps the engine's continuous `score` firehose into discrete "attempts":
 * the unit a learner interacts with. One attempt = one recording → one final
 * score + breakdown + advice.
 *
 * Why the final score is the PEAK (not the average or last):
 *   Signs are brief (often <1s). The peak is the moment the user actually hit
 *   the target pose. Averaging penalises entering/exiting the pose; taking the
 *   last sample penalises users whose hand drifts after signing.
 *
 * Why `prediction === null` AND `tier ∈ {Đang chờ, Waiting}` are both filtered:
 *   The engine's "hand not detected" branch emits placeholder score events
 *   (score:0, prediction:null, tier:'Đang chờ'|'Waiting'). Either condition
 *   alone would suffice today, but checking both survives future engine
 *   refactors where one stops implying the other.
 *
 * Why attemptId flows through every event + dedupe ring buffers downstream:
 *   Prevents double-counted XP / review updates if a subscriber bug causes
 *   attempt:end to be observed twice. Progression + review each keep the last
 *   50 IDs and silently drop repeats.
 *
 * Template-quality defensive default:
 *   Each score event from the engine carries a `quality` field ('high'|'low')
 *   describing the active sign's template tier. Session reads that field
 *   (plus `passAt`) to compute quality-aware stars and surface `quality` +
 *   `passed` on attempt:end. If the field is missing — older engine build,
 *   a test mock that predates the tier system — we default to 'high'. This
 *   matches the engine's own default for templates without a quality field
 *   and keeps back-compat with the 97 pre-tier tests.
 *
 * Dependencies (load via <script> BEFORE this file, or require via Node):
 *   - signpath-engine.js   (for its event contract)
 *   - signpath-coach.js    (optional — session falls back to no advice)
 *
 * Usage:
 *   const session = new SignPathSession(engine, coach)
 *   session.on('attempt:end', r => console.log(r.finalScore, r.stars))
 *   const result = await session.startAttempt('Mẹ', { durationMs: 3500 })
 */
;(function(global) {
'use strict'

const DEFAULT_TICK_MS = 250
const DEFAULT_DURATION_MS = 3500
const LIVE_PREVIEW_WINDOW = 3            // rolling max over last N score samples

// Star thresholds per template-quality tier. Must match engine's per-tier
// arrays. Duplicated here (not imported) because session stays engine-API-
// only; a drift between engine and session stars would be caught by the
// quality-aware tests in signpath-session.test.js.
const STAR_THRESHOLDS_HIGH = [50, 70, 88]
const STAR_THRESHOLDS_LOW  = [55, 70, 80]
// Pass thresholds mirror SIM_THRESHOLDS[quality].passAt in the engine. Only
// used as a fallback when the score event doesn't carry passAt explicitly.
const PASS_THRESHOLDS = { high: 70, low: 55 }

// The engine's no-hand branch uses these localised strings for `tier`.
// Hardcoded here so session stays DOM-free and doesn't import engine strings.
const WAITING_TIERS = ['Đang chờ', 'Waiting']

class SignPathSession {
  constructor(engine, coach, opts) {
    if (!engine) throw new Error('SignPathSession requires an engine')
    opts = opts || {}

    this._engine = engine
    this._coach = coach || null
    this._listeners = {}

    // Injectable for deterministic tests.
    this._tickMs = opts.tickMs || DEFAULT_TICK_MS
    this._defaultDurationMs = opts.defaultDurationMs || DEFAULT_DURATION_MS
    this._setTimeout = opts.setTimeout || function(fn, ms) { return setTimeout(fn, ms) }
    this._clearTimeout = opts.clearTimeout || function(id) { return clearTimeout(id) }
    this._setInterval = opts.setInterval || function(fn, ms) { return setInterval(fn, ms) }
    this._clearInterval = opts.clearInterval || function(id) { return clearInterval(id) }
    this._now = opts.now || function() {
      return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()
    }

    this._active = false
    this._current = null
    this._attemptCounter = 0
    this._scoreHandler = null
    this._tickTimerId = null
    this._endTimerId = null
  }

  // ─── EVENTS ──────────────────────────────────────────────────────────

  on(event, fn) {
    if (!this._listeners[event]) this._listeners[event] = []
    this._listeners[event].push(fn)
  }

  off(event, fn) {
    const arr = this._listeners[event]
    if (arr) this._listeners[event] = arr.filter(f => f !== fn)
  }

  _emit(event, data) {
    const arr = this._listeners[event]
    if (arr) arr.forEach(fn => { try { fn(data) } catch(e) { console.error(`[session] ${event} error:`, e) } })
  }

  // ─── PUBLIC API ──────────────────────────────────────────────────────

  isActive() { return this._active }

  getCurrentAttempt() {
    if (!this._current) return null
    return {
      attemptId: this._current.attemptId,
      signKey: this._current.signKey,
      startTime: this._current.startTime,
      elapsedMs: Math.round(this._now() - this._current.startTime),
    }
  }

  /**
   * Begin an attempt. Returns a Promise that resolves when the attempt
   * ends (normal or manual stop) OR aborts (user cancel / no signing).
   *
   * Normal resolution shape: the same object delivered to attempt:end.
   * Abort resolution shape:  { aborted:true, attemptId, signKey, reason }
   *
   * Never rejects for lifecycle reasons — callers can use
   * `if (result.aborted) ...` if they need to distinguish. Rejects only
   * when preconditions fail (already active, missing signKey).
   */
  startAttempt(signKey, opts) {
    if (this._active) return Promise.reject(new Error('Session already has an active attempt'))
    if (!signKey) return Promise.reject(new Error('startAttempt requires a signKey'))
    opts = opts || {}

    const durationMs = opts.durationMs || this._defaultDurationMs
    const startTime = this._now()
    // Date.now() for the ID so it's a wall-clock timestamp (meaningful across
    // page reloads); counter disambiguates same-millisecond starts.
    const attemptId = `att_${Date.now()}_${++this._attemptCounter}`

    let pendingResolve
    const promise = new Promise(function(resolve) { pendingResolve = resolve })

    this._active = true
    this._current = {
      attemptId,
      signKey,
      startTime,
      durationMs,
      peakScore: 0,
      peakScoreAt: startTime,
      scoreSum: 0,
      scoreCount: 0,
      lastScores: [],
      lastPayload: null,
      pendingResolve,
    }

    // Wire up score listener and select the sign on the engine.
    const self = this
    this._scoreHandler = function(data) { self._onScore(data) }
    this._engine.on('score', this._scoreHandler)
    try { this._engine.selectSign(signKey) } catch(e) { console.error('[session] selectSign failed:', e) }

    // Schedule timers BEFORE emitting attempt:start — so a listener that
    // synchronously calls stopAttempt/cancelAttempt finds valid timer IDs to clear.
    this._tickTimerId = this._setInterval(function() { self._onTick() }, this._tickMs)
    this._endTimerId = this._setTimeout(function() { self._finish('duration') }, durationMs)

    this._emit('attempt:start', { attemptId, signKey, durationMs, startTime })

    return promise
  }

  stopAttempt() {
    if (this._active) this._finish('manual')
  }

  cancelAttempt() {
    if (!this._active || !this._current) return
    const current = this._current
    this._teardown()
    this._current = null
    const abortPayload = {
      aborted: true,
      attemptId: current.attemptId,
      signKey: current.signKey,
      reason: 'user_cancelled',
    }
    this._emit('attempt:abort', {
      attemptId: current.attemptId,
      signKey: current.signKey,
      reason: 'user_cancelled',
    })
    if (current.pendingResolve) current.pendingResolve(abortPayload)
  }

  // ─── INTERNAL ────────────────────────────────────────────────────────

  _onScore(data) {
    if (!this._active || !this._current) return
    if (!data || data.signKey !== this._current.signKey) return
    // Skip the engine's "hand not detected" / waiting branch. See module
    // header for why we check both conditions.
    if (data.prediction === null) return
    if (WAITING_TIERS.indexOf(data.tier) !== -1) return

    const s = typeof data.score === 'number' ? data.score : 0
    const now = this._now()

    if (s > this._current.peakScore) {
      this._current.peakScore = s
      this._current.peakScoreAt = now
    }
    this._current.scoreSum += s
    this._current.scoreCount++

    this._current.lastScores.push(s)
    if (this._current.lastScores.length > LIVE_PREVIEW_WINDOW) this._current.lastScores.shift()

    this._current.lastPayload = data
  }

  _onTick() {
    if (!this._active || !this._current) return
    const elapsedMs = Math.round(this._now() - this._current.startTime)
    const livePreviewScore = this._current.lastScores.length
      ? Math.max.apply(null, this._current.lastScores)
      : 0
    const bufferFrames = (this._current.lastPayload && typeof this._current.lastPayload.bufferFrames === 'number')
      ? this._current.lastPayload.bufferFrames
      : 0
    this._emit('attempt:tick', {
      attemptId: this._current.attemptId,
      elapsedMs,
      livePreviewScore,
      bufferFrames,
    })
  }

  _finish(reason) {
    if (!this._active || !this._current) return
    const current = this._current
    this._teardown()
    this._current = null

    // No compare-case score events ever arrived → user never signed.
    if (current.scoreCount === 0) {
      const abortPayload = {
        aborted: true,
        attemptId: current.attemptId,
        signKey: current.signKey,
        reason: 'no_signing_detected',
      }
      this._emit('attempt:abort', {
        attemptId: current.attemptId,
        signKey: current.signKey,
        reason: 'no_signing_detected',
      })
      if (current.pendingResolve) current.pendingResolve(abortPayload)
      return
    }

    const lastPayload = current.lastPayload
    // Quality + passAt come from the most recent score event. Missing → default
    // to 'high' (see module header for why this is defensive, not a bug).
    const quality = (lastPayload && lastPayload.quality === 'low') ? 'low' : 'high'
    const passAt = (lastPayload && typeof lastPayload.passAt === 'number')
      ? lastPayload.passAt
      : PASS_THRESHOLDS[quality]

    const finalScore = current.peakScore
    const avgScore = Math.round(current.scoreSum / current.scoreCount)
    const stars = _computeStars(finalScore, quality)
    const passed = finalScore >= passAt
    const deviations = lastPayload ? lastPayload.deviations : null
    const lang = (this._engine.getLang && this._engine.getLang()) || 'vi'

    let advice = null
    try {
      if (this._coach && deviations && typeof this._coach.getLocalAdvice === 'function') {
        advice = this._coach.getLocalAdvice(deviations, finalScore, lang) || null
      }
    } catch(e) {
      console.error('[session] getLocalAdvice failed:', e)
    }

    const endTime = this._now()
    const durations = {
      totalMs: Math.round(endTime - current.startTime),
      toPeakMs: Math.round(current.peakScoreAt - current.startTime),
    }

    const endPayload = {
      attemptId: current.attemptId,
      signKey: current.signKey,
      finalScore,
      peakScore: current.peakScore,
      avgScore,
      stars,
      deviations,
      advice,
      durations,
      reason,
      quality,   // 'high' | 'low' — tier of the sign's template
      passed,    // finalScore >= this tier's passAt threshold
    }
    this._emit('attempt:end', endPayload)
    if (current.pendingResolve) current.pendingResolve(endPayload)

    // Fire-and-forget async coach upgrade. Re-emits as attempt:coach-update.
    if (this._coach && deviations && typeof this._coach.getAdvice === 'function') {
      const bufferFrames = (current.lastPayload && typeof current.lastPayload.bufferFrames === 'number')
        ? current.lastPayload.bufferFrames : 30
      const self = this
      Promise.resolve()
        .then(function() { return self._coach.getAdvice(deviations, finalScore, lang, bufferFrames) })
        .then(function(remote) {
          if (remote) {
            self._emit('attempt:coach-update', {
              attemptId: current.attemptId,
              signKey: current.signKey,
              advice: remote,
            })
          }
        })
        .catch(function() { /* coach failures already logged inside the coach */ })
    }
  }

  _teardown() {
    this._active = false
    if (this._scoreHandler) {
      try { this._engine.off('score', this._scoreHandler) } catch(e) {}
      this._scoreHandler = null
    }
    if (this._tickTimerId != null) { this._clearInterval(this._tickTimerId); this._tickTimerId = null }
    if (this._endTimerId != null) { this._clearTimeout(this._endTimerId); this._endTimerId = null }
  }
}

function _computeStars(score, quality) {
  // Defensive default: treat missing / unknown quality as 'high' to preserve
  // back-compat with pre-tier score events.
  const t = quality === 'low' ? STAR_THRESHOLDS_LOW : STAR_THRESHOLDS_HIGH
  if (score >= t[2]) return 3
  if (score >= t[1]) return 2
  if (score >= t[0]) return 1
  return 0
}

global.SignPathSession = SignPathSession
global.SignPathSession.STAR_THRESHOLDS_HIGH = STAR_THRESHOLDS_HIGH
global.SignPathSession.STAR_THRESHOLDS_LOW = STAR_THRESHOLDS_LOW
// Legacy alias — any test that read this under the old name still works.
global.SignPathSession.STAR_THRESHOLDS = STAR_THRESHOLDS_HIGH

})(typeof window !== 'undefined' ? window : this);
