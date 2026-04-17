/**
 * SignPath API v1.0 — Unified facade for the Stitch UI
 * ======================================================
 * One object that bundles engine + coach + session + progression + review +
 * audio and exposes a single event surface. The UI should `new SignPathApp()`
 * and never touch the sub-modules by name unless it needs something the
 * facade doesn't expose.
 *
 * WIRING ORDER (because some modules depend on others):
 *   1. engine       (SignPathEngine) — no deps
 *   2. coach        (SignPathCoach)  — no deps
 *   3. progression  (needs engine)
 *   4. review       (needs engine + progression)
 *   5. session      (needs engine + coach)
 *   6. audio        (no deps)
 *
 * EVENTS THE UI CAN SUBSCRIBE TO via app.on(name, fn):
 *   From engine:       ready, error, tracking, score, progress
 *   From session:      attempt:start, attempt:tick, attempt:end,
 *                      attempt:abort, attempt:coach-update
 *   From progression:  xp:gained, streak:updated, level:up,
 *                      mastery:gained, lesson:unlocked, lesson:completed
 *
 * Unknown event names log a warning and are otherwise ignored — this keeps
 * typos from being silent.
 *
 * Dependencies (load in this order via <script>):
 *   signpath-engine.js, signpath-coach.js,
 *   signpath-session.js, signpath-progression.js, signpath-review.js,
 *   signpath-audio.js, signpath-api.js
 */
;(function(global) {
'use strict'

// Map each forwardable event to the sub-module that emits it.
const EVENT_OWNERS = {
  // engine
  'ready': 'engine',
  'error': 'engine',
  'tracking': 'engine',
  'score': 'engine',
  'progress': 'engine',
  // session
  'attempt:start': 'session',
  'attempt:tick': 'session',
  'attempt:end': 'session',
  'attempt:abort': 'session',
  'attempt:coach-update': 'session',
  // progression
  'xp:gained': 'progression',
  'streak:updated': 'progression',
  'level:up': 'progression',
  'mastery:gained': 'progression',
  'lesson:unlocked': 'progression',
  'lesson:completed': 'progression',
}

// Map stars → tone tier for practiceSign's feedback.
const STARS_TO_TONE = ['fail', 'good', 'good', 'success']

class SignPathApp {
  constructor(opts) {
    opts = opts || {}
    this._opts = opts

    // Inject pre-built modules (used by tests) or construct defaults from
    // class names on the surrounding global. In browser this is `window`;
    // in Node, tests must pass instances in `opts` (since the IIFE `global`
    // in Node is the api module's own exports, not the process-wide global).
    this.engine = opts.engine
      || (global.SignPathEngine ? new global.SignPathEngine() : null)
    if (!this.engine) throw new Error('SignPathApp: engine not provided and SignPathEngine global not found')

    this.coach = opts.coach
      || (global.SignPathCoach ? new global.SignPathCoach() : null)
    // Coach is optional — session tolerates null.

    this.progression = opts.progression
      || (global.SignPathProgression ? new global.SignPathProgression(this.engine, opts) : null)
    if (!this.progression) throw new Error('SignPathApp: progression not provided and SignPathProgression global not found')

    this.review = opts.review
      || (global.SignPathReview ? new global.SignPathReview(this.engine, this.progression, opts) : null)
    if (!this.review) throw new Error('SignPathApp: review not provided and SignPathReview global not found')

    this.session = opts.session
      || (global.SignPathSession ? new global.SignPathSession(this.engine, this.coach, opts) : null)
    if (!this.session) throw new Error('SignPathApp: session not provided and SignPathSession global not found')

    this.audio = opts.audio
      || (global.SignPathAudio ? new global.SignPathAudio(opts) : null)
    if (!this.audio) throw new Error('SignPathApp: audio not provided and SignPathAudio global not found')

    this._initialized = false
  }

  // ─── INIT / TEARDOWN ─────────────────────────────────────────────────

  /**
   * Initialize the engine (camera + MediaPipe). Sub-modules that already
   * exist don't need their own init — they read engine state lazily.
   */
  async init(videoElement, engineOpts) {
    if (this._initialized) return
    if (typeof this.engine.init === 'function') {
      await this.engine.init(videoElement, engineOpts)
    }
    this._initialized = true
  }

  async destroy() {
    try { if (this.session && this.session.isActive()) this.session.cancelAttempt() } catch(_) {}
    try { if (this.audio) this.audio.destroy() } catch(_) {}
    try { if (this.engine && this.engine.destroy) await this.engine.destroy() } catch(_) {}
    this._initialized = false
  }

  // ─── EVENT FORWARDING ────────────────────────────────────────────────

  on(event, fn) {
    const owner = EVENT_OWNERS[event]
    if (!owner) { console.warn(`[app] unknown event: ${event}`); return }
    const mod = this[owner]
    if (!mod) { console.warn(`[app] ${owner} not initialized; cannot subscribe to ${event}`); return }
    mod.on(event, fn)
  }

  off(event, fn) {
    const owner = EVENT_OWNERS[event]
    if (!owner) return
    const mod = this[owner]
    if (mod && mod.off) mod.off(event, fn)
  }

  // ─── HIGH-LEVEL USER FLOW ────────────────────────────────────────────

  /**
   * One-call shortcut: start an attempt, await its end, record to
   * progression + review, play a feedback tone, return the consolidated
   * result. The UI should use this for "Practice" buttons.
   */
  async practiceSign(signKey, durationMs) {
    durationMs = durationMs || 3500
    const attempt = await this.session.startAttempt(signKey, { durationMs })

    if (attempt.aborted) {
      // Don't record XP / SRS for aborted attempts.
      return Object.assign({}, attempt, {
        progression: null,
        review: null,
      })
    }

    const progResult = this.progression.recordAttempt({
      signKey: attempt.signKey,
      finalScore: attempt.finalScore,
      stars: attempt.stars,
      attemptId: attempt.attemptId,
      timestamp: Date.now(),
    })

    const revResult = this.review.markReviewed({
      signKey: attempt.signKey,
      finalScore: attempt.finalScore,
      attemptId: attempt.attemptId,
    })

    // Play a tier-appropriate tone (non-blocking).
    const toneTier = STARS_TO_TONE[attempt.stars] || 'fail'
    try { this.audio.playTone(toneTier) } catch(_) {}
    // 3-star attempts get a bonus "star" chime on top.
    if (attempt.stars === 3) {
      try { this.audio.playTone('star') } catch(_) {}
    }

    return Object.assign({}, attempt, {
      progression: progResult,
      review: revResult,
      toneTier,
    })
  }

  // ─── DATA FACADES FOR UI SCREENS ─────────────────────────────────────

  /**
   * Everything a home/landing screen typically needs. UI can ignore what
   * it doesn't use. Cheap to call — no I/O, just aggregated reads.
   */
  getHomeScreenData() {
    const snap = this.progression.getSnapshot()
    return {
      user: {
        xp: snap.xp,
        level: snap.level,
        nextLevelThreshold: snap.nextLevelThreshold,
        xpIntoLevel: snap.xp - _prevLevelThreshold(snap.level),
        xpForLevel: snap.nextLevelThreshold - _prevLevelThreshold(snap.level),
        masteredCount: snap.masteredCount,
      },
      streak: snap.streak,
      dailyGoal: snap.dailyGoal,
      unlockedLessons: snap.unlockedLessons.slice(),
      completedLessons: snap.completedLessons.slice(),
      nextSigns: this.review.getNextSigns(10),
      totalSigns: this._countAllSigns(),
    }
  }

  /**
   * Data for the screen that shows one lesson's signs.
   * Returns null if lessonId is unknown.
   */
  getLessonScreenData(lessonId) {
    const lessons = this.engine.getLessons ? this.engine.getLessons() : []
    const lesson = lessons.find(l => l.id === lessonId)
    if (!lesson) return null

    const signs = (lesson.signs || []).map(s => {
      const sp = this.engine.getSignProgress ? this.engine.getSignProgress(s.key) : { stars: 0, best: 0, reps: 0 }
      return {
        key: s.key,
        vi: s.vi,
        en: s.en,
        stars: sp.stars || 0,
        best: sp.best || 0,
        mastery: this.progression.getMasteryLevel(s.key),
        attempts: this.progression.getAttempts(s.key),
        srs: this.review.getSrsState(s.key),
      }
    })

    const masteredCount = signs.filter(s => s.mastery === 3).length
    const familiarCount = signs.filter(s => s.mastery >= 2).length

    return {
      id: lesson.id,
      goal: lesson.goal,
      icon: lesson.icon,
      color: lesson.color,
      unlocked: this.progression.isLessonUnlocked(lessonId),
      completed: this.progression.isLessonCompleted(lessonId),
      totalSigns: signs.length,
      masteredCount,
      familiarCount,
      familiarRatio: signs.length ? familiarCount / signs.length : 0,
      signs,
    }
  }

  /** Data for a single sign's detail page. Returns null if unknown. */
  getSignDetailData(signKey) {
    const sign = this.engine.getSign ? this.engine.getSign(signKey) : null
    if (!sign) return null
    const sp = (this.engine.getSignProgress && this.engine.getSignProgress(signKey)) || { stars: 0, best: 0, reps: 0 }
    const template = this.engine.getTemplate ? this.engine.getTemplate(signKey) : null
    return {
      key: sign.key,
      vi: sign.vi,
      en: sign.en,
      unitId: sign.unitId,
      unitGoal: sign.unitGoal,
      unitIcon: sign.unitIcon,
      stars: sp.stars || 0,
      best: sp.best || 0,
      mastery: this.progression.getMasteryLevel(signKey),
      attempts: this.progression.getAttempts(signKey),
      srs: this.review.getSrsState(signKey),
      hasTemplate: !!template,
      templateFrameCount: template ? template.mean.length : 0,
      templateConsistency: template ? template.consistency : null,
    }
  }

  // ─── INTERNAL ────────────────────────────────────────────────────────

  _countAllSigns() {
    const lessons = this.engine.getLessons ? this.engine.getLessons() : []
    let n = 0
    for (const l of lessons) n += (l.signs || []).length
    return n
  }
}

function _prevLevelThreshold(level) {
  if (level <= 1) return 0
  const n = level - 1
  return 100 * n * (n + 1) / 2
}

global.SignPathApp = SignPathApp
global.SignPathApp._eventOwners = EVENT_OWNERS

})(typeof window !== 'undefined' ? window : this);
