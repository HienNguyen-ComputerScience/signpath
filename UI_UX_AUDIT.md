# SignPath — UI/UX Audit (v0.5)

**Phase 1 deliverable.** Read-only audit of the 7 demo-path screens. No code
was changed. Findings are grouped by screen, sorted by severity. A "Fix
batch candidates" section at the end groups findings into 4 recommended
batches for Phuong to triage.

Scope: `signpath-test/screens/{home,lesson,practice,progress,dictionary,modals}.js`,
`signpath-test/screens/shared.js`, `signpath-test/ui/signpath-styles.css`,
`signpath-test/app.html`, `signpath-test/app.js`. Onboarding screens are
intentionally out of scope per the task brief.

---

## Summary table

| Screen | Critical | High | Medium | Low | Total |
|---|---:|---:|---:|---:|---:|
| Home | 0 | 1 | 2 | 6 | 9 |
| Lesson | 0 | 1 | 1 | 4 | 6 |
| Practice | 0 | 2 | 5 | 5 | 12 |
| Progress | 0 | 1 | 2 | 4 | 7 |
| Dictionary | 0 | 1 | 1 | 5 | 7 |
| Result modal | 0 | 0 | 4 | 4 | 8 |
| Rank-up modal | 0 | 1 | 2 | 3 | 6 |
| **All** | **0** | **7** | **17** | **31** | **55** |

By category:

| Category | Count |
|---|---:|
| demo-risk | 4 |
| polish | 26 |
| a11y | 14 |
| localization | 11 |

ID convention: `H#` home, `L#` lesson, `P#` practice, `PR#` progress,
`D#` dictionary, `R#` result modal, `RU#` rank-up modal. Numbered in
severity order within each screen.

---

## Home (`screens/home.js`)

### H1 — Lesson nodes are non-keyboardable
- Category: a11y
- Severity: high
- File: [screens/home.js:177](signpath-test/screens/home.js#L177)
- What's wrong: `.sp-node` is a plain `<div>` with `onclick` — no `role`, no `tabindex`, no Enter/Space handler, so keyboard-only users cannot select a chapter from the path.
- Fix: Render the node as a `<button>` (or add `role="button"` + `tabindex="0"` + Enter/Space handlers) and surface chapter title via accessible name.
- Effort: small

### H2 — Loading topbar shows fake "0" stats
- Category: polish
- Severity: medium
- File: [screens/home.js:23-28](signpath-test/screens/home.js#L23)
- What's wrong: Before the engine emits `ready`, the topbar is rendered with `streak:0, xp:0, level:null` — a returning user sees a brief "you have 0 streak" flash.
- Fix: Render the topbar chips in a skeleton/placeholder state (`—`) until `SP.isEngineReady()` is true, or hide them entirely.
- Effort: small

### H3 — Continue card sometimes points at the wrong sign
- Category: polish
- Severity: medium
- File: [screens/home.js:79-87](signpath-test/screens/home.js#L79)
- What's wrong: When `getRecent()` has nothing in the saved lesson, the card silently falls back to `lastLessonData.signs[0]` and labels it "Dấu đang học" — that's a lie if the user actually finished sign 1 and was on sign 5.
- Fix: Use `engine.getSignProgress` to find the last-attempted sign in the lesson, or relabel the fallback as "Bắt đầu chương" instead of "Dấu đang học".
- Effort: small

### H4 — Hero subtitle is Vietnamese-only
- Category: localization
- Severity: low
- File: [screens/home.js:33-34](signpath-test/screens/home.js#L33)
- What's wrong: "Học ngôn ngữ ký hiệu Việt Nam với phản hồi AI thời gian thực" has no English equivalent, but the chapter strip below (`'25 chương học · 25 chapters'`) is bilingual — the bilingual pattern is inconsistent.
- Fix: Append the English copy with the `·` separator, e.g. "… · Learn Vietnamese sign language with real-time AI feedback".
- Effort: trivial

### H5 — Hardcoded chapter count in heading
- Category: polish
- Severity: low
- File: [screens/home.js:120](signpath-test/screens/home.js#L120)
- What's wrong: "25 chương học · 25 chapters" hardcodes `25`; if the engine ever returns a different number of lessons, the label lies.
- Fix: Use `lessons.length` for both occurrences.
- Effort: trivial

### H6 — Streak stat shows bare "0" with no unit
- Category: polish
- Severity: low
- File: [screens/home.js:52](signpath-test/screens/home.js#L52)
- What's wrong: `stat('Chuỗi ngày', String(data.streak.current))` shows just "0" while the other stats include a unit ("10 dấu", "Lv 2"); ambiguous to first-time viewers.
- Fix: Append `' ngày'` to the value (e.g. "0 ngày").
- Effort: trivial

### H7 — Locked-node toast uses inconsistent separator
- Category: localization
- Severity: low
- File: [screens/home.js:183](signpath-test/screens/home.js#L183)
- What's wrong: Toast uses `' / '` between VI and EN ("Hoàn thành chương trước để mở khóa / Complete the previous chapter to unlock") while the rest of the app uses `' · '`.
- Fix: Replace `' / '` with `' · '` for consistency.
- Effort: trivial

### H8 — Lesson node has no chapter index
- Category: polish
- Severity: low
- File: [screens/home.js:172-193](signpath-test/screens/home.js#L172)
- What's wrong: Locked nodes are visually identical (same lock icon, same emoji); a viewer can't tell chapter 5 from chapter 7 without hover.
- Fix: Add a small `1`…`25` index badge (e.g. above the emoji bubble) on every node.
- Effort: small

### H9 — "HIỆN TẠI" badge can be clipped at top of grid row
- Category: polish
- Severity: low
- File: [screens/home.js:175](signpath-test/screens/home.js#L175) + [ui/signpath-styles.css:227-233](signpath-test/ui/signpath-styles.css#L227)
- What's wrong: `.sp-node-badge` uses `top:-1.5rem` which can sit above the grid cell's row gap and visually crowd the row above.
- Fix: Increase grid `row-gap` to ≥ 3rem on the path grid, or move the badge inside the node-circle container.
- Effort: trivial

---

## Lesson (`screens/lesson.js`)

### L1 — Sign cards are non-keyboardable
- Category: a11y
- Severity: high
- File: [screens/lesson.js:117-124](signpath-test/screens/lesson.js#L117)
- What's wrong: Each `.sp-card` is a `<div>` with `onclick` only — no role, no tabindex, no Enter/Space — same issue as H1.
- Fix: Render the card root as a `<button>` styled as a card, or add `role="button" tabindex="0"` plus key handlers.
- Effort: small

### L2 — "Chưa có dữ liệu" tag contrast is borderline
- Category: a11y
- Severity: medium
- File: [screens/lesson.js:115](signpath-test/screens/lesson.js#L115)
- What's wrong: `var(--sp-on-surface-variant)` (#635f56) on `var(--sp-surface-container-high)` (#eee7dd) reads ≈ 4.4:1 — meets AA for normal text but fails the 4.5:1 threshold once you account for the 11px-equivalent (`.6875rem` bold) badge size.
- Fix: Darken the tag text to `var(--sp-on-surface)` (#35322a) for the "no data" variant, or thicken the badge to ≥ 12px.
- Effort: trivial

### L3 — Missing-template toast is VI-only
- Category: localization
- Severity: low
- File: [screens/lesson.js:120](signpath-test/screens/lesson.js#L120)
- What's wrong: "Dấu này chưa có dữ liệu chấm điểm. Bạn vẫn có thể xem video mẫu." has no `· EN` companion, breaking the bilingual pattern used elsewhere.
- Fix: Append `' · No scoring data yet — you can still watch the reference.'`.
- Effort: trivial

### L4 — "Kỷ lục X%" line is VI-only
- Category: localization
- Severity: low
- File: [screens/lesson.js:132-133](signpath-test/screens/lesson.js#L132)
- What's wrong: The best-score chip on each card shows "Kỷ lục 78%" with no English ("Best 78%").
- Fix: Either drop "Kỷ lục" in favour of just the number + a star icon, or render `'Kỷ lục · Best ' + n + '%'`.
- Effort: trivial

### L5 — Header back link has only an arrow icon for screen readers
- Category: a11y
- Severity: low
- File: [screens/lesson.js:41-48](signpath-test/screens/lesson.js#L41)
- What's wrong: The icon `<span class="material-symbols-outlined">arrow_back</span>` is a glyph; screen readers read "arrow_back" literally before the text "Về trang chủ".
- Fix: Add `aria-hidden="true"` to the icon span.
- Effort: trivial

### L6 — Empty-chapter copy is VI-only
- Category: localization
- Severity: low
- File: [screens/lesson.js:84](signpath-test/screens/lesson.js#L84)
- What's wrong: The "no signs yet" empty state already mixes VI and EN with `' / '` instead of `' · '`.
- Fix: Replace `' / '` with `' · '` for consistency with the rest of the app.
- Effort: trivial

---

## Practice (`screens/practice.js`)

### P1 — "Ghi âm" mistranslates the record action
- Category: localization
- Severity: high
- File: [screens/practice.js:246](signpath-test/screens/practice.js#L246), also [:366](signpath-test/screens/practice.js#L366), [:376](signpath-test/screens/practice.js#L376), [:416](signpath-test/screens/practice.js#L416)
- What's wrong: "Ghi âm" specifically means *audio* recording in Vietnamese; for a video/sign-capture flow it's the wrong word and reads as a translation bug to any VN-native demo viewer.
- Fix: Replace all four occurrences with "Quay" / "Quay video" / "Bắt đầu", e.g. button label `'Quay · Record'` and abort copy `'Đã hủy. Nhấn Quay để thử lại.'`.
- Effort: trivial

### P2 — Landmark canvas overflows over right-column controls on mobile
- Category: polish
- Severity: high
- File: [screens/practice.js:265-297](signpath-test/screens/practice.js#L265) (responsive logic), canvas absolute at [:118-127](signpath-test/screens/practice.js#L118)
- What's wrong: In narrow mode `practiceWrap` becomes a flex column with `height:auto`, but `landmarkCanvas` stays `position:absolute; inset:0` — the skeleton overlay therefore extends down across the stacked Reference / Coach / Record panels.
- Fix: Wrap `camVideo` + `landmarkCanvas` in a dedicated `position:relative` container so the canvas only covers the camera, regardless of layout mode.
- Effort: small

### P3 — Disabled record button gives no reason
- Category: polish
- Severity: medium
- File: [screens/practice.js:239-246](signpath-test/screens/practice.js#L239)
- What's wrong: When `hasTemplate === false` the button is greyed out but still labelled "Ghi âm · Record"; the user doesn't know *why* they can't record.
- Fix: When disabled, swap label to "Chưa có dữ liệu chấm · No scoring data" and add a `title`/tooltip explaining the user can still watch the reference.
- Effort: trivial

### P4 — No way to cancel an in-flight 4 s attempt
- Category: polish
- Severity: medium
- File: [screens/practice.js:362-380](signpath-test/screens/practice.js#L362)
- What's wrong: Once `attempt:start` fires the button shows "Đang ghi…" but offers no abort; the user must wait 4 s even if they fluffed the start.
- Fix: Replace the button label with "Hủy · Cancel" during recording and call `app.session.abort()`.
- Effort: small

### P5 — Right column can collide with title overlay at ~768-900 px
- Category: polish
- Severity: medium
- File: [screens/practice.js:142-159, 182-187](signpath-test/screens/practice.js#L142)
- What's wrong: `backOverlay` uses `maxWidth:'20rem'` (left), `rightCol` is `25%` with `minWidth:'15rem'` (right); on a ~768-900 px viewport (still in desktop mode per the 768 break) the two regions can overlap.
- Fix: Bump the responsive breakpoint to ≤ 1024 px, or cap `backOverlay` width at `max(12rem, calc(70% - 18rem))`.
- Effort: small

### P6 — Camera height assumes a fixed top-bar height
- Category: polish
- Severity: medium
- File: [screens/practice.js:98](signpath-test/screens/practice.js#L98)
- What's wrong: `height:'calc(100vh - 7rem)'` hardcodes the topbar+padding budget; if the topbar wraps (long XP / streak chips) the camera overflows the viewport.
- Fix: Wrap `practiceWrap` in a flex column under the topbar and use `flex:1` instead of `calc(100vh - 7rem)`.
- Effort: small

### P7 — Coach-advice card has no max-height, can grow unbounded
- Category: polish
- Severity: medium
- File: [screens/practice.js:214-233](signpath-test/screens/practice.js#L214)
- What's wrong: A long AI advice string pushes the record panel below the viewport on a narrow desktop window — there's no overflow handling.
- Fix: Add `max-height: 9rem; overflow-y: auto` to the advice card body.
- Effort: trivial

### P8 — Degraded-tracking dismiss button label is English-only
- Category: localization
- Severity: low
- File: [screens/practice.js:78](signpath-test/screens/practice.js#L78)
- What's wrong: `aria-label='Dismiss'` is English even though the visible banner text is bilingual.
- Fix: Change `aria-label` to `'Đóng · Dismiss'`.
- Effort: trivial

### P9 — Reference-video panel has no replay/pause control
- Category: polish
- Severity: low
- File: [screens/practice.js:188-211](signpath-test/screens/practice.js#L188)
- What's wrong: Only speed selectors are exposed; the user can't pause to study a frame or restart the loop on demand.
- Fix: Add a `play_pause` toggle button next to the speed chips.
- Effort: small

### P10 — "Live score" overlay flashes from `—` to a colour-coded number with no transition
- Category: polish
- Severity: low
- File: [screens/practice.js:170-179, 350-360](signpath-test/screens/practice.js#L170)
- What's wrong: Score updates jump in colour and value frame-to-frame, which can read as twitchy during demo.
- Fix: Throttle/lerp updates (every 200 ms) and add a `transition: color .15s, transform .15s` on `#sp-live-score`.
- Effort: small

### P11 — "Chưa thấy tay" pill colour is permanently red until detection
- Category: polish
- Severity: low
- File: [screens/practice.js:162-167, 309-310](signpath-test/screens/practice.js#L162)
- What's wrong: Reading `rgba(167, 59, 33, 0.78)` (red) before any attempt feels like an error state, but it's just the hand-detection idle.
- Fix: Use a neutral grey for the "not detected" state and reserve red for actual error events.
- Effort: trivial

### P12 — Coach-text initial copy is VI-only
- Category: localization
- Severity: low
- File: [screens/practice.js:231-232](signpath-test/screens/practice.js#L231)
- What's wrong: First-load string "Xem video mẫu rồi nhấn Ghi âm để bắt đầu." has no EN companion despite the rest of the panel being bilingual.
- Fix: Append `' · Watch the reference, then press Record to start.'`.
- Effort: trivial

---

## Progress (`screens/progress.js`)

### PR1 — Mastery cards are non-keyboardable
- Category: a11y
- Severity: high
- File: [screens/progress.js:73-77](signpath-test/screens/progress.js#L73)
- What's wrong: Same pattern as H1/L1 — `.sp-card` with `onclick`, no role/tabindex.
- Fix: Replace card root with `<a href="#lesson/{id}">` (semantically a link) styled as a card.
- Effort: small

### PR2 — Two-column layout never collapses on mobile
- Category: polish
- Severity: medium
- File: [screens/progress.js:47-51](signpath-test/screens/progress.js#L47)
- What's wrong: `gridTemplateColumns:'2fr 1fr'` is hardcoded; on a 375 px viewport the right column shrinks to ~125 px and review-queue items become unreadable.
- Fix: Wrap in `@media (max-width: 768px) { grid-template-columns: 1fr }` (move styling to CSS, drive via a class).
- Effort: small
 
### PR3 — Review queue item shows raw `signKey` only
- Category: polish
- Severity: medium
- File: [screens/progress.js:106-119](signpath-test/screens/progress.js#L106)
- What's wrong: Each row renders `<span>{n.signKey}</span>` without an English translation or chapter context — inconsistent with the bilingual treatment in the dictionary/lesson cards.
- Fix: Look up the sign via `app.getSignDetailData(n.signKey)` and render `vi` + small `en` line.
- Effort: small

### PR4 — Reason badges are VI-only
- Category: localization
- Severity: low
- File: [screens/progress.js:142-148](signpath-test/screens/progress.js#L142)
- What's wrong: `reasonLabel` returns "Đến hạn" / "Khó" / "Mới" / "Duy trì" with no EN.
- Fix: Switch to bilingual literals (e.g. `due_for_review:'Đến hạn · Due'`) or supply EN via `title` attribute.
- Effort: trivial

### PR5 — Mastery sort buries the most useful chapters
- Category: polish
- Severity: low
- File: [screens/progress.js:68](signpath-test/screens/progress.js#L68)
- What's wrong: `sort((a,b) => b.familiarRatio - a.familiarRatio)` puts the most-mastered chapters first; a learner scanning for "what to work on" has to scroll all the way down.
- Fix: Sort ascending by familiarRatio (least-familiar first) — also matches the spaced-rep mental model used elsewhere.
- Effort: trivial

### PR6 — Empty review-queue copy is VI-only
- Category: localization
- Severity: low
- File: [screens/progress.js:103-104](signpath-test/screens/progress.js#L103)
- What's wrong: "Chưa có gì cần ôn. Tiếp tục luyện tập!" has no EN.
- Fix: Append `' · Nothing to review yet — keep practising!'`.
- Effort: trivial

### PR7 — KPI card stacks two metrics into one value line
- Category: polish
- Severity: low
- File: [screens/progress.js:40-42](signpath-test/screens/progress.js#L40)
- What's wrong: `'Lv ' + level + ' · ' + xp + ' XP'` packs level and XP into one big bold number; visually cluttered next to the other single-value KPI cards.
- Fix: Show the level as the primary value and surface XP as a secondary subtitle ("123 / 200 XP").
- Effort: small

---

## Dictionary (`screens/dictionary.js`)

### D1 — Cards are non-keyboardable
- Category: a11y
- Severity: high
- File: [screens/dictionary.js:169-175](signpath-test/screens/dictionary.js#L169)
- What's wrong: Same pattern as H1/L1/PR1.
- Fix: Render the card as a `<button>` or wrap in `<a href="#practice/...">`.
- Effort: small

### D2 — Two-column layout doesn't collapse on mobile
- Category: polish
- Severity: medium
- File: [screens/dictionary.js:75-78](signpath-test/screens/dictionary.js#L75)
- What's wrong: `gridTemplateColumns:'1fr 16rem'` keeps the recent-practiced sidebar in view down to phone widths, where it eats > 30 % of the screen for 5 rows of small text.
- Fix: Add a mobile media query that stacks the sidebar above (or below) the grid, or hides it on `< 640 px` and surfaces "Vừa luyện tập" as a chip-row.
- Effort: small

### D3 — Search input lacks an explicit label
- Category: a11y
- Severity: low
- File: [screens/dictionary.js:55-58](signpath-test/screens/dictionary.js#L55)
- What's wrong: Only the placeholder identifies the input; placeholder text is not a substitute for an accessible name.
- Fix: Add `aria-label="Tìm kiếm dấu"` to the `<input>`.
- Effort: trivial

### D4 — Category chips show VI label only
- Category: localization
- Severity: low
- File: [screens/dictionary.js:71](signpath-test/screens/dictionary.js#L71)
- What's wrong: Each chip uses `l.goal.vi` even though `l.goal.en` is available; rest of the app pairs both.
- Fix: Add `l.goal.en` as a `title`/tooltip on the chip (full bilingual labels would overflow the chip row).
- Effort: trivial

### D5 — Status header is VI-only
- Category: localization
- Severity: low
- File: [screens/dictionary.js:81-82, 140-142](signpath-test/screens/dictionary.js#L81)
- What's wrong: "Hiển thị X / Y dấu" and "Không tìm thấy dấu nào" have no EN companion.
- Fix: Append `' · Showing X of Y'` and `' · No signs found'`.
- Effort: trivial

### D6 — No-template toast is VI-only
- Category: localization
- Severity: low
- File: [screens/dictionary.js:172](signpath-test/screens/dictionary.js#L172)
- What's wrong: "Dấu này chưa có dữ liệu chấm điểm" — same omission as L3.
- Fix: Append `' · No scoring data for this sign'`.
- Effort: trivial

### D7 — "Tải thêm" is the only paging affordance
- Category: polish
- Severity: low
- File: [screens/dictionary.js:88-91](signpath-test/screens/dictionary.js#L88)
- What's wrong: A user who wants to scan all 400 signs has to click "Tải thêm · Load more" ~33 times.
- Fix: Add a "Hiện tất cả · Show all" secondary action next to the load-more button.
- Effort: trivial

---

## Result modal (`screens/modals.js`, lines 17-247)

### R1 — No close button (X)
- Category: a11y
- Severity: medium
- File: [screens/modals.js:43-48](signpath-test/screens/modals.js#L43)
- What's wrong: Modal can only be dismissed by clicking the scrim or one of the action buttons; there's no visible close affordance, and clicking the scrim on a small screen with a fingertip is fiddly.
- Fix: Add a top-right close button (`aria-label="Đóng · Close"`) inside the modal that calls `close()`.
- Effort: trivial

### R2 — No keyboard ESC handler
- Category: a11y
- Severity: medium
- File: [screens/modals.js:25-46](signpath-test/screens/modals.js#L25)
- What's wrong: Pressing ESC while the modal is open does nothing; default expectation for any modal is ESC-to-close.
- Fix: On open, attach a `keydown` listener that calls `close()` on `Escape`; remove on close.
- Effort: trivial

### R3 — Modal does not trap focus
- Category: a11y
- Severity: medium
- File: [screens/modals.js:25-233](signpath-test/screens/modals.js#L25)
- What's wrong: Tab cycles to elements outside the modal (record button, sidebar links) — screen-reader and keyboard users get lost.
- Fix: On open, move focus to the primary action button and constrain Tab/Shift+Tab to the modal's focusable descendants until close.
- Effort: medium

### R4 — Modal too wide for small phones
- Category: polish
- Severity: medium
- File: [screens/modals.js:47](signpath-test/screens/modals.js#L47) + [ui/signpath-styles.css:319-328](signpath-test/ui/signpath-styles.css#L319)
- What's wrong: `.sp-modal-lg` caps at 800 px and `.sp-modal` uses `padding: 2.5rem`; on a 360 px phone the inner content gets ≈ 280 px after padding and the per-finger pill row wraps awkwardly.
- Fix: Reduce `padding` to `1.5rem` and `max-height: 92vh` on `< 640 px`; let pills wrap to two short rows instead of one cramped row.
- Effort: small

### R5 — Per-finger names may fall back to English `f.name`
- Category: localization
- Severity: low
- File: [screens/modals.js:166-179](signpath-test/screens/modals.js#L166)
- What's wrong: `f.nameVi || f.name` — if older payloads (or future engine variants) omit `nameVi`, the user sees "Thumb"/"Index" mid-Vietnamese modal.
- Fix: Add a `FINGER_VI` lookup map in `screens/shared.js` keyed on canonical English finger names, and fall back to it before `f.name`.
- Effort: small

### R6 — Body scroll not locked while modal is open
- Category: polish
- Severity: low
- File: [screens/modals.js:25-233](signpath-test/screens/modals.js#L25)
- What's wrong: Scrolling the page (mouse wheel, touch) while the modal is open scrolls the underlying screen behind the scrim — distracting on mobile.
- Fix: On open, set `document.body.style.overflow = 'hidden'`; restore on close.
- Effort: trivial

### R7 — Coach advice card has no overflow handling
- Category: polish
- Severity: low
- File: [screens/modals.js:136-147](signpath-test/screens/modals.js#L136)
- What's wrong: An unusually long advice string can push the action buttons below the visible modal area; modal does scroll, but action buttons drop out of immediate view.
- Fix: Cap advice card with `max-height: 8rem; overflow-y: auto`.
- Effort: trivial

### R8 — "Cần ≥ 50 để vượt qua" is the only place threshold is exposed
- Category: polish
- Severity: low
- File: [screens/modals.js:67](signpath-test/screens/modals.js#L67)
- What's wrong: Hardcoded `50` in both the gate and the copy; if `PASS_GATE` (in `shared.js`) ever changes the user-facing copy goes stale.
- Fix: Read `SP.PASS_GATE` and interpolate it into the string (`'Cần ≥ ' + SP.PASS_GATE + ' để vượt qua · Need ≥ ' + SP.PASS_GATE + ' to pass'`).
- Effort: trivial

---

## Rank-up modal (`screens/modals.js`, lines 254-307)

### RU1 — Bạch kim (Platinum) accent text fails contrast
- Category: a11y
- Severity: high
- File: [screens/shared.js:179-185](signpath-test/screens/shared.js#L179) + [screens/modals.js:266, 273-276](signpath-test/screens/modals.js#L266)
- What's wrong: `RANK_COLORS['Bạch kim'] = 'var(--sp-outline-variant)'` (#b7b1a7) used for the rank name (32 px bold) on `--sp-surface-container-lowest` (#fff) measures ≈ 2.0:1 — fails WCAG AA (3:1 for large text). "Bạc" on the same background ≈ 3.4:1 (borderline).
- Fix: Replace `--sp-outline-variant` with a darker shade (e.g. `#7a7066`) for Bạch kim, and bump Bạc to a stronger gray; or flip the rank name to `--sp-on-surface` and tint the medal emoji instead.
- Effort: trivial

### RU2 — No keyboard ESC handler
- Category: a11y
- Severity: medium
- File: [screens/modals.js:254-293](signpath-test/screens/modals.js#L254)
- What's wrong: Same as R2; rank-up modal also has no ESC support.
- Fix: Reuse the same `keydown` handler added for R2.
- Effort: trivial

### RU3 — Modal does not trap focus
- Category: a11y
- Severity: medium
- File: [screens/modals.js:254-293](signpath-test/screens/modals.js#L254)
- What's wrong: Same as R3.
- Fix: Same as R3 (focus the "Tiếp tục" button on open, trap Tab).
- Effort: medium

### RU4 — Rank-up has no celebratory animation
- Category: polish
- Severity: low
- File: [screens/modals.js:264-293](signpath-test/screens/modals.js#L264)
- What's wrong: A rare achievement (one rank every 10 levels) lands with the same fade-in as the result modal — no confetti, no badge reveal — feels anticlimactic during demo.
- Fix: Add a 600 ms scale/spin animation on the medal emoji and tint the modal background with `radial-gradient(...rank-color)`; use `prefers-reduced-motion` to opt out.
- Effort: small

### RU5 — Sub-headline mixes "Cấp" + bare numbers
- Category: localization
- Severity: low
- File: [screens/modals.js:277-278](signpath-test/screens/modals.js#L277)
- What's wrong: `'Cấp ' + prevLevel + ' · ' + prevRank + '  →  Cấp ' + newLevel + ' · ' + newRank` — the EN companion line is missing entirely (other modals use bilingual eyebrows).
- Fix: Render an EN line below ("Lv X · Y → Lv A · B").
- Effort: trivial

### RU6 — "Tiếp tục" button is VI-only
- Category: localization
- Severity: low
- File: [screens/modals.js:282-287](signpath-test/screens/modals.js#L282)
- What's wrong: Other primary actions in the result modal use `' · '` bilingual ("Thử lại · Try again", "Dấu tiếp theo · Next sign"); this one breaks the pattern.
- Fix: Render the label as `'Tiếp tục · Continue'`.
- Effort: trivial

---

## Cross-cutting observations (informational, not numbered)

These were noticed during the screen passes but don't merit per-screen
findings; included here so Phuong has full context.

- The topbar avatar `'H'` ([screens/shared.js:212](signpath-test/screens/shared.js#L212))
  is hardcoded — fine for a single-user demo, but worth flagging if the
  audience asks about user accounts.
- The sidebar engine-status pill ([app.html:36-38](signpath-test/app.html#L36))
  permanently shows "✓ 400 dấu, 25 chương" — a developer-grade metric
  visible to demo viewers; could be hidden behind a debug flag post-demo.
- The CSS palette is light-mode only; no `prefers-color-scheme: dark`
  support. Acceptable for v0.5 but worth a roadmap line.
- The `.sp-card:hover { transform: translateY(-4px) }` rule
  ([ui/signpath-styles.css:178](signpath-test/ui/signpath-styles.css#L178))
  has no `prefers-reduced-motion` opt-out; minor a11y nit.

---

## Fix batch candidates

Four batches, each scoped to land independently. Effort totals are
trivial=15min, small=45min, medium=2h.

### Batch 1 — Demo-critical (≈ 1.5 h)

The visible-in-demo flaws. Land first, before any polish or a11y work.

- **P1** Replace "Ghi âm" with "Quay" everywhere — *trivial*
- **P2** Fix landmark-canvas overflow on mobile — *small*
- **P3** Disabled-record button label — *trivial*
- **H2** Topbar skeleton during engine boot — *small*
- **H3** Continue card "current sign" accuracy — *small*
- **RU1** Bạch kim rank colour contrast — *trivial*

Total: 4 trivial + 3 small ≈ 1 h 45 min

### Batch 2 — Polish quick wins (≈ 2 h)

Visible improvements that don't change information architecture.

- **H5** Hardcoded `25` chapter count — *trivial*
- **H6** Streak shows bare "0" → "0 ngày" — *trivial*
- **H8** Lesson node chapter index badge — *small*
- **H9** "HIỆN TẠI" badge clipping — *trivial*
- **L2** "Chưa có dữ liệu" tag contrast bump — *trivial*
- **P7** Coach advice max-height — *trivial*
- **P10** Live-score throttle/lerp — *small*
- **P11** "Chưa thấy tay" pill colour — *trivial*
- **P9** Reference-video play/pause control — *small*
- **P4** Cancel-attempt during recording — *small*
- **PR5** Sort mastery bars least-familiar first — *trivial*
- **PR7** KPI card primary/secondary split — *small*
- **D7** "Hiện tất cả" load-all action — *trivial*
- **R4** Modal padding on `< 640 px` — *small*
- **R6** Body scroll lock — *trivial*
- **R7** Coach advice max-height in modal — *trivial*
- **R8** Read `PASS_GATE` instead of literal `50` — *trivial*
- **RU4** Rank-up celebratory animation — *small*

Total: 11 trivial + 7 small ≈ 8 h (split across 2 sittings if needed; can drop animation/cancel-attempt if scope tight)

### Batch 3 — Localization cleanup (≈ 1 h)

Pure copy edits, no logic changes; one sweep through screens + modals.

- **H4** Hero subtitle bilingual — *trivial*
- **H7** Locked-node toast separator — *trivial*
- **L3** Lesson card no-template toast — *trivial*
- **L4** "Kỷ lục" → bilingual — *trivial*
- **L6** Empty-chapter copy separator — *trivial*
- **P8** Degraded-tracking aria-label — *trivial*
- **P12** Practice initial coach copy — *trivial*
- **PR4** Reason badge VI · EN — *trivial*
- **PR6** Empty review-queue copy — *trivial*
- **D4** Category chip EN tooltip — *trivial*
- **D5** Dictionary status header bilingual — *trivial*
- **D6** Dictionary card no-template toast — *trivial*
- **R5** Finger name VI fallback — *small*
- **RU5** Rank-up sub-headline EN line — *trivial*
- **RU6** "Tiếp tục" → "Tiếp tục · Continue" — *trivial*

Total: 14 trivial + 1 small ≈ 4 h

### Batch 4 — Accessibility (≈ 4 h)

Requires real DOM/semantic changes; lower demo-risk but raises the bar
on shipping quality.

- **H1** Lesson nodes keyboardable — *small*
- **L1** Lesson sign cards keyboardable — *small*
- **L5** Back-link icon `aria-hidden` — *trivial*
- **PR1** Mastery cards keyboardable — *small*
- **PR3** Review queue VI/EN labelling — *small*
- **D1** Dictionary cards keyboardable — *small*
- **D2** Dictionary mobile stacking — *small*
- **D3** Search `aria-label` — *trivial*
- **PR2** Progress mobile stacking — *small*
- **P5** Practice mid-width overlap — *small*
- **P6** Camera height flex layout — *small*
- **R1** Result modal close (X) — *trivial*
- **R2** Result modal ESC — *trivial*
- **R3** Result modal focus trap — *medium*
- **RU2** Rank-up ESC — *trivial*
- **RU3** Rank-up focus trap — *medium*

Total: 5 trivial + 9 small + 2 medium ≈ 11 h (the two focus-trap items
can share a single helper to reduce real cost to ≈ 7 h)
