/**
 * SignPath Progression v1.0 — XP, streaks, mastery, lesson unlocks
 * =================================================================
 * Duolingo-style gamification layered on top of the engine's raw
 * stars/best/reps per-sign tracking. The engine tracks whether you have
 * ever scored ≥N on a sign; progression tracks the full arc: cumulative
 * XP, level, whether you practiced today, and which lessons are open.
 *
 * WHY THE PER-SIGN COUNTER IS NAMED `attempts` (not `reps`):
 *   The engine has a `reps` field that only increments when you earn a
 *   NEW star on a sign (signpath-engine.js:866). Once you hit 3 stars it
 *   stops growing. Reading engine.reps for "has the user practiced this
 *   5 times?" gives wrong answers. Progression maintains its own per-sign
 *   `attempts` counter that increments on every recordAttempt() call.
 *   The distinct name prevents later readers from conflating the two.
 *
 * WHY WE IGNORE engine._streak AND engine._lessonsCompleted:
 *   Engine has simpler versions (streak: resets only after >1 day; lesson
 *   completion: stamps stars=1 on every sign as a side effect). Our
 *   semantics are richer (streak resets on any missed day; lesson
 *   completion is a pure observation, no retroactive stamping). Owning
 *   both avoids fighting the engine. The engine's keys stay orphaned.
 *   NOTE: engine.getStats().streak is therefore deprecated — callers
 *   should use progression.getStreak().current instead.
 *
 * XP FORMULA (tune here):
 *   xp = round(max(0, score - 50) * STAR_MULTIPLIER[stars])
 *   STAR_MULTIPLIER = [0, 1, 1.5, 2]
 *   Examples:
 *     100 / 3★ → 50 * 2   = 100 xp
 *     88  / 3★ → 38 * 2   = 76  xp
 *     75  / 2★ → 25 * 1.5 = 38  xp
 *     55  / 1★ →  5 * 1   = 5   xp
 *     40  / 0★ →  0 * 0   = 0   xp
 *
 * LEVEL FORMULA:
 *   Cumulative XP threshold for level N+1 is 100 * N * (N+1) / 2.
 *   Start at L1 with 0 XP. 100 XP → L2. 300 XP → L3. 600 XP → L4. 1000 → L5.
 *
 * STREAK:
 *   Extends on any day the user gained XP. Missed a day → resets to 1 on
 *   next practice. Dates compared as 'YYYY-MM-DD' in local tz — avoids
 *   millisecond-difference bugs around DST transitions.
 *
 * MASTERY (per sign):
 *   0 new       — attempts == 0
 *   1 learning  — attempts > 0 AND best < 70
 *   2 familiar  — best >= 70 AND attempts < 5
 *   3 mastered  — best >= 88 AND attempts >= 5
 *
 * LESSON UNLOCK:
 *   Lesson N unlocks when lesson N-1 has ≥80% of its signs at mastery ≥2.
 *   The first lesson (from engine.getLessons()[0]) is always unlocked.
 *
 * LESSON COMPLETION:
 *   Emits 'lesson:completed' the moment every sign in a lesson first
 *   reaches mastery 3. We do NOT call engine.completeLesson() because
 *   its stamping side effect would misrepresent our mastery state.
 *
 * DEDUPE:
 *   recordAttempt takes an attemptId; progression keeps the last
 *   DEDUPE_RING_SIZE IDs in a ring buffer and silently no-ops on repeats.
 *   Prevents double XP from duplicate attempt:end dispatches.
 *
 * PERSISTENCE:
 *   Single localStorage key (LS_KEY). In Node tests, pass opts.storage.
 */
;(function(global) {
'use strict'

const LS_KEY = 'sp_progression_v1'
const STAR_MULTIPLIER = [0, 1, 1.5, 2]
const MASTERY_FAMILIAR_SCORE = 70
const MASTERY_MASTERED_SCORE = 88
const MASTERY_MASTERED_ATTEMPTS = 5
const LESSON_UNLOCK_THRESHOLD = 0.8
const DEDUPE_RING_SIZE = 50
const DEFAULT_DAILY_GOAL_XP = 50
// Rolling per-sign history retained for coach context (trend + previousBest).
// Capped so localStorage doesn't bloat with long-term usage.
const SIGN_HISTORY_CAP = 10
// A gap of this length without a recorded attempt starts a new session for
// the purposes of fatigue/attempts-this-session tracking.
const SESSION_IDLE_RESET_MS = 30 * 60 * 1000

// Hardcoded category tags for a representative subset of signs. Used to
// detect a learner's weak/strong category. Unknown signs → null (skipped).
const SIGN_CATEGORY_MAP = {
  // dấu chạm mặt — hand contacts face/head
  'Mẹ': 'dấu chạm mặt', 'Bố': 'dấu chạm mặt', 'Cảm ơn': 'dấu chạm mặt',
  'Xin lỗi': 'dấu chạm mặt', 'Ăn': 'dấu chạm mặt', 'Uống': 'dấu chạm mặt',
  'Nghe': 'dấu chạm mặt', 'Nói': 'dấu chạm mặt', 'Khóc': 'dấu chạm mặt',
  'Ngủ': 'dấu chạm mặt', 'Suy nghĩ': 'dấu chạm mặt', 'Hát': 'dấu chạm mặt',
  'Cười': 'dấu chạm mặt',
  // dấu hai tay — both hands involved
  'Gia đình': 'dấu hai tay', 'Họ hàng': 'dấu hai tay', 'Bóng đá': 'dấu hai tay',
  'Bóng rổ': 'dấu hai tay', 'Bơi lội': 'dấu hai tay', 'Cắm trại': 'dấu hai tay',
  'Trường học': 'dấu hai tay', 'Nhà': 'dấu hai tay', 'Bệnh viện': 'dấu hai tay',
  'Sách': 'dấu hai tay', 'Laptop': 'dấu hai tay', 'Máy chiếu': 'dấu hai tay',
  'Thời gian': 'dấu hai tay',
  // dấu chuyển động — significant trajectory
  'Xe máy': 'dấu chuyển động', 'Xe đạp': 'dấu chuyển động', 'Ô tô': 'dấu chuyển động',
  'Xe buýt': 'dấu chuyển động', 'Chạy': 'dấu chuyển động', 'Đi': 'dấu chuyển động',
  'Máy bay': 'dấu chuyển động', 'Tàu hỏa': 'dấu chuyển động', 'Múa': 'dấu chuyển động',
  'Nhanh': 'dấu chuyển động', 'Chậm chạp': 'dấu chuyển động',
  // dấu tĩnh — static / minimal movement
  'Có': 'dấu tĩnh', 'Không': 'dấu tĩnh', 'Một': 'dấu tĩnh', 'Hai': 'dấu tĩnh',
  'Ba': 'dấu tĩnh', 'Bốn': 'dấu tĩnh', 'Năm': 'dấu tĩnh',
  'Đúng': 'dấu tĩnh', 'Sai': 'dấu tĩnh',
}

// ─── Pure helpers ────────────────────────────────────────────────────

function xpForAttempt(score, stars) {
  const mult = STAR_MULTIPLIER[stars] || 0
  return Math.round(Math.max(0, score - 50) * mult)
}

function levelFromXp(xp) {
  // Highest N such that 100 * N * (N+1) / 2 <= xp, plus 1 for L1 baseline.
  let level = 1
  while (100 * level * (level + 1) / 2 <= xp) level++
  return level
}

function nextThresholdForLevel(level) {
  return 100 * level * (level + 1) / 2
}

function ymdLocal(timestampMs) {
  const d = new Date(timestampMs)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// Given ymd 'YYYY-MM-DD', return the ymd string for the previous local day.
function previousYmd(ymd) {
  const [y, m, d] = ymd.split('-').map(Number)
  // Create at noon local time to be immune to DST edges
  const dt = new Date(y, m - 1, d, 12, 0, 0)
  dt.setDate(dt.getDate() - 1)
  return ymdLocal(dt.getTime())
}

function masteryLevel(best, attempts) {
  if (attempts === 0) return 0
  if (best >= MASTERY_MASTERED_SCORE && attempts >= MASTERY_MASTERED_ATTEMPTS) return 3
  if (best >= MASTERY_FAMILIAR_SCORE) return 2
  return 1
}

// Linear-regression slope over sequential scores, in "points per attempt".
// Returns 0 for <2 samples.
function _slope(scores) {
  const n = scores.length
  if (n < 2) return 0
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0
  for (let i = 0; i < n; i++) {
    sumX += i; sumY += scores[i]
    sumXY += i * scores[i]; sumXX += i * i
  }
  const denom = n * sumXX - sumX * sumX
  if (!denom) return 0
  return (n * sumXY - sumX * sumY) / denom
}

// Categorise the current attempt's place in the user's history with this
// sign. `combined` is oldest-first and already includes the pending score.
function _trendFrom(combined, previousBest, pending) {
  if (combined.length <= 1) return 'first'
  const last3 = combined.slice(-3).map(h => h.score)
  const slope = _slope(last3)
  if (pending != null && previousBest != null && pending > previousBest) return 'improving'
  if (slope >= 2) return 'improving'
  if (slope <= -5) return 'declining'
  // attemptCount >= 3 and neither direction stuck out → plateaued.
  // For 2 attempts, we have too little signal to call a plateau — treat
  // the second attempt as a continuation of 'first-ish' via 'plateaued'
  // so the prompt template still has a valid label.
  return 'plateaued'
}

// Compare the first five attempts of this session to the last five. Fatigue
// triggers if the tail is 10+ points below the head. Needs at least 10
// samples to fire — short sessions are always called "not fatigued".
function _fatigueSignalFrom(sessionAttempts) {
  if (sessionAttempts.length < 10) return false
  const firstFive = sessionAttempts.slice(0, 5)
  const lastFive = sessionAttempts.slice(-5)
  const avg = arr => arr.reduce((s, a) => s + a.score, 0) / arr.length
  return avg(firstFive) - avg(lastFive) >= 10
}

// ─── In-memory storage shim (for Node / tests) ───────────────────────

function memoryStorage() {
  const mem = {}
  return {
    getItem(k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null },
    setItem(k, v) { mem[k] = String(v) },
    removeItem(k) { delete mem[k] },
  }
}

// ─── Class ───────────────────────────────────────────────────────────

class SignPathProgression {
  constructor(engine, opts) {
    if (!engine) throw new Error('SignPathProgression requires an engine')
    opts = opts || {}

    this._engine = engine
    this._listeners = {}
    this._now = opts.now || function() { return Date.now() }
    this._storage = opts.storage
      || (typeof localStorage !== 'undefined' ? localStorage : memoryStorage())
    this._lsKey = opts.lsKey || LS_KEY

    this._state = this._loadOrInit()

    // Session-scope tracking lives in memory only. A page refresh or a 30+
    // minute idle gap starts a fresh session, which is exactly what the
    // coach means by "this session" (fatigue signal, attempts-this-session).
    this._sessionAttempts = []   // [{ signKey, score, timestamp }, ...]
    this._sessionStart = null
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
    if (arr) arr.forEach(fn => { try { fn(data) } catch(e) { console.error(`[progression] ${event} error:`, e) } })
  }

  // ─── LOAD / SAVE ─────────────────────────────────────────────────────

  _defaultState() {
    return {
      xp: 0,
      currentStreak: 0,
      longestStreak: 0,
      lastActiveDate: null,
      signAttempts: {},               // signKey → int
      signHistory: {},                // signKey → [{score, timestamp}, ...] (capped)
      signMasteryCache: {},           // signKey → 0|1|2|3
      unlockedLessons: [],            // lesson IDs
      completedLessons: [],           // lesson IDs
      dailyGoalXp: DEFAULT_DAILY_GOAL_XP,
      dailyProgress: { date: null, xp: 0 },
      seenAttemptIds: [],             // ring buffer
    }
  }

  _loadOrInit() {
    let loaded = null
    try {
      const raw = this._storage.getItem(this._lsKey)
      if (raw) loaded = JSON.parse(raw)
    } catch(e) { /* corrupted → fresh */ }
    const def = this._defaultState()
    // Merge so new fields (added in future versions) get defaults
    return Object.assign(def, loaded || {})
  }

  _save() {
    try {
      this._storage.setItem(this._lsKey, JSON.stringify(this._state))
    } catch(e) {
      console.error('[progression] save failed:', e)
    }
  }

  // ─── PUBLIC: QUERY ───────────────────────────────────────────────────

  getXp() { return this._state.xp }

  getLevel() { return levelFromXp(this._state.xp) }

  getNextLevelThreshold() {
    return nextThresholdForLevel(this.getLevel())
  }

  getStreak() {
    const todayYmd = ymdLocal(this._now())
    return {
      current: this._state.currentStreak,
      longest: this._state.longestStreak,
      lastActiveDate: this._state.lastActiveDate,
      didSignToday: this._state.lastActiveDate === todayYmd,
    }
  }

  getMasteryLevel(signKey) {
    const attempts = this._state.signAttempts[signKey] || 0
    if (attempts === 0) return 0
    const sp = this._engine.getSignProgress(signKey)
    const best = (sp && sp.best) || 0
    return masteryLevel(best, attempts)
  }

  getAttempts(signKey) {
    return this._state.signAttempts[signKey] || 0
  }

  getMasteredCount() {
    // Iterate over all signs we have attempts for
    let count = 0
    for (const key in this._state.signAttempts) {
      if (this.getMasteryLevel(key) === 3) count++
    }
    return count
  }

  isLessonUnlocked(lessonId) {
    return this._state.unlockedLessons.indexOf(lessonId) !== -1
  }

  getUnlockedLessons() {
    // Refresh first so a fresh query always reflects the current mastery state.
    this._refreshUnlocks()
    return this._state.unlockedLessons.slice()
  }

  isLessonCompleted(lessonId) {
    return this._state.completedLessons.indexOf(lessonId) !== -1
  }

  getDailyGoal() {
    const todayYmd = ymdLocal(this._now())
    const dp = this._state.dailyProgress || { date: null, xp: 0 }
    const progress = dp.date === todayYmd ? dp.xp : 0
    return {
      target: this._state.dailyGoalXp,
      progress,
      met: progress >= this._state.dailyGoalXp,
      date: todayYmd,
    }
  }

  setDailyGoal(xp) {
    const n = Number(xp)
    if (!Number.isFinite(n) || n <= 0) return
    this._state.dailyGoalXp = Math.round(n)
    this._save()
  }

  getSnapshot() {
    this._refreshUnlocks()  // ensure fresh
    return {
      xp: this._state.xp,
      level: this.getLevel(),
      nextLevelThreshold: this.getNextLevelThreshold(),
      streak: this.getStreak(),
      dailyGoal: this.getDailyGoal(),
      unlockedLessons: this._state.unlockedLessons.slice(),
      completedLessons: this._state.completedLessons.slice(),
      masteredCount: this.getMasteredCount(),
    }
  }

  /**
   * Bundle everything the coach needs to write a context-aware sentence.
   * Safe to call before OR after recordAttempt — pass opts.pendingScore to
   * fold the not-yet-recorded current attempt into the returned numbers.
   * Returns the shape documented in the ENRICHED_COACH task: sign / session /
   * profile. No localStorage writes.
   *
   * @param {string} signKey
   * @param {Object} [opts]
   * @param {number} [opts.pendingScore] current attempt's score, not yet in history
   * @param {number} [opts.now] override "now" for deterministic tests
   */
  getCoachContext(signKey, opts) {
    opts = opts || {}
    const now = typeof opts.now === 'number' ? opts.now : this._now()
    const pending = (typeof opts.pendingScore === 'number') ? opts.pendingScore : null

    const history = (this._state.signHistory[signKey] || []).slice()
    const combined = pending != null
      ? history.concat([{ score: pending, timestamp: now }])
      : history

    const attemptCount = combined.length
    const recentScores = combined.slice(-5).map(h => h.score)
    const previousBest = history.length
      ? history.reduce((m, h) => h.score > m ? h.score : m, -Infinity)
      : null
    const trend = _trendFrom(combined, previousBest, pending)

    let daysSinceLastAttempt = null
    if (history.length) {
      const lastTs = history[history.length - 1].timestamp
      daysSinceLastAttempt = Math.max(0, Math.floor((now - lastTs) / 86400000))
    }

    // Session-scope. Fold the pending attempt in if caller provided one —
    // getCoachContext is called from session._finish before recordAttempt.
    const sessionAttempts = this._sessionAttempts.slice()
    if (pending != null) {
      const lastSessTs = sessionAttempts.length
        ? sessionAttempts[sessionAttempts.length - 1].timestamp
        : null
      if (lastSessTs == null || (now - lastSessTs) > SESSION_IDLE_RESET_MS) {
        sessionAttempts.length = 0  // fresh session, pending starts it
      }
      sessionAttempts.push({ signKey, score: pending, timestamp: now })
    }
    const attemptsThisSession = sessionAttempts.length
    const fatigueSignal = _fatigueSignalFrom(sessionAttempts)

    const profile = {
      level: this.getLevel(),
      totalSignsMastered: this.getMasteredCount(),
    }
    const catStats = this._getCategoryStats(pending != null ? { signKey, score: pending } : null)
    profile.weakCategory = catStats.weak
    profile.strongCategory = catStats.strong

    return {
      sign: {
        attemptCount,
        previousBest: (previousBest == null || previousBest === -Infinity) ? null : previousBest,
        recentScores,
        trend,
        daysSinceLastAttempt,
      },
      session: {
        attemptsThisSession,
        fatigueSignal,
      },
      profile,
    }
  }

  _getCategoryStats(pendingAttempt) {
    // Aggregate per-category scores from signHistory + optional pending attempt.
    const byCategory = {}
    let overallSum = 0, overallCount = 0
    const push = (signKey, score) => {
      const cat = SIGN_CATEGORY_MAP[signKey]
      if (!cat) return
      if (!byCategory[cat]) byCategory[cat] = { sum: 0, count: 0 }
      byCategory[cat].sum += score
      byCategory[cat].count += 1
      overallSum += score
      overallCount += 1
    }
    for (const key in this._state.signHistory) {
      for (const a of this._state.signHistory[key]) push(key, a.score)
    }
    if (pendingAttempt) push(pendingAttempt.signKey, pendingAttempt.score)

    if (overallCount < 10) return { weak: null, strong: null }
    const overallAvg = overallSum / overallCount
    let minAvg = Infinity, minCat = null
    let maxAvg = -Infinity, maxCat = null
    for (const cat in byCategory) {
      const s = byCategory[cat]
      if (s.count < 3) continue  // too little signal for this category
      const avg = s.sum / s.count
      if (avg < minAvg) { minAvg = avg; minCat = cat }
      if (avg > maxAvg) { maxAvg = avg; maxCat = cat }
    }
    return {
      weak: (minCat && (overallAvg - minAvg) >= 10) ? minCat : null,
      strong: (maxCat && (maxAvg - overallAvg) >= 10) ? maxCat : null,
    }
  }

  // ─── PUBLIC: MUTATE ──────────────────────────────────────────────────

  /**
   * Record a completed attempt.
   * @param {Object} att
   * @param {string} att.signKey
   * @param {number} att.finalScore  0..100
   * @param {number} att.stars       0..3 (derived by session)
   * @param {number} [att.timestamp] ms since epoch; defaults to now
   * @param {string} [att.attemptId] unique ID; duplicates are silently ignored
   * @returns {Object} { xpGained, levelBefore, levelAfter, streakExtended, masteryChange, achievementsUnlocked, duplicateAttempt }
   */
  recordAttempt(att) {
    if (!att || !att.signKey) {
      console.warn('[progression] recordAttempt: missing signKey')
      return this._noOpResult()
    }

    // Dedupe by attemptId
    if (att.attemptId) {
      if (this._state.seenAttemptIds.indexOf(att.attemptId) !== -1) {
        return this._noOpResult(true /* duplicate */)
      }
      this._state.seenAttemptIds.push(att.attemptId)
      if (this._state.seenAttemptIds.length > DEDUPE_RING_SIZE) {
        this._state.seenAttemptIds.shift()
      }
    }

    const timestamp = typeof att.timestamp === 'number' ? att.timestamp : this._now()
    const signKey = att.signKey
    const score = typeof att.finalScore === 'number' ? att.finalScore : 0
    const stars = typeof att.stars === 'number' ? att.stars : 0
    const achievements = []

    // 1. Attempts counter
    this._state.signAttempts[signKey] = (this._state.signAttempts[signKey] || 0) + 1

    // 1b. Per-sign rolling history (for coach trend detection).
    if (!this._state.signHistory[signKey]) this._state.signHistory[signKey] = []
    this._state.signHistory[signKey].push({ score, timestamp })
    if (this._state.signHistory[signKey].length > SIGN_HISTORY_CAP) {
      this._state.signHistory[signKey].shift()
    }

    // 1c. In-memory session tracking. Idle gap → fresh session.
    const lastSessionAttempt = this._sessionAttempts.length
      ? this._sessionAttempts[this._sessionAttempts.length - 1].timestamp
      : null
    if (lastSessionAttempt == null || (timestamp - lastSessionAttempt) > SESSION_IDLE_RESET_MS) {
      this._sessionStart = timestamp
      this._sessionAttempts = []
    }
    this._sessionAttempts.push({ signKey, score, timestamp })

    // 2. XP
    const xpGained = xpForAttempt(score, stars)
    const levelBefore = levelFromXp(this._state.xp)
    this._state.xp += xpGained
    const levelAfter = levelFromXp(this._state.xp)

    // 3. Daily progress (reset if date rolled over)
    const todayYmd = ymdLocal(timestamp)
    if (this._state.dailyProgress.date !== todayYmd) {
      this._state.dailyProgress = { date: todayYmd, xp: 0 }
    }
    this._state.dailyProgress.xp += xpGained

    // 4. Streak — only moves if user earned XP today
    let streakExtended = false
    if (xpGained > 0) {
      const last = this._state.lastActiveDate
      if (last === todayYmd) {
        // Already counted today, nothing to do
      } else if (last === previousYmd(todayYmd)) {
        this._state.currentStreak += 1
        streakExtended = true
      } else {
        // Missed one+ days, or first-ever active day
        this._state.currentStreak = 1
        streakExtended = true
      }
      this._state.lastActiveDate = todayYmd
      if (this._state.currentStreak > this._state.longestStreak) {
        this._state.longestStreak = this._state.currentStreak
      }
    }

    // 5. Mastery — compare to cached prior level
    const newMastery = this.getMasteryLevel(signKey)
    const prevMastery = (this._state.signMasteryCache[signKey] != null)
      ? this._state.signMasteryCache[signKey] : 0
    let masteryChange = null
    if (newMastery !== prevMastery) {
      masteryChange = { signKey, before: prevMastery, after: newMastery }
      this._state.signMasteryCache[signKey] = newMastery
      if (newMastery > prevMastery) {
        achievements.push({ type: 'mastery', signKey, masteryLevel: newMastery })
      }
    }

    // 6. Unlocks — re-evaluate since mastery may have changed
    const newlyUnlocked = this._refreshUnlocks()
    newlyUnlocked.forEach(id => achievements.push({ type: 'lesson', lessonId: id }))

    // 7. Lesson completion
    const newlyCompleted = this._refreshCompletions()

    // 8. Persist
    this._save()

    // 9. Emit in a stable order
    if (xpGained > 0) this._emit('xp:gained', { amount: xpGained, source: 'attempt', totalXp: this._state.xp })
    if (streakExtended) this._emit('streak:updated', {
      currentStreak: this._state.currentStreak,
      longestStreak: this._state.longestStreak,
      didExtendToday: true,
    })
    if (levelAfter > levelBefore) {
      this._emit('level:up', { newLevel: levelAfter, prevLevel: levelBefore, xp: this._state.xp })
      achievements.push({ type: 'level', level: levelAfter })
    }
    if (masteryChange && masteryChange.after > masteryChange.before) {
      this._emit('mastery:gained', { signKey, masteryLevel: newMastery })
    }
    newlyUnlocked.forEach(id => this._emit('lesson:unlocked', { lessonId: id }))
    newlyCompleted.forEach(id => {
      this._emit('lesson:completed', { lessonId: id })
      achievements.push({ type: 'lesson_completed', lessonId: id })
    })

    return {
      xpGained,
      levelBefore,
      levelAfter,
      streakExtended,
      masteryChange,
      achievementsUnlocked: achievements,
      duplicateAttempt: false,
    }
  }

  // ─── INTERNAL ────────────────────────────────────────────────────────

  _noOpResult(duplicate) {
    return {
      xpGained: 0,
      levelBefore: this.getLevel(),
      levelAfter: this.getLevel(),
      streakExtended: false,
      masteryChange: null,
      achievementsUnlocked: [],
      duplicateAttempt: !!duplicate,
    }
  }

  /**
   * Re-evaluate which lessons should be unlocked based on current mastery.
   * Returns array of lesson IDs that became unlocked this call.
   */
  _refreshUnlocks() {
    const lessons = (this._engine.getLessons && this._engine.getLessons()) || []
    if (!lessons.length) return []
    const newlyUnlocked = []
    // First lesson is always unlocked
    if (!this.isLessonUnlocked(lessons[0].id)) {
      this._state.unlockedLessons.push(lessons[0].id)
      newlyUnlocked.push(lessons[0].id)
    }
    for (let i = 1; i < lessons.length; i++) {
      const id = lessons[i].id
      if (this.isLessonUnlocked(id)) continue
      const prev = lessons[i - 1]
      if (this._lessonFamiliarRatio(prev) >= LESSON_UNLOCK_THRESHOLD) {
        this._state.unlockedLessons.push(id)
        newlyUnlocked.push(id)
      }
    }
    return newlyUnlocked
  }

  _refreshCompletions() {
    const lessons = (this._engine.getLessons && this._engine.getLessons()) || []
    const newlyCompleted = []
    for (const lesson of lessons) {
      if (this.isLessonCompleted(lesson.id)) continue
      if (!lesson.signs || !lesson.signs.length) continue
      const allMastered = lesson.signs.every(s => this.getMasteryLevel(s.key) === 3)
      if (allMastered) {
        this._state.completedLessons.push(lesson.id)
        newlyCompleted.push(lesson.id)
      }
    }
    return newlyCompleted
  }

  _lessonFamiliarRatio(lesson) {
    if (!lesson.signs || !lesson.signs.length) return 0
    let familiar = 0
    for (const s of lesson.signs) {
      if (this.getMasteryLevel(s.key) >= 2) familiar++
    }
    return familiar / lesson.signs.length
  }

  // ─── TEST / DEBUG HOOKS ──────────────────────────────────────────────
  // Useful for tests; not part of the UI contract.
  _getRawState() { return this._state }
  _reset() {
    this._state = this._defaultState()
    this._save()
  }
}

global.SignPathProgression = SignPathProgression
global.SignPathProgression._internals = {
  xpForAttempt, levelFromXp, nextThresholdForLevel,
  ymdLocal, previousYmd, masteryLevel,
  _trendFrom, _fatigueSignalFrom, _slope,
  STAR_MULTIPLIER, LESSON_UNLOCK_THRESHOLD,
  SIGN_CATEGORY_MAP, SESSION_IDLE_RESET_MS, SIGN_HISTORY_CAP,
}

})(typeof window !== 'undefined' ? window : this);
