/**
 * Air-tap overlay for gesture-nav (WIP).
 *
 * Mounts three semi-transparent circular buttons (Back / Start-Stop /
 * Next) on a camera container. Each button fires when ANY visible
 * fingertip landmark (hand landmarks 4, 8, 12, 16, 20 on either hand)
 * dwells inside its on-screen rect for DWELL_MS. A CSS progress ring
 * fills during the dwell.
 *
 * Dwell bookkeeping is JS-driven; the ring fill itself is a CSS
 * transition on stroke-dashoffset so the animation is free and the
 * cancel-on-hover-end happens just by switching the class.
 *
 * Coordinate mapping: the camera is displayed mirrored (transform:
 * scaleX(-1)), so landmark x is mirrored to x_screen = 1 - x before
 * hit-testing against the button rects (which are fractions of the
 * container's visible width).
 *
 * Usage:
 *   const overlay = SP.airtap.mount(container, {
 *     subscribeTracking,   // fn(handler) → unsubscribe; handler receives
 *                          // the engine's 'tracking' event payload
 *     onBack,              // () => void
 *     onNext,              // () => void
 *     onStartStop,         // () => void
 *     getIsRecording,      // () => boolean
 *   })
 *   // Later:
 *   overlay.teardown()
 */
;(function() {
  'use strict'

  const SP = window.SP = window.SP || {}

  const DWELL_MS = 1000
  const TRIGGER_FLASH_MS = 600
  const RADIUS = 38                 // px; 76px diameter
  const CIRCUMFERENCE = 2 * Math.PI * RADIUS
  // Hand landmark indices that count as fingertips.
  const FINGERTIP_IDS = [4, 8, 12, 16, 20]

  function mount(container, opts) {
    opts = opts || {}

    const wrap = document.createElement('div')
    wrap.className = 'sp-airtap-wrap'
    Object.assign(wrap.style, {
      position: 'absolute', inset: '0',
      pointerEvents: 'none', zIndex: '5',
    })

    const backBtn   = buildButton('back',  'arrow_back',  'Quay lại', opts.onBack || noop)
    const startBtn  = buildButton('start', 'fiber_manual_record', 'Bắt đầu', opts.onStartStop || noop)
    const nextBtn   = buildButton('next',  'arrow_forward', 'Tiếp theo', opts.onNext || noop)
    wrap.appendChild(backBtn.el)
    wrap.appendChild(startBtn.el)
    wrap.appendChild(nextBtn.el)
    container.appendChild(wrap)

    const buttons = { back: backBtn, start: startBtn, next: nextBtn }
    // Each button tracks whether it's currently hovered, when it started,
    // whether it has fired already this hover, and a "must leave before
    // next trigger" flag to prevent an instant trigger on mount.
    const state = {
      back:  { hovered: false, startedAt: 0, fired: false, requireExit: true },
      start: { hovered: false, startedAt: 0, fired: false, requireExit: true },
      next:  { hovered: false, startedAt: 0, fired: false, requireExit: true },
    }

    // Hit rects in container-fraction space, derived from each button's
    // actual DOM rect. The DOM is the source of truth — CSS controls
    // where the buttons render, so hit-testing just measures where they
    // landed. Cached on mount + window resize so we're not forcing a
    // layout flush every tracking frame.
    const rects = { back: null, start: null, next: null }
    function recomputeRects() {
      const conR = container.getBoundingClientRect()
      if (!conR.width || !conR.height) return
      for (const key of Object.keys(buttons)) {
        const btnR = buttons[key].el.getBoundingClientRect()
        rects[key] = {
          x1: (btnR.left   - conR.left) / conR.width,
          x2: (btnR.right  - conR.left) / conR.width,
          y1: (btnR.top    - conR.top)  / conR.height,
          y2: (btnR.bottom - conR.top)  / conR.height,
        }
      }
    }
    // Defer initial measurement a tick so any CSS transitions (sidebar
    // collapse, responsive layout) have settled before we read.
    setTimeout(recomputeRects, 0)
    window.addEventListener('resize', recomputeRects)

    // Sync start/stop visuals against the live recording state so the
    // air-tap button mirrors the click Record button.
    function refreshStartLabel() {
      const rec = opts.getIsRecording ? !!opts.getIsRecording() : false
      startBtn.iconEl.textContent = rec ? 'stop' : 'fiber_manual_record'
      startBtn.labelEl.textContent = rec ? 'Dừng' : 'Bắt đầu'
    }
    refreshStartLabel()
    const recRefreshTimer = setInterval(refreshStartLabel, 300)

    // Subscribe to engine tracking events.
    let unsubscribe = null
    if (typeof opts.subscribeTracking === 'function') {
      unsubscribe = opts.subscribeTracking(onTracking)
    }

    function onTracking(d) {
      if (!d) return
      // Fingertip positions in [0,1] camera space. Mirror x so screen-space
      // matches the user's perception (we render the feed mirrored).
      const tips = []
      const hands = [d.rightHand, d.leftHand]
      for (const hand of hands) {
        if (!hand) continue
        for (const idx of FINGERTIP_IDS) {
          const lm = hand[idx]
          if (!lm) continue
          tips.push({ x: 1 - lm.x, y: lm.y })
        }
      }

      const now = Date.now()
      for (const key of Object.keys(buttons)) {
        const btn = buttons[key]
        const st  = state[key]
        const rect = rects[key]
        if (!rect) continue
        // Fingertip already mirrored (fx = 1 - lm.x) above; hit-test
        // against the button's measured rect in the same fraction space.
        const inside = tips.some(t =>
          t.x >= rect.x1 && t.x <= rect.x2 &&
          t.y >= rect.y1 && t.y <= rect.y2)

        if (!inside) {
          // Released — reset everything; next entry begins a fresh dwell.
          if (st.hovered) {
            st.hovered = false
            st.startedAt = 0
            btn.el.classList.remove('hovering')
            // A fired button re-arms when the fingertip exits.
            st.fired = false
          }
          // Must clear the at-mount sentinel unconditionally — st.hovered
          // can't become true while requireExit is still true (the "inside"
          // branch short-circuits on requireExit before it can set hovered),
          // so leaving this inside `if (st.hovered)` deadlocks every button.
          st.requireExit = false
          continue
        }

        // Inside.
        if (st.requireExit) continue   // wait for the user to leave first
        if (st.fired) continue         // already fired this hover
        if (!st.hovered) {
          st.hovered = true
          st.startedAt = now
          btn.el.classList.add('hovering')
          continue
        }
        if (now - st.startedAt >= DWELL_MS) {
          st.fired = true
          st.requireExit = false
          btn.el.classList.add('triggered')
          setTimeout(() => { btn.el.classList.remove('triggered') }, TRIGGER_FLASH_MS)
          btn.el.classList.remove('hovering')
          try { btn.action() } catch(e) { console.error('[airtap] action error:', e) }
        }
      }
    }

    // Inject the CSS once per document. The ring transition is CSS-driven
    // (stroke-dashoffset) so cancel-on-exit is instant — we just flip the
    // .hovering class.
    injectStylesOnce()

    return {
      teardown() {
        clearInterval(recRefreshTimer)
        window.removeEventListener('resize', recomputeRects)
        if (typeof unsubscribe === 'function') {
          try { unsubscribe() } catch(_) {}
        }
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap)
      }
    }
  }

  function buildButton(key, iconName, label, action) {
    const el = document.createElement('div')
    el.className = 'sp-airtap-btn sp-airtap-' + key
    el.dataset.key = key
    // Position is owned by CSS (see injectStylesOnce below). The hit
    // test measures the resulting DOM rect each resize, so moving the
    // buttons later only requires a CSS tweak — no JS coordinate sync.
    el.style.position = 'absolute'
    el.style.pointerEvents = 'none'

    // Inner circular pill — sized from min(width,height) so the visual
    // button stays circular across aspect ratios.
    const pill = document.createElement('div')
    pill.className = 'sp-airtap-pill'
    pill.innerHTML = `
      <svg class="sp-airtap-ring" viewBox="0 0 100 100" aria-hidden="true">
        <circle class="sp-airtap-ring-bg" cx="50" cy="50" r="46"
          fill="none" stroke="rgba(255,255,255,.25)" stroke-width="5"></circle>
        <circle class="sp-airtap-ring-fg" cx="50" cy="50" r="46"
          fill="none" stroke="rgba(246,138,47,.95)" stroke-width="5"
          stroke-linecap="round"
          stroke-dasharray="${(2 * Math.PI * 46).toFixed(3)}"
          stroke-dashoffset="${(2 * Math.PI * 46).toFixed(3)}"
          transform="rotate(-90 50 50)"></circle>
      </svg>
      <div class="sp-airtap-icon"><span class="material-symbols-outlined"></span></div>
      <div class="sp-airtap-label"></div>
    `
    el.appendChild(pill)
    const iconEl = pill.querySelector('.material-symbols-outlined')
    const labelEl = pill.querySelector('.sp-airtap-label')
    iconEl.textContent = iconName
    labelEl.textContent = label

    return { el, iconEl, labelEl, action }
  }

  function noop() {}

  let _stylesInjected = false
  function injectStylesOnce() {
    if (_stylesInjected) return
    _stylesInjected = true
    const css = `
      /* Button placement owned here so DOM rects and hit-testing cannot
         drift apart — hit rects are measured from these elements at
         runtime, no JS coordinate constants involved. Top value sits
         the buttons just below the sign-info card + framing-pill row
         at the top of the camera. */
      .sp-airtap-back  { left:2%;   top:10%; width:11%; height:18%; }
      .sp-airtap-start { left:44.5%; top:10%; width:11%; height:18%; }
      .sp-airtap-next  { left:87%;  top:10%; width:11%; height:18%; }
      .sp-airtap-btn { display:flex; align-items:center; justify-content:center; }
      .sp-airtap-pill {
        position:relative; width:76px; height:76px; border-radius:9999px;
        background: rgba(15,14,10,.55);
        box-shadow: 0 6px 18px rgba(0,0,0,.35);
        display:flex; align-items:center; justify-content:center;
        color:#fff; transition: transform .2s ease, background .2s ease;
      }
      .sp-airtap-ring {
        position:absolute; inset:0; width:100%; height:100%;
      }
      .sp-airtap-ring-fg {
        transition: stroke-dashoffset 1s linear;
      }
      .sp-airtap-btn.hovering .sp-airtap-ring-fg {
        stroke-dashoffset: 0 !important;
      }
      .sp-airtap-btn:not(.hovering) .sp-airtap-ring-fg {
        transition: stroke-dashoffset 180ms ease;
      }
      .sp-airtap-btn.triggered .sp-airtap-pill {
        background: rgba(90, 154, 60, .92);
        transform: scale(1.08);
      }
      .sp-airtap-icon {
        position:absolute; font-size:2rem;
      }
      .sp-airtap-icon .material-symbols-outlined { font-size:1.75rem; }
      .sp-airtap-label {
        position:absolute; bottom:-1.5rem; left:50%; transform:translateX(-50%);
        font-size:.6875rem; font-weight:600; color:#fff;
        background:rgba(15,14,10,.62); padding:.125rem .5rem; border-radius:9999px;
        white-space:nowrap;
      }
    `
    const tag = document.createElement('style')
    tag.setAttribute('data-sp-airtap', '1')
    tag.textContent = css
    document.head.appendChild(tag)
  }

  SP.airtap = { mount }
})();
