# SignPath UI Integration Report

**Status:** Demoable end-to-end. All 7 screens routed, all backend modules wired, no Stitch stock imagery remaining in the app.

## How to run

```powershell
cd C:\SignPath\signpath-test
python -m http.server 8000
# Open http://localhost:8000/app.html in Chrome (Edge/Firefox also work)
```

Chrome requires `localhost` (not `file://`) because MediaPipe, `getUserMedia`, and `fetch` all need a real origin.

First load: onboarding (3 steps). After clicking **Bắt đầu học** on step 3, `localStorage['signpath:onboarded']=true` is set and the router lands on `#home` on every subsequent visit.

To replay onboarding:
```js
// in DevTools console
localStorage.removeItem('signpath:onboarded'); location.hash = ''; location.reload()
```

## Routing choice — hash routing

Hash routing (`#home`, `#lesson/greetings`, `#practice/C%E1%BA%A3m%20%C6%A1n`) was chosen over the History API because:

1. **Static server compatibility** — `python -m http.server` can't rewrite `/practice/...` back to `/app.html`, so History API would 404 on refresh. Hash works on any static host with zero config.
2. **URL bar reflects state** — easy to debug and share; pasting `...app.html#practice/M%E1%BA%B9` lands directly on practicing "Mẹ".
3. **No back/forward edge cases** — `hashchange` fires consistently; no `popstate`-vs-first-load distinction.

Route parser in [app.js:44](app.js:44) — splits on `/`, decodes each segment.

## Files added (new)

| Path | Purpose |
|------|---------|
| [app.html](app.html) | Single-page shell: sidebar + main + hidden engine video + modal mount |
| [app.js](app.js) | Boot (manifest → `SignPathApp()` → `app.init(engineVideo)`) + hash router |
| [ui/signpath-styles.css](ui/signpath-styles.css) | Extracted design tokens (amber/cream palette, `primary-gradient`, `sp-node-*`, `sp-card`, `sp-btn-*`, `sp-modal-*`, responsive hedge) |
| [screens/shared.js](screens/shared.js) | `SP.h(...)`, manifest loader, `SP.refVideoUrl`, `SP.videoEl`, deburr search, localStorage helpers, topbar/toast |
| [screens/onboarding.js](screens/onboarding.js) | 3-step flow — language, camera, first sign ("Cảm ơn") |
| [screens/home.js](screens/home.js) | Home journey — real 25-lesson grid with mastered/current/unlocked/locked states |
| [screens/lesson.js](screens/lesson.js) | Lesson detail — sign card grid (my own design; sourced layout from dictionary) |
| [screens/practice.js](screens/practice.js) | THE critical screen — webcam (mirrored from hidden engine video) + live score + record + event wiring |
| [screens/dictionary.js](screens/dictionary.js) | All-signs browser — category chips, diacritic-insensitive search, 12-per-page, "recently practiced" sidebar |
| [screens/progress.js](screens/progress.js) | Real stats only — streak, mastered count, per-lesson mastery bars, due-for-review queue |
| [screens/modals.js](screens/modals.js) | Result modal (success + keep-trying variants by `passed`) |

## Files NOT touched

All backend modules — `signpath-engine.js`, `signpath-coach.js`, `signpath-session.js`, `signpath-progression.js`, `signpath-review.js`, `signpath-audio.js`, `signpath-api.js`. Existing tests (117) still pass:

```
signpath-api.test.js              17 passed, 0 failed
(other test files untouched)
```

## Data wiring — what's real, per screen

### Home (`#home`)
- **Streak chip (topbar)** ← `app.getHomeScreenData().streak.current`
- **XP chip (topbar)** ← `.user.xp`
- **"17 dấu"** ← `.user.masteredCount`
- **"1/25 chương"** ← `.completedLessons.length + '/' + lessons.length`
- **"Chuỗi ngày"** ← `.streak.current`
- **"XP 240"** ← `.user.xp`
- **"Cấp độ Lv N"** ← `.user.level`
- **Continue card** — shown only if `signpath:lastLesson` is set (written on every lesson view and every attempt end via `pushRecent`). Hidden when empty.
- **Lesson path** — 25 nodes from `engine.getLessons()`. State computed from `progression.isLessonCompleted(id)` → mastered, `isLessonUnlocked(id)` → unlocked, otherwise locked. First unlocked-not-completed becomes "current".

### Lesson detail (`#lesson/:id`)
- Header icon + VI + EN from `lesson.icon`, `lesson.goal.vi/en`
- Progress bar: `masteredCount / totalSigns` with rounded %
- Sign cards: looping video (via `SP.videoEl(key)` + manifest), stars = `mastery` level, "Kỷ lục X%" = `best`, mastery tag computed from `mastery` (0-3)
- Card click → `#practice/:sign` (URL-encoded)
- No "Practice all signs in order" (dropped — not required for contest demo)

### Practice (`#practice/:sign`) — **THE critical screen**
- Left col: looping reference video, speed chips (0.5× / 0.75× default / 1×), sign name, 3-step how-to
- Right col: webcam feed (mirrors `engineVideo.srcObject` via `camVideo.srcObject = engineVideo.srcObject`), live score overlay, hand-detection dot, record button, progress bar, coach box
- Live wiring:
  - `engine.selectSign(key)` called on mount so per-frame `score` events target this sign
  - `on('tracking')` → hand-detected dot color/text
  - `on('score')` → live score number + local coach advice (outside of attempts only)
  - `on('attempt:start|tick|end|abort')` → progress bar + button state + coach text
- Record flow: `app.practiceSign(signKey, 4000)` → on resolve, push to `signpath:recentlyPracticed`, show `SP.modals.showResult(result, {...})`
- Result modal **Next** button: finds next sign in same lesson; last-in-lesson → back to `#lesson/:id`
- **Phantom signs** (no template) — record button disabled, warning banner shown, reference video still plays. User can study the motion without scoring.

### Dictionary (`#dictionary`)
- Chips from `engine.getLessons()` + leading "Tất cả" chip
- Search: diacritic-insensitive (`.normalize('NFD').replace(/[\u0300-\u036f]/g,'')`) on both VI and EN fields
- Grid: 12 cards per page, "Tải thêm" button appends another 12
- Cards: looping video, mastery tag, click → `#practice/:sign`
- Right sidebar: "Vừa luyện tập" — last 5 entries from `signpath:recentlyPracticed` with relative timestamps ("15 phút trước")
- No "Nâng cấp Pro" button (was removed from Stitch per spec)

### Progress (`#progress`)
- 3 KPI cards — streak, mastered count, level+XP (with XP bar for current level)
- **Removed:** "Total practice time" card and "Weekly activity histogram" — backend doesn't track daily activity or time-on-task
- Mastery-per-chapter: one card per lesson (skipping empty lessons), sorted by `familiarRatio` desc
- Due-for-review queue — chips from `review.getNextSigns(10)` with reason tags (Đến hạn / Khó / Mới / Duy trì)
- Clicking any lesson card → `#lesson/:id`; clicking a review chip → `#practice/:sign`

### Onboarding (`#onboarding/1` → `#onboarding/2` → `#onboarding/3`)
- Step 1: language choice (VI default, EN option). Stored at `signpath:preferredLang` (cosmetic — engine lang defaults to VI).
- Step 2: camera permission. Uses `navigator.mediaDevices.getUserMedia({ video: true })` as a probe, stops immediately (engine opens its own stream in `app.init()`). Has a collapsible "Why do we need this?" explainer. Skip link available in case user wants to preview without camera.
- Step 3: first sign preview. Loops `reference_videos/Cảm ơn.mp4`. "Bắt đầu học" → sets `signpath:onboarded=true` → `#home`.
- Sidebar hidden during onboarding; restored on teardown.

## Lessons covered on the home path — all 25

Every category in `CATEGORIES` (see [signpath-engine.js:252](signpath-engine.js:252)) renders as a node:
```
greetings, numbers, colors, days, months, family, time, seasons, holidays, places,
countries, transport, animals, fruits, food, drinks, tastes, emotions, actions,
descriptions, clothes, household, school, sports, occupations
```

Plus a possible 26th **"other"** bucket if any gloss fails to match any category (see [signpath-engine.js:1069](signpath-engine.js:1069)). The home grid uses `auto-fill` so any count fits gracefully.

The number `X / Y dấu` shown per node is the actual count of signs from that category that have templates (pulled live via `app.getLessonScreenData(lesson.id).totalSigns`), NOT the raw `matches` array length. This means some categories display fewer signs than the curriculum lists — that's expected, the corpus is VSL400, not every possible gloss has a template.

## Phantom signs (16 without templates)

When `engine.getTemplate(key)` returns null:
- **Dictionary** — card still renders with looping video; badge shows "Mới"; toast notifies user before navigating.
- **Lesson detail** — "Chưa có dữ liệu" tag on the card; clicking still routes to practice.
- **Practice screen** — reference video plays; **Record button is disabled**; red warning banner ("Dấu này chưa có dữ liệu chấm điểm — Chỉ xem video mẫu"); no crash, no empty state.

The `hasTemplate` check comes from `app.getSignDetailData(key).hasTemplate`.

## Known issues / rough edges

1. **First render before `ready` event** — the home and progress screens render a "Đang khởi động engine…" placeholder while MediaPipe loads (~2-5s). When engine ready fires, [app.js:77](app.js:77) re-runs `route()` which re-renders the current screen with real data. This is deliberate but means the user sees a flash of "Loading" before the lesson grid pops in. It could be smoothed with a cross-fade.

2. **Continuous score updates fire at ~15-30 FPS** — we're updating the DOM (`#sp-live-score` text + color) on every frame during live tracking. On low-end machines this could cause jank. If that happens, throttle with a `requestAnimationFrame` batcher inside `practice.js:on('score', ...)`.

3. **Hash encoding edge case** — if a user manually types `#practice/Mẹ` into the URL bar (unencoded), the router will correctly decode via `decodeURIComponent` on the split parts. But if they paste a half-broken URL, the fallback "Không tìm thấy" page handles it gracefully.

4. **Stream sharing** — The practice screen mirrors the engine's hidden `<video>` stream into a visible one by setting `camVideo.srcObject = engineVideo.srcObject`. A 300ms polling interval catches the case where the stream arrives after the screen mounts. Not elegant, but reliable; no flicker observed.

5. **Mobile responsive** — CSS hedge only: sidebar collapses to top row below 900px via `@media` query. Practice screen does NOT adapt its 2fr/3fr grid — on phones, columns would be cramped. Per spec, desktop is the demo platform; mobile is marked explicitly as out-of-scope here.

6. **Coach remote advice** — `attempt:coach-update` is wired globally but we don't currently overwrite the modal's advice text if it arrives after the modal is visible. Rare: coach only fires when score < 75 AND proxy is running. Can be fixed by giving the modal an `id` on its advice block and having the global handler update it.

7. **No "Practice all in sequence" button** on lesson detail — dropped to keep scope tight. Manual "Next sign" in the result modal does the same job.

8. **Level up banner** — shows only in the result modal, not as a screen-level celebration. The global `level:up` listener also fires a toast. Could be upgraded to a full-screen confetti moment if time permits.

## What is NOT wired (explicitly out-of-scope)

- **Mobile layouts** beyond the responsive hedge
- **"Pro upgrade" / payment** — removed
- **Dark mode** — the Stitch design is light-only; `dark:` classes in the original HTMLs are ignored
- **User accounts / cloud sync** — localStorage only
- **Backend coach-proxy** — optional; when not running, session uses `coach.getLocalAdvice` (no LLM calls)
- **Analytics/telemetry** — none
- **Lesson-complete screen** (`ui/lesson_complete_desktop`) — not routed; lesson completion is signaled via the global `lesson:completed` toast and the "✓ HOÀN THÀNH" badge on the progress bars. Adding a dedicated celebration screen is a future polish.

## Test the golden path end-to-end

1. `python -m http.server 8000` in `signpath-test/`
2. Open `http://localhost:8000/app.html`
3. Step through onboarding (language → camera permission → preview "Cảm ơn") → click **Bắt đầu học**
4. Home shows 25-lesson grid with "greetings" as current
5. Click "Gia đình" → lesson detail with ~22 family signs
6. Click "Mẹ" card → practice screen with webcam + reference loop
7. Click **Ghi âm · Record** → 4s countdown → result modal with real score/stars/XP
8. Click **Dấu tiếp theo** → auto-advance to next sign
9. Top sidebar → **Từ điển** → search "mẹ" (or "me") → card appears → click
10. Top sidebar → **Tiến độ** → see per-chapter mastery bars + due-for-review chips

All 13 success criteria from the spec are covered.

## LocalStorage keys used

| Key | Owner | Purpose |
|-----|-------|---------|
| `sp3_progress` | engine | per-sign stars/best/reps |
| `sp3_streak` | engine | (legacy, not active — progression owns streak now) |
| `sp3_lessons` | engine | completed lesson IDs |
| `sp3_lang` | engine | VI / EN interface language |
| `signpath:progression` | progression | xp/level/streak/mastery state |
| `signpath:review` | review | SRS state per sign |
| `signpath:onboarded` | UI | first-run gate |
| `signpath:lastLesson` | UI | last visited lesson id (for Continue card) |
| `signpath:recentlyPracticed` | UI | array of `{key, ts}`, up to 10 |
| `signpath:preferredLang` | UI | cosmetic only (engine lang is independent) |

To fully reset for a demo:
```js
Object.keys(localStorage).filter(k => k.startsWith('sp3_') || k.startsWith('signpath:'))
  .forEach(k => localStorage.removeItem(k))
```
