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
  // Button rects as fractions of the container (x, y, w, h). These place
  // the three buttons along the top edge, well clear of the back overlay
  // and framing-guide pills rendered by buildAttemptUI.
  // Positioned BELOW the top strip (sign-info card + framing pills) so
  // the pills and the air-tap dwell rings never overlap. y is expressed
  // as a fraction of the camera container height to scale with viewport.
  const RECTS = {
    back:  { x: 0.02,  y: 0.20, w: 0.11, h: 0.18 },
    start: { x: 0.445, y: 0.20, w: 0.11, h: 0.18 },
    next:  { x: 0.87,  y: 0.20, w: 0.11, h: 0.18 },
  }
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
        const rect = RECTS[key]
        const inside = tips.some(t =>
          t.x >= rect.x && t.x <= rect.x + rect.w &&
          t.y >= rect.y && t.y <= rect.y + rect.h)

        if (!inside) {
          // Released — reset everything; next entry begins a fresh dwell.
          if (st.hovered) {
            st.hovered = false
            st.startedAt = 0
            btn.el.classList.remove('hovering')
            // A fired button re-arms when the fingertip exits.
            st.fired = false
            st.requireExit = false
          }
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
    const rect = RECTS[key]
    Object.assign(el.style, {
      position: 'absolute',
      left: (rect.x * 100) + '%',
      top:  (rect.y * 100) + '%',
      width:  (rect.w * 100) + '%',
      height: (rect.h * 100) + '%',
      pointerEvents: 'none',
    })

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

  SP.airtap = { mount, _RECTS: RECTS }
})();
