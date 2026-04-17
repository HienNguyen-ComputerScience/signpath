/**
 * SignPath Review v1.0 — Spaced repetition queue
 * ================================================
 * Decides "what should the user practice next?" using simplified SM-2.
 *
 * EACH SIGN TRACKS:
 *   ease       — difficulty multiplier (default 2.5, decays on failure)
 *   interval   — days until next review
 *   nextReview — ms epoch timestamp
 *   successes  — cumulative successful reviews
 *   failures   — cumulative failures
 *
 * ON EACH REVIEW (via markReviewed):
 *   Success (finalScore >= 70):
 *     first success: interval = 1 day
 *     subsequent:    interval = round(interval * ease)      (multiplicative SM-2)
 *   Failure (finalScore < 70):
 *     interval = 1 day
 *     ease    = max(MIN_EASE, ease - 0.2)
 *   nextReview = now + interval * DAY_MS
 *
 * NOTE ON THE SM-2 GROWTH FORMULA:
 *   The v1 spec read "increase interval by `interval * ease`". The literal
 *   additive reading (interval += interval*ease) grows very fast (1→4→14→49)
 *   compared to standard SM-2's multiplicative form (interval *= ease giving
 *   1→2.5→6→16). We went with multiplicative because (a) that's what real
 *   SM-2 does and (b) the 1-week-to-7-months curve is what users expect from
 *   an SRS app. Change SM2_MULT_MODE below if this turns out wrong.
 *
 * QUEUE ORDERING FOR getNextSigns(count):
 *   Priority band          Reason              Source
 *   ─────────────────────────────────────────────────────────────────
 *   100 + daysOverdue      'due_for_review'    SRS nextReview <= now
 *   50                     'struggling'        mastery 1 AND attempts >= 3
 *   20                     'new'               mastery 0, in unlocked lesson
 *   5                      'maintenance'       mastery 2-3, not yet due
 *
 *   Fill in that order until we have `count` items.
 *
 * DEDUPE:
 *   markReviewed takes an attemptId and keeps the last DEDUPE_RING_SIZE in a
 *   ring buffer. Repeats are silently ignored. Prevents double-SRS-advance
 *   if a subscriber bug causes attempt:end to fire twice.
 *
 * PERSISTENCE: single localStorage key (LS_KEY).
 *
 * Dependencies:
 *   - engine       (for getLessons + getSignProgress)
 *   - progression  (for getMasteryLevel, getAttempts, getUnlockedLessons)
 */
;(function(global) {
'use strict'

const LS_KEY = 'sp_review_v1'
const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_EASE = 2.5
const MIN_EASE = 1.3
const EASE_DECAY_ON_FAIL = 0.2
const SUCCESS_SCORE_THRESHOLD = 70
const STRUGGLING_ATTEMPTS_THRESHOLD = 3
const DEDUPE_RING_SIZE = 50

// Whether to use multiplicative (`*ease`) or additive (`+interval*ease`) SM-2.
// See module header note.
const SM2_MULT_MODE = true

const REASON_DUE = 'due_for_review'
const REASON_STRUGGLING = 'struggling'
const REASON_NEW = 'new'
const REASON_MAINTENANCE = 'maintenance'

function memoryStorage() {
  const mem = {}
  return {
    getItem(k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null },
    setItem(k, v) { mem[k] = String(v) },
    removeItem(k) { delete mem[k] },
  }
}

function newSrsEntry() {
  return { ease: DEFAULT_EASE, interval: 0, nextReview: 0, successes: 0, failures: 0, lastReviewed: 0 }
}

class SignPathReview {
  constructor(engine, progression, opts) {
    if (!engine) throw new Error('SignPathReview requires an engine')
    if (!progression) throw new Error('SignPathReview requires a progression')
    opts = opts || {}

    this._engine = engine
    this._progression = progression
    this._now = opts.now || function() { return Date.now() }
    this._storage = opts.storage
      || (typeof localStorage !== 'undefined' ? localStorage : memoryStorage())
    this._lsKey = opts.lsKey || LS_KEY

    this._state = this._loadOrInit()
  }

  // ─── LOAD / SAVE ─────────────────────────────────────────────────────

  _defaultState() {
    return {
      srs: {},
      seenAttemptIds: [],
    }
  }

  _loadOrInit() {
    let loaded = null
    try {
      const raw = this._storage.getItem(this._lsKey)
      if (raw) loaded = JSON.parse(raw)
    } catch(e) { /* fresh */ }
    return Object.assign(this._defaultState(), loaded || {})
  }

  _save() {
    try { this._storage.setItem(this._lsKey, JSON.stringify(this._state)) }
    catch(e) { console.error('[review] save failed:', e) }
  }

  // ─── PUBLIC API ──────────────────────────────────────────────────────

  /**
   * Return the top N signs to practice next, ordered by priority desc.
   * Each entry: { signKey, reason, priority, srs? }
   */
  getNextSigns(count) {
    count = count == null ? 10 : Number(count)
    if (!Number.isFinite(count) || count <= 0) return []

    const now = this._now()
    const lessons = (this._engine.getLessons && this._engine.getLessons()) || []
    const unlocked = new Set(this._progression.getUnlockedLessons())

    // Enumerate all signs that are in an unlocked lesson.
    const candidates = []
    for (const lesson of lessons) {
      if (!unlocked.has(lesson.id)) continue
      if (!lesson.signs) continue
      for (const s of lesson.signs) candidates.push(s.key)
    }

    const due = []
    const struggling = []
    const freshlyNew = []
    const maintenance = []
    const taken = new Set()

    for (const key of candidates) {
      if (taken.has(key)) continue
      const srs = this._state.srs[key]
      const mastery = this._progression.getMasteryLevel(key)
      const attempts = this._progression.getAttempts(key)

      if (srs && srs.nextReview && srs.nextReview <= now) {
        const daysOverdue = Math.max(0, (now - srs.nextReview) / DAY_MS)
        due.push({ signKey: key, reason: REASON_DUE, priority: 100 + daysOverdue, srs })
        taken.add(key)
        continue
      }
      if (mastery === 1 && attempts >= STRUGGLING_ATTEMPTS_THRESHOLD) {
        struggling.push({ signKey: key, reason: REASON_STRUGGLING, priority: 50 })
        taken.add(key)
        continue
      }
      if (mastery === 0) {
        freshlyNew.push({ signKey: key, reason: REASON_NEW, priority: 20 })
        taken.add(key)
        continue
      }
      // Otherwise: mastered or familiar and not yet due → maintenance
      maintenance.push({ signKey: key, reason: REASON_MAINTENANCE, priority: 5, srs: srs || null })
    }

    due.sort((a, b) => b.priority - a.priority)

    const out = []
    const push = (arr) => { for (const x of arr) { if (out.length < count) out.push(x) } }
    push(due)
    push(struggling)
    push(freshlyNew)
    push(maintenance)
    return out
  }

  /** Same as getNextSigns but filtered to only due items. */
  getReviewQueue() {
    return this.getNextSigns(Number.MAX_SAFE_INTEGER).filter(x => x.reason === REASON_DUE)
  }

  /**
   * Update SRS state for a sign based on an attempt result.
   * @param {Object} att
   * @param {string} att.signKey
   * @param {number} att.finalScore  — success threshold is SUCCESS_SCORE_THRESHOLD
   * @param {string} [att.attemptId] — used for dedupe
   * @returns {Object} { signKey, interval, nextReview, duplicate? }
   */
  markReviewed(att) {
    if (!att || !att.signKey) return { duplicate: false, noop: true }

    if (att.attemptId) {
      if (this._state.seenAttemptIds.indexOf(att.attemptId) !== -1) {
        return { duplicate: true, signKey: att.signKey }
      }
      this._state.seenAttemptIds.push(att.attemptId)
      if (this._state.seenAttemptIds.length > DEDUPE_RING_SIZE) this._state.seenAttemptIds.shift()
    }

    const signKey = att.signKey
    const score = typeof att.finalScore === 'number' ? att.finalScore : 0
    const success = score >= SUCCESS_SCORE_THRESHOLD
    const now = this._now()

    const prev = this._state.srs[signKey] || newSrsEntry()
    const s = Object.assign({}, prev)

    if (success) {
      if (s.interval === 0) {
        s.interval = 1
      } else if (SM2_MULT_MODE) {
        s.interval = Math.max(1, Math.round(s.interval * s.ease))
      } else {
        s.interval = Math.max(1, Math.round(s.interval + s.interval * s.ease))
      }
      s.successes += 1
    } else {
      s.interval = 1
      s.failures += 1
      s.ease = Math.max(MIN_EASE, s.ease - EASE_DECAY_ON_FAIL)
    }
    s.nextReview = now + s.interval * DAY_MS
    s.lastReviewed = now

    this._state.srs[signKey] = s
    this._save()

    return {
      signKey,
      interval: s.interval,
      nextReview: s.nextReview,
      ease: s.ease,
      successes: s.successes,
      failures: s.failures,
      duplicate: false,
    }
  }

  /** Inspect raw SRS state for a sign (null if never reviewed). */
  getSrsState(signKey) {
    const s = this._state.srs[signKey]
    return s ? Object.assign({}, s) : null
  }

  // Test hooks
  _getRawState() { return this._state }
  _reset() { this._state = this._defaultState(); this._save() }
}

global.SignPathReview = SignPathReview
global.SignPathReview._internals = {
  REASONS: { DUE: REASON_DUE, STRUGGLING: REASON_STRUGGLING, NEW: REASON_NEW, MAINTENANCE: REASON_MAINTENANCE },
  DEFAULT_EASE, MIN_EASE, SUCCESS_SCORE_THRESHOLD, DAY_MS, SM2_MULT_MODE,
}

})(typeof window !== 'undefined' ? window : this);
