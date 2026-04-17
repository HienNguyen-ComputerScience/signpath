# SignPath Backend — Build Report

_Runtime backend for the SignPath VSL learning web app. Six new JavaScript
modules + one optional Node server, all zero-DOM and testable from Node._

Tests:

| Suite                           | Tests | Status |
|---------------------------------|-------|--------|
| `signpath-session.test.js`      | 20    | ✓      |
| `signpath-progression.test.js`  | 25    | ✓      |
| `signpath-review.test.js`       | 16    | ✓      |
| `signpath-audio.test.js`        | 9     | ✓      |
| `signpath-api.test.js`          | 16    | ✓      |
| `coach-proxy/test.js`           | 11    | ✓      |
| **Total**                       | **97**| **✓**  |

Run everything:

```bash
cd signpath-test
for f in signpath-*.test.js; do node "$f" || exit 1; done
cd ../coach-proxy && node test.js
```

---

## What was built

### `signpath-session.js` — Attempt lifecycle
Wraps the engine's 200 ms `score` firehose into discrete attempts. Exposes
`startAttempt / stopAttempt / cancelAttempt / isActive / getCurrentAttempt`,
emits `attempt:start|tick|end|abort|coach-update`, and returns the end
payload via a Promise so `await session.startAttempt(key)` works. Final
score is the peak (not average or last). No-hand / waiting engine events
are filtered via both `prediction === null` AND `tier ∈ {Đang chờ, Waiting}`
for defensive redundancy. **Tested:** 20 tests covering peak-score logic
over `[40, 60, 80, 50, 30]`, star thresholds at 50/70/88, manual-stop vs
duration-timeout, abort on no-signing, attemptId uniqueness, waiting-event
filtering, wrong-sign-key filtering, coach-update async path, and listener
cleanup. **Deferred:** nothing.

### `signpath-progression.js` — XP, streaks, mastery, unlocks
All Duolingo-style gamification: cumulative XP, level derivation, YYYY-MM-DD
local-tz streak tracking, per-sign mastery (0 new, 1 learning, 2 familiar,
3 mastered), lesson unlocks at ≥80% mastery 2+ in the previous lesson, daily
goal tracking with automatic date-rollover reset. **Per-sign counter is
named `attempts` (not `reps`)** to visibly distinguish it from the engine's
`reps` field — module header explains why at length. Single localStorage
key, in-memory storage shim for Node tests. Dedupe ring buffer (last 50
attempt IDs). **Tested:** 25 tests including table-driven XP formula, level
thresholds (0→L1, 100→L2, 300→L3, 600→L4, 1000→L5), simulated-day streak
sequences with missed-day resets, 0-XP attempts not extending streaks,
mastery transitions across best+attempts dimensions, 60% vs 80% lesson
unlock threshold, dedupe correctness including ring-buffer eviction at
item 51, corrupted-storage fallback, month/year boundary date math.

### `signpath-review.js` — Spaced repetition queue
Simplified SM-2: each sign tracks `ease` (default 2.5, decays by 0.2 on
failure, floored at MIN_EASE=1.3), `interval` (days), `nextReview` (ms
timestamp). On success (score≥70): first success seeds interval to 1, then
`interval = round(interval * ease)`. On failure: interval resets to 1,
ease decays. `getNextSigns(count)` returns `{signKey, reason, priority}`
triples ordered due → struggling → new → maintenance. Signs in locked
lessons are filtered out. Dedupe ring buffer. **Tested:** 16 tests using a
fake clock that steps days forward to verify the schedule (1→3→8→20-day
progression), failure reset + ease decay, ease floor, queue prioritisation
when due items are scarce, locked-lesson filtering, unlock visibility,
persistence round-trip.

### `signpath-audio.js` — TTS + procedural tones
Speech via Web Speech API with `vi-VN → vi → lang containing 'vi' → default
with warning` voice fallback chain; setVoice persisted. Four procedurally
generated tones (no audio files): `success` (C-E-G arpeggio), `good` (E5),
`fail` (A4→E4 glide), `star` (A5 + E6 bell). Everything no-ops safely in
Node or without browser APIs. **Tested:** 9 Node-side tests for no-op
safety, settings persistence, enabled/disabled gating, method signatures.
**Browser-side:** `signpath-audio.harness.html` is a manual-test page with
buttons for each tone + a text-to-speech panel — open it in a browser to
verify audio output. The automated CI can't verify audio samples.

### `signpath-api.js` — Unified facade
The one object the Stitch UI should import. Constructor instantiates (or
accepts injected) engine, coach, session, progression, review, audio in
the correct dependency order and throws a clear error if a required class
is missing. `app.practiceSign(signKey, durationMs)` is the one-call
shortcut: runs an attempt, records to progression + review, plays a
star-tier-appropriate tone (3 stars gets `success` + `star` bonus),
returns the consolidated result. Three data facades (`getHomeScreenData`,
`getLessonScreenData`, `getSignDetailData`) return pre-aggregated objects
so the UI can render a screen from one call. `app.on/off` forwards to the
right sub-module based on a static event→owner map; unknown event names
warn rather than silently swallowing typos. **Tested:** 16 integration
tests wiring real session/progression/review/audio with a mock engine +
coach: practiceSign end-to-end, abort-does-not-record-XP, dedupe-prevents-
double-XP, event forwarding across sub-modules, data facades' shape.

### `coach-proxy/` — Optional Node server for the AI coach
Vanilla Node 18+ (built-in `http` + `fetch`, zero npm deps). `POST /coach`
with `{prompt, lang?}` → `{text}` from Gemini. CORS preflight on
`OPTIONS /coach`, origin allowlist via `ALLOWED_ORIGINS` env var. 30 req /
min per-IP in-memory rate limit (20 lines of code, no Redis). Upstream
errors never forwarded verbatim — always a generic 502. Logs only ts/IP/
URL/status/latency; **prompt content is never logged**. Server factory
`createServer()` accepts an injected `callGemini` fn so tests don't hit
the real API. **Tested:** 11 smoke tests for each status code path
including the 502-doesn't-leak-upstream-body assertion. Optional live
Gemini test runs when `GEMINI_API_KEY=... LIVE_TEST=1`.

### `test.html` — Integration swap
Replaced the direct `new SignPathEngine()` + `new SignPathCoach()` wiring
with `new SignPathApp()`. Selecting a sign in the dropdown now calls
`app.practiceSign(key, 4000)` — a full 4-second attempt that exercises
session → progression → review → audio. The log panel subscribes to every
forwarded event so all XP/level-up/mastery/streak/lesson events show up
as they fire. UI layout unchanged.

---

## Decisions

- **Peak score as the final score** (vs average or last). Documented at
  `signpath-session.js` header. Signs are brief (<1s); averaging penalises
  transitions and last-score penalises users whose hands drift.
- **Dual-filter the engine's "waiting" branch** (`prediction === null` AND
  `tier ∈ {Đang chờ, Waiting}`). Either alone would work today, but both
  survives engine refactors where one stops implying the other. Requested
  by the user.
- **Progression owns streak + lesson completion entirely**; engine's
  `_streak` and `_lessonsCompleted` stay orphaned. Engine's
  `completeLesson()` is deliberately NOT called — its side effect of
  stamping `stars = 1` on every sign in the lesson would corrupt our
  per-sign mastery view. Per user direction.
- **Per-sign counter named `attempts`, not `reps`.** Engine's `reps`
  increments only on star upgrades, so `reps >= 5` would rarely trigger.
  Progression tracks its own counter and the distinct name prevents
  future-us from conflating the two. Per user direction.
- **Level formula start state**: 0 XP = L1. `getLevel(xp)` returns 1 plus
  the number of thresholds crossed. So 100 → L2, 300 → L3, 600 → L4, 1000
  → L5. Confirmed by user.
- **SM-2 growth is multiplicative** (`interval *= ease`), not additive.
  The spec's phrasing ("increase interval by `interval * ease`") is
  ambiguous; I chose the standard SM-2 shape because (a) that's what
  real SRS apps do and (b) the resulting curve (1→3→8→20→50 days) matches
  user expectations for a review schedule. The additive reading would
  grow 1→4→14→49 days, more aggressive than needed. Flipping
  `SM2_MULT_MODE = false` in `signpath-review.js` switches behaviour.
- **attemptId format** is `att_{Date.now()}_{monotonic-counter}` — wall
  clock so the ID is meaningful across page reloads, counter disambiguates
  same-ms starts. 50-item ring buffer chosen because realistic session
  length is <50 attempts; evicted IDs only recur if something's very
  wrong, and in that case a false no-op is better than a false accept.
- **Lesson completion criterion** (undefined in spec): every sign in the
  lesson at mastery 3. Stricter than the unlock threshold (80% at mastery
  2+). The event fires exactly once when the condition is first met.
- **Session's Promise resolves on both end and abort** (never rejects for
  lifecycle reasons). Abort resolves with `{aborted: true, reason, ...}`
  so callers can branch without try/catch. This makes `await
  app.practiceSign(key)` natural for UI code.
- **`app.on` warns on unknown events** rather than silently succeeding.
  Typos like `app.on('atempt:end', ...)` would be invisible bugs otherwise.
- **Tone bundle for `practiceSign`**: stars 0/1/2/3 → fail/good/good/success,
  with 3 stars triggering an additional `star` chime. Keeps the 0★ and 1★
  distinguishable to the ear (neither is "success") but doesn't over-
  reward 1★ with the full celebratory sound.
- **Tests use `require()` + IIFE-attaches-to-module.exports trick.** Works
  because the engine's IIFE pattern `(typeof window !== 'undefined' ?
  window : this)` resolves `this` to `module.exports` in Node. No `vm`
  tricks needed for per-module tests. The API facade's integration test
  passes all sub-modules via opts so no cross-module globals are needed.

---

## Known gaps

- **No automated browser audio verification.** `signpath-audio.js` is
  impossible to unit-test meaningfully in Node (no Web Audio, no Speech).
  The Node tests verify no-op safety + settings persistence only. Real
  audio output is verified manually via `signpath-audio.harness.html`.
- **Engine `getStats().streak` is deprecated** but not removed (ground
  rule: don't touch engine). UI should use `progression.getStreak().current`
  instead. Noted here and in `signpath-progression.js` module header.
- **`ALLOWED_ORIGINS` CORS check is a string-exact match.** No wildcards
  (`*.example.com`), no regex. Good enough for a small deploy; if you need
  multi-tenant, put it behind Cloudflare / a real gateway.
- **Rate limiter is in-process memory.** Restarts reset counters. Acceptable
  for this scale; called out in `coach-proxy/README.md`.
- **No `.env` loader in the coach-proxy.** `.env.example` is documentation
  only. Users must `export` vars or use a process manager / env_file.
  Keeping the proxy dependency-free was prioritised over convenience here.
- **Progression does not persist to any non-localStorage backend.** Cross-
  device sync would need a real backend; out of scope for v1.

---

## UI Integration Guide — for the Stitch designer

**Load order in HTML** (sub-modules before the facade):

```html
<script src="https://cdn.jsdelivr.net/npm/@mediapipe/holistic/holistic.js"></script>
<script src="signpath-engine.js"></script>
<script src="signpath-coach.js"></script>
<script src="signpath-session.js"></script>
<script src="signpath-progression.js"></script>
<script src="signpath-review.js"></script>
<script src="signpath-audio.js"></script>
<script src="signpath-api.js"></script>
```

**Bootstrap**:

```js
const app = new SignPathApp()
await app.init(document.getElementById('myVideoElement'))
// app is now usable.
```

### Methods you will call most

| Method                                 | Purpose                                               |
|----------------------------------------|-------------------------------------------------------|
| `app.init(video)`                      | One-time. Starts camera + MediaPipe. Emits `ready`.   |
| `app.practiceSign(signKey, ms=3500)`   | Run an attempt. Returns `{finalScore, stars, progression, review, toneTier, advice, deviations, ...}`. |
| `app.getHomeScreenData()`              | Snapshot for home screen. `{user, streak, dailyGoal, unlockedLessons, nextSigns[], completedLessons, totalSigns}` |
| `app.getLessonScreenData(lessonId)`    | Snapshot for a lesson page. `{id, goal, icon, color, unlocked, completed, signs[]}` or `null`. |
| `app.getSignDetailData(signKey)`       | Snapshot for a sign detail page. `{key, vi, en, stars, best, mastery, attempts, srs, ...}` or `null`. |
| `app.destroy()`                        | Release camera / audio context on page unmount.       |

### Events to subscribe to via `app.on(name, fn)`

**From the engine (live tracking):**

| Event       | Fires                                            | Payload keys                                                                                  |
|-------------|--------------------------------------------------|-----------------------------------------------------------------------------------------------|
| `ready`     | after `init()` succeeds                          | `{templates, lessons, signs}`                                                                 |
| `error`     | init or tracking failure                         | `{message, type}` — `type ∈ templates\|camera\|mediapipe\|tracking`                           |
| `tracking`  | every MediaPipe frame                            | `{detected, rightHand, leftHand, pose, face, dominantHand}` — subscribe if you're drawing landmarks |
| `score`     | ~every 200 ms while an attempt is active         | `{score, prediction, top3, top5, fingerScores, deviations, feedback, tier, tierEmoji, isMatch, bufferFrames}` |

**From the session (attempt lifecycle):**

| Event                   | Fires                                 | Payload keys                                                                     |
|-------------------------|---------------------------------------|----------------------------------------------------------------------------------|
| `attempt:start`         | user pressed Record                   | `{attemptId, signKey, durationMs, startTime}`                                    |
| `attempt:tick`          | every 250 ms during an attempt        | `{attemptId, elapsedMs, livePreviewScore, bufferFrames}` — for a progress bar    |
| `attempt:end`           | attempt finished (duration or manual) | `{attemptId, signKey, finalScore, peakScore, avgScore, stars, deviations, advice, durations, reason}` |
| `attempt:abort`         | user cancelled or no signing detected | `{attemptId, signKey, reason}` — `reason ∈ user_cancelled\|no_signing_detected`  |
| `attempt:coach-update`  | async AI advice arrived post-end      | `{attemptId, signKey, advice}` — replaces the local advice shown on end          |

**From progression (gamification state changes):**

| Event              | Fires                                      | Payload keys                                                   |
|--------------------|--------------------------------------------|----------------------------------------------------------------|
| `xp:gained`        | any scoring attempt completes              | `{amount, source, totalXp}`                                    |
| `streak:updated`   | streak state changed                       | `{currentStreak, longestStreak, didExtendToday}`               |
| `level:up`         | user crossed a level threshold             | `{newLevel, prevLevel, xp}`                                    |
| `mastery:gained`   | a sign's mastery level increased           | `{signKey, masteryLevel}` (0 new → 3 mastered)                 |
| `lesson:unlocked`  | a lesson newly became available            | `{lessonId}`                                                   |
| `lesson:completed` | every sign in a lesson hit mastery 3       | `{lessonId}`                                                   |

### Sub-modules (if you need fine-grained control)

`app.engine`, `app.coach`, `app.session`, `app.progression`, `app.review`,
`app.audio` are all exposed. Most screens won't need these — the facade
methods should be enough. See each module's header comment for the full
API.

### Typical flows

**Home screen load:**

```js
const data = app.getHomeScreenData()
renderUser(data.user)       // {xp, level, nextLevelThreshold, xpIntoLevel, xpForLevel, masteredCount}
renderStreak(data.streak)   // {current, longest, didSignToday}
renderDaily(data.dailyGoal) // {target, progress, met, date}
renderQueue(data.nextSigns) // array of {signKey, reason, priority}
```

**Record-a-sign button:**

```js
recordBtn.onclick = async () => {
  // Optional: play the spoken target word first
  await app.audio.speak(currentSignKey, 'vi')
  // Run the attempt
  const r = await app.practiceSign(currentSignKey, 3500)
  if (r.aborted) {
    showToast(r.reason === 'no_signing_detected' ? 'Show your hand to the camera' : 'Cancelled')
    return
  }
  showResultCard({ score: r.finalScore, stars: r.stars, advice: r.advice })
  // Level-up / mastery / unlock toasts are driven by the event subscriptions above.
}
```

**Live progress bar during an attempt:**

```js
app.on('attempt:tick', t => progressBar.value = t.elapsedMs / t.durationMs * 100)
app.on('attempt:end', () => progressBar.value = 0)
```

### Coach proxy wiring (production)

Before `app.init(...)`, if the proxy is deployed:

```js
app.coach.setProvider(SignPathCoach.createProxyProvider('/coach'))
// or external host: createProxyProvider('https://coach.yourdomain.com/coach')
```

Without this call, AI coaching is silently disabled and only the local
rule-based advice appears in `attempt:end.advice` / `attempt:coach-update`.

### What the UI should never do

- Import `signpath-engine.js` / `signpath-coach.js` directly — always go
  through `SignPathApp`. The facade wires up dependency order correctly;
  manual wiring is easy to get wrong.
- Call `engine.getStats().streak` — deprecated. Use
  `app.progression.getStreak().current` (or `getHomeScreenData().streak`).
- Assume `score` events contain `deviations` — the engine's no-hand branch
  omits them. The session already filters these; they won't surface via
  `attempt:*` events.
- Treat `score`-event scores as the final score. They're live streaming
  values; `attempt:end.finalScore` is authoritative.
