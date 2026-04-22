/**
 * Practice screen (#practice/:sign). THE critical screen.
 *   Camera fills the main surface; reference video thumbnail is pinned
 *   top-right (~25% width); coach-advice panel sits beneath it, above
 *   the record controls. A transparent <canvas> overlay draws hand +
 *   pose landmarks from every MediaPipe frame.
 * On record, runs a 4s attempt and shows the result modal.
 *
 * The per-attempt UI (camera surface, overlays, framing guide, right
 * column, record controls + event wiring) is factored into
 * SP.practiceUI.buildAttemptUI so the skip-test screen can reuse the
 * exact same DOM + event plumbing without duplicating it. Practice's
 * render is a thin wrapper that supplies the modal-based completion
 * callback; skip-test supplies a different callback but gets the same
 * camera chrome.
 */
;(function() {
  'use strict'

  const SP = window.SP
  SP.screens = SP.screens || {}
  SP.practiceUI = SP.practiceUI || {}

  /**
   * Build the per-attempt practice UI: camera surface with framing guide,
   * reference-video panel, coach panel, record controls, and all event
   * wiring from the engine/session streams.
   *
   * @param {SignPathApp} app
   * @param {Object} opts
   * @param {Object} opts.signData     { key, vi, en, unitId, hasTemplate, ... }
   * @param {string} [opts.backHref]   href for the top-left back link
   * @param {string} [opts.backLabel]  text for the back link
   * @param {string} [opts.stepBadge]  optional extra overlay line shown above the
   *                                   back link — e.g. "Dấu 1 / 3".
   * @param {number} [opts.durationMs] attempt duration (default 4000)
   * @param {boolean} [opts.recordOnce] if true, record button stays disabled
   *                                    after the first attempt resolves.
   * @param {boolean} [opts.hideReferenceVideo] if true, the reference-video
   *                                    panel is not rendered and the right
   *                                    column shrinks so the camera feed
   *                                    expands into the freed space.
   * @param {Function} [opts.onAttemptComplete] async (result) => void.
   *                                    If provided, helper skips the default
   *                                    result-modal flow and hands the result
   *                                    to the caller.
   * @param {Object}   [opts.modalActions] used only when onAttemptComplete is
   *                                    not provided — { onTryAgain, onNext, onBack }.
   * @returns {{ root: Element, recordBtn: Element, runAttempt: Function, teardown: Function }}
   */
  function buildAttemptUI(app, opts) {
    opts = opts || {}
    const signData = opts.signData
    if (!signData || !signData.key) throw new Error('buildAttemptUI requires opts.signData.key')
    const signKey = signData.key
    const hasTemplate = !!signData.hasTemplate
    const durationMs = opts.durationMs || 4000
    const defaultBackHref = '#lesson/' + encodeURIComponent(signData.unitId || '')
    const backHref = opts.backHref || defaultBackHref
    const backLabel = opts.backLabel || 'Về chương'

    // Closure-scoped handler registry so multiple instances (e.g. one per
    // skip-test step) cleanly detach their own events.
    const handlers = []
    function on(eventName, handler) {
      app.on(eventName, handler)
      handlers.push([eventName, handler])
    }
    function detachAll() {
      for (const [e, h] of handlers) { try { app.off(e, h) } catch(_) {} }
      handlers.length = 0
    }

    // Eager select — ensures score events for this sign flow from the
    // moment capture resumes.
    try { app.engine.selectSign(signKey) } catch(e) { console.error('[practiceUI] selectSign failed:', e) }

    // Root wrapper contains the degraded banner and the practice surface.
    const root = SP.h('div', { class:'sp-practice-root' })

    // ── Palm-fallback warning banner (hidden until 'tracking:degraded') ─
    const degradedBanner = SP.h('div', { id: 'sp-degraded-banner', style:{
      display: 'none',
      margin: '.5rem 1rem 0',
      padding: '.75rem 1rem',
      background: 'var(--sp-tertiary-container)',
      color: 'var(--sp-on-tertiary-container)',
      borderRadius: '.75rem',
      fontSize: '.8125rem', fontWeight: 500,
      alignItems: 'flex-start', gap: '.5rem',
    }},
      SP.h('span', { class:'material-symbols-outlined', style:{ fontSize:'1.125rem', flexShrink:0 }}, 'warning'),
      SP.h('div', { style:{ flex:1, lineHeight:1.4 }},
        SP.h('div', { style:{ fontWeight:700 }}, 'Khung hình chưa đủ'),
        SP.h('div', {}, 'Lùi ra xa camera hoặc bật thêm ánh sáng · Step back or improve lighting'),
      ),
      SP.h('button', { 'aria-label':'Dismiss',
        style:{
          background:'transparent', border:'none', cursor:'pointer',
          color:'var(--sp-on-tertiary-container)', padding:'.25rem',
          fontFamily:'inherit',
        },
        onclick: () => {
          degradedBanner.style.display = 'none'
          degradedManuallyDismissed = true
        }
      }, SP.h('span', { class:'material-symbols-outlined'}, 'close')),
    )
    let degradedManuallyDismissed = false
    let degradedQuietTimer = null
    root.appendChild(degradedBanner)

    // ── Practice surface: camera full-bleed with overlays ──────────────
    const practiceWrap = SP.h('div', { class:'sp-practice-wrap', style:{
      position:'relative',
      margin:'.5rem 1rem 1rem',
      height:'calc(100vh - 7rem)',
      minHeight:'32rem',
      borderRadius:'var(--sp-r-md)',
      overflow:'hidden',
      background:'#000',
    }})

    const camVideo = SP.h('video', { autoplay:'', muted:'', playsinline:'',
      style:{
        position:'absolute', inset:0,
        width:'100%', height:'100%',
        objectFit:'cover',
        transform:'scaleX(-1)',
      },
    })
    practiceWrap.appendChild(camVideo)

    const landmarkCanvas = SP.h('canvas', { id:'sp-landmark-canvas',
      width: 1280, height: 720,
      style:{
        position:'absolute', inset:0,
        width:'100%', height:'100%',
        transform:'scaleX(-1)',
        pointerEvents:'none',
      },
    })
    practiceWrap.appendChild(landmarkCanvas)
    const landmarkCtx = landmarkCanvas.getContext('2d')

    // Stream mirror: engine owns the hidden sp-engine-video; forward its
    // srcObject onto our visible element.
    const engineVideo = document.getElementById('sp-engine-video')
    function syncStream() {
      try { camVideo.srcObject = engineVideo.srcObject } catch(_){}
    }
    syncStream()
    const streamPoller = setInterval(() => {
      if (!engineVideo.srcObject) return
      if (camVideo.srcObject !== engineVideo.srcObject) syncStream()
    }, 300)

    // Back overlay (top-left) — includes optional stepBadge line for
    // multi-step flows like the skip-test.
    const backOverlay = SP.h('div', { style:{
      position:'absolute', top:'1rem', left:'1rem', zIndex:3,
      display:'flex', flexDirection:'column', gap:'.125rem',
      background:'rgba(15, 14, 10, 0.6)',
      color:'#fff', padding:'.5rem .875rem',
      borderRadius:'.625rem',
      maxWidth:'20rem',
    }})
    if (opts.stepBadge) {
      backOverlay.appendChild(SP.h('div', {
        style:{ fontSize:'.625rem', letterSpacing:'.5px', textTransform:'uppercase',
          fontWeight:700, opacity:.85 }}, opts.stepBadge))
    }
    backOverlay.appendChild(SP.h('a', { href: backHref,
      style:{ color:'rgba(255,255,255,.78)', textDecoration:'none',
        display:'inline-flex', alignItems:'center', gap:'.25rem', fontSize:'.75rem' }},
      SP.h('span', { class:'material-symbols-outlined', style:{ fontSize:'1rem' }}, 'arrow_back'),
      SP.h('span', {}, backLabel),
    ))
    backOverlay.appendChild(SP.h('div',
      { style:{ fontSize:'1.125rem', fontWeight:800, lineHeight:1.1 }}, signData.vi))
    backOverlay.appendChild(SP.h('div',
      { style:{ fontSize:'.75rem', opacity:.75 }}, signData.en))
    practiceWrap.appendChild(backOverlay)

    // ── Framing guide (advisory, does NOT block recording) ────────────
    // The hand-detection indicator rides alongside the other three
    // framing pills instead of living as a separate bottom-left chip
    // so the user has a single "am I in frame?" strip to scan.
    const framePill = (id, label) => SP.h('div', { id,
      'data-state': 'pending',
      style:{
        display:'inline-flex', alignItems:'center', gap:'.375rem',
        padding:'.25rem .625rem', borderRadius:'9999px',
        fontSize:'.6875rem', fontWeight:600, lineHeight:1.2,
        background:'rgba(15,14,10,.72)', color:'rgba(255,255,255,.78)',
        border:'1px solid rgba(255,255,255,.14)',
        maxWidth:'18rem',
      }},
      SP.h('span', { class:'material-symbols-outlined', 'data-icon':'',
        style:{ fontSize:'.9rem', opacity:.9 }}, 'radio_button_unchecked'),
      SP.h('span', { 'data-label':'' }, label),
    )
    const framePillFace      = framePill('sp-frame-face', 'Khuôn mặt')
    const framePillShoulders = framePill('sp-frame-shoulders', 'Hai vai')
    const framePillLight     = framePill('sp-frame-light', 'Ánh sáng')
    const framePillHand      = framePill('sp-frame-hand', 'Chưa thấy tay')
    // handDot is the legacy name the rest of the file writes to — alias
    // it so we don't have to touch the tracking handler right now.
    const handDot = framePillHand
    const framingGuide = SP.h('div', { 'aria-label':'Hướng dẫn khung hình',
      style:{
        position:'absolute', top:'1rem', left:'50%', transform:'translateX(-50%)', zIndex:3,
        display:'flex', flexWrap:'wrap', gap:'.375rem', justifyContent:'center',
        pointerEvents:'none',
      }},
      framePillFace, framePillShoulders, framePillLight, framePillHand,
    )
    practiceWrap.appendChild(framingGuide)

    function setPillState(pill, state, text) {
      pill.dataset.state = state
      const icon = pill.querySelector('[data-icon]')
      const labelEl = pill.querySelector('[data-label]')
      if (labelEl) labelEl.textContent = text
      if (state === 'ok') {
        pill.style.background = 'rgba(27, 67, 50, .82)'
        pill.style.color = '#fff'
        pill.style.borderColor = 'rgba(125, 220, 155, .35)'
        if (icon) icon.textContent = 'check_circle'
      } else if (state === 'bad') {
        pill.style.background = 'rgba(120, 35, 25, .82)'
        pill.style.color = '#fff'
        pill.style.borderColor = 'rgba(255, 130, 110, .45)'
        if (icon) icon.textContent = 'error'
      } else {
        pill.style.background = 'rgba(15,14,10,.72)'
        pill.style.color = 'rgba(255,255,255,.78)'
        pill.style.borderColor = 'rgba(255,255,255,.14)'
        if (icon) icon.textContent = 'radio_button_unchecked'
      }
    }

    const FACE_X_MIN = 0.30, FACE_X_MAX = 0.70
    const FACE_Y_MIN = 0.15, FACE_Y_MAX = 0.55
    const LIGHT_MIN = 0.20, LIGHT_MAX = 0.85
    const engineInternals = (window.SignPathEngine && window.SignPathEngine._internals) || {}
    const SHOULDER_VIS_MIN = typeof engineInternals.SHOULDER_VIS_STRICT === 'number'
      ? engineInternals.SHOULDER_VIS_STRICT : 0.5

    function checkFaceCentered(face) {
      if (!face || !face.length) return { ok: false, tip: 'Chưa thấy khuôn mặt' }
      let sx = 0, sy = 0
      for (const p of face) { sx += p.x; sy += p.y }
      const mx = sx / face.length, my = sy / face.length
      if (mx < FACE_X_MIN || mx > FACE_X_MAX || my < FACE_Y_MIN || my > FACE_Y_MAX) {
        return { ok: false, tip: 'Di chuyển để khuôn mặt ở giữa' }
      }
      return { ok: true, tip: 'Khuôn mặt ở giữa' }
    }
    function checkShouldersVisible(pose) {
      if (!pose || pose.length <= 12) return { ok: false, tip: 'Di chuyển camera để thấy cả hai vai' }
      const lv = pose[11].visibility == null ? 1 : pose[11].visibility
      const rv = pose[12].visibility == null ? 1 : pose[12].visibility
      if (lv < SHOULDER_VIS_MIN || rv < SHOULDER_VIS_MIN) {
        return { ok: false, tip: 'Di chuyển camera để thấy cả hai vai' }
      }
      return { ok: true, tip: 'Thấy cả hai vai' }
    }
    const lightCanvas = document.createElement('canvas')
    lightCanvas.width = 64; lightCanvas.height = 48
    const lightCtx = lightCanvas.getContext('2d', { willReadFrequently: true })
    function checkLighting(videoEl) {
      if (!videoEl || !videoEl.videoWidth || !videoEl.videoHeight) return null
      try {
        lightCtx.drawImage(videoEl, 0, 0, lightCanvas.width, lightCanvas.height)
        const data = lightCtx.getImageData(0, 0, lightCanvas.width, lightCanvas.height).data
        let sum = 0
        const n = data.length / 4
        for (let i = 0; i < data.length; i += 4) {
          sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
        }
        const mean = (sum / n) / 255
        if (mean < LIGHT_MIN) return { ok: false, tip: 'Bật thêm ánh sáng', value: mean }
        if (mean > LIGHT_MAX) return { ok: false, tip: 'Giảm bớt ánh sáng', value: mean }
        return { ok: true, tip: 'Đủ ánh sáng', value: mean }
      } catch (_) {
        return null
      }
    }

    // Live score overlay (bottom-center)
    const scoreOverlay = SP.h('div', { style:{
      position:'absolute', bottom:'1rem', left:'50%', transform:'translateX(-50%)', zIndex:3,
      background:'rgba(15, 14, 10, 0.72)', color:'#fff',
      padding:'.625rem 1.25rem', borderRadius:'.75rem',
      textAlign:'center', minWidth:'6rem',
    }},
      SP.h('div', { id:'sp-live-score', style:{ fontSize:'1.75rem', fontWeight:800, lineHeight:1 }}, '—'),
      SP.h('div', { style:{ fontSize:'.625rem', letterSpacing:'.5px', textTransform:'uppercase', opacity:.8 }}, 'Điểm thử'),
    )
    practiceWrap.appendChild(scoreOverlay)

    // ── Full-bleed layout (gesture-nav WIP) ─────────────────────────────
    // Right-column reference panel is gone. Coach advice becomes a
    // bottom-left pill. Record controls sit at the bottom-center. The
    // reference video (when the caller doesn't opt out) floats over the
    // camera via SP.refFloater, draggable between corners.
    const hideRef = !!opts.hideReferenceVideo

    const adviceCard = SP.h('div', { id:'sp-coach-box', style:{
      position:'absolute', bottom:'1rem', left:'1rem', zIndex:3,
      maxWidth:'28rem',
      background:'rgba(28, 26, 22, 0.78)',
      color:'#fff',
      borderLeft:'4px solid var(--sp-primary)',
      borderRadius:'.625rem',
      padding:'.625rem .875rem',
      fontSize:'.8125rem',
      lineHeight:1.4,
      boxShadow:'0 6px 18px rgba(0,0,0,.38)',
    }},
      SP.h('div', { style:{
        fontSize:'.625rem', fontWeight:700,
        textTransform:'uppercase', letterSpacing:'.5px',
        marginBottom:'.125rem', opacity:.85,
      }}, 'Lời khuyên AI'),
      SP.h('div', { id:'sp-coach-text' },
        hasTemplate ? 'Xem video mẫu rồi nhấn Quay để bắt đầu.'
                    : 'Dấu này chưa có dữ liệu chấm điểm. Bạn chỉ có thể xem video mẫu.'),
    )
    practiceWrap.appendChild(adviceCard)

    const progressWrap = SP.h('div', { style:{ width:'100%', height:'.375rem', background:'rgba(255,255,255,.16)', borderRadius:'9999px', overflow:'hidden' }},
      SP.h('div', { id:'sp-rec-progress', style:{ height:'100%', width:'0%', background:'linear-gradient(90deg, #954b00 0%, #f68a2f 100%)', transition:'width 100ms linear' }})
    )
    const recordBtn = SP.h('button', { id:'sp-record-btn', class:'sp-btn sp-btn-primary',
      disabled: !hasTemplate,
      onclick: runAttempt,
      style:{ width:'100%' },
    },
      SP.h('span', { class:'material-symbols-outlined filled' }, 'fiber_manual_record'),
      SP.h('span', {}, 'Quay · Record'),
    )
    const recordPanel = SP.h('div', { style:{
      position:'absolute', bottom:'1rem', left:'50%', transform:'translateX(-50%)', zIndex:3,
      width:'min(22rem, 45%)',
      background:'rgba(28, 26, 22, 0.82)',
      borderRadius:'.625rem',
      padding:'.625rem .75rem',
      display:'flex', flexDirection:'column', gap:'.5rem',
      boxShadow:'0 6px 18px rgba(0,0,0,.38)',
    }},
      recordBtn, progressWrap,
    )
    practiceWrap.appendChild(recordPanel)
    root.appendChild(practiceWrap)

    // Reference floater (freely draggable, clamped to container).
    // Skiptest and placement pass hideReferenceVideo:true so no floater
    // mounts for those flows. Persistence goes through progression.
    let refFloaterHandle = null
    if (!hideRef && SP.refFloater && typeof SP.refFloater.mount === 'function') {
      const prefsGet = () => (app.progression && app.progression.getUIPreferences
        ? app.progression.getUIPreferences() : {})
      const setPref = (k, v) => {
        if (app.progression && app.progression.setUIPreference) app.progression.setUIPreference(k, v)
      }
      refFloaterHandle = SP.refFloater.mount(practiceWrap, {
        signKey,
        getPosition: () => {
          const p = prefsGet()
          if (typeof p.refFloaterX === 'number' && typeof p.refFloaterY === 'number') {
            return { x: p.refFloaterX, y: p.refFloaterY }
          }
          return null
        },
        setPosition: (x, y) => { setPref('refFloaterX', x); setPref('refFloaterY', y) },
        // Legacy corner honoured on first mount for users who upgraded.
        getCorner: () => prefsGet().refFloaterCorner || 'br',
        getMinimized: () => !!prefsGet().refFloaterMinimized,
        setMinimized: (v) => setPref('refFloaterMinimized', !!v),
      })
    }

    // Responsive: narrow viewports stack advice above the record panel
    // at the bottom (still over the camera). Minimum-change from the
    // prior responsive branch — camera remains full-bleed.
    function applyResponsive() {
      const narrow = window.innerWidth < 768
      if (narrow) {
        practiceWrap.style.height = 'auto'
        practiceWrap.style.minHeight = '28rem'
        adviceCard.style.maxWidth = 'calc(100% - 2rem)'
        adviceCard.style.right = '1rem'
        recordPanel.style.width = 'min(20rem, 80%)'
      } else {
        practiceWrap.style.height = 'calc(100vh - 7rem)'
        practiceWrap.style.minHeight = '32rem'
        adviceCard.style.maxWidth = '28rem'
        adviceCard.style.right = ''
        recordPanel.style.width = 'min(22rem, 45%)'
      }
    }
    applyResponsive()
    window.addEventListener('resize', applyResponsive)

    // ── Event wiring ─────────────────────────────────────────────────
    // Refs for the DOM nodes the handlers mutate.
    const scoreEl = scoreOverlay.querySelector('#sp-live-score')
    const coachTextEl = adviceCard.querySelector('#sp-coach-text')
    const progEl  = progressWrap.querySelector('#sp-rec-progress')
    let activeDurationMs = 0
    let _lightFrameTick = 0
    let _deniedPainted = false

    on('tracking', d => {
      // Hand pill — shares styling with the other framing pills so
      // "pass" state collapses to the same green, "fail" to the same red.
      setPillState(framePillHand, d.detected ? 'ok' : 'bad',
        d.detected ? 'Thấy tay' : 'Chưa thấy tay')

      const face = checkFaceCentered(d.face)
      setPillState(framePillFace, face.ok ? 'ok' : 'bad', face.tip)
      const shoulders = checkShouldersVisible(d.pose)
      setPillState(framePillShoulders, shoulders.ok ? 'ok' : 'bad', shoulders.tip)
      _lightFrameTick = (_lightFrameTick + 1) % 5
      if (_lightFrameTick === 0) {
        const light = checkLighting(camVideo)
        if (light) setPillState(framePillLight, light.ok ? 'ok' : 'bad', light.tip)
      }

      const vw = camVideo.videoWidth, vh = camVideo.videoHeight
      if (vw && vh && (landmarkCanvas.width !== vw || landmarkCanvas.height !== vh)) {
        landmarkCanvas.width = vw
        landmarkCanvas.height = vh
      }
      landmarkCtx.clearRect(0, 0, landmarkCanvas.width, landmarkCanvas.height)
      if (typeof window.drawConnectors !== 'function' || typeof window.drawLandmarks !== 'function') return

      const HAND = window.HAND_CONNECTIONS || []
      const POSE = window.POSE_CONNECTIONS || []
      if (d.pose) {
        window.drawConnectors(landmarkCtx, d.pose, POSE, { color:'rgba(184,196,232,.55)', lineWidth:2 })
        window.drawLandmarks(landmarkCtx, d.pose, { color:'#f68a2f', lineWidth:1, radius:3 })
      }
      if (d.rightHand) {
        window.drawConnectors(landmarkCtx, d.rightHand, HAND, { color:'#5a9a3c', lineWidth:3 })
        window.drawLandmarks(landmarkCtx, d.rightHand, { color:'#d4922a', lineWidth:1, radius:2 })
      }
      if (d.leftHand) {
        window.drawConnectors(landmarkCtx, d.leftHand, HAND, { color:'#5a9a3c', lineWidth:3 })
        window.drawLandmarks(landmarkCtx, d.leftHand, { color:'#d4922a', lineWidth:1, radius:2 })
      }
    })

    on('error', d => {
      if (!d || (d.type !== 'camera' && d.type !== 'mediapipe')) return
      if (_deniedPainted) return
      _deniedPainted = true
      const isCamera = d.type === 'camera'
      const title = isCamera ? 'Cần quyền truy cập camera' : 'Không tải được MediaPipe'
      const body = isCamera
        ? 'Trình duyệt đã chặn camera. Vui lòng cấp quyền truy cập và tải lại trang.'
        : 'Không thể tải thư viện nhận diện. Kiểm tra kết nối mạng và thử lại.'
      const denied = SP.h('div', { id: 'sp-camera-denied', style:{
        position:'absolute', inset:0, zIndex:4,
        display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
        padding:'2rem', gap:'.75rem', textAlign:'center',
        background:'rgba(15,14,10,.94)', color:'#fff',
      }},
        SP.h('span', { class:'material-symbols-outlined',
          style:{ fontSize:'3rem', color:'var(--sp-error)', opacity:.9 }},
          isCamera ? 'videocam_off' : 'sync_problem'),
        SP.h('h2', { style:{ margin:0, fontSize:'1.25rem', fontWeight:700 }}, title),
        SP.h('p', { style:{ margin:0, maxWidth:'28rem', lineHeight:1.45, opacity:.85 }}, body),
        SP.h('div', { style:{ display:'flex', gap:'.5rem', marginTop:'.5rem' }},
          SP.h('button', { class:'sp-btn sp-btn-primary',
            onclick: () => location.reload() }, 'Tải lại · Reload'),
          SP.h('a', { class:'sp-btn', href:'#home' }, 'Về trang chủ · Home'),
        ),
      )
      practiceWrap.appendChild(denied)
      recordBtn.disabled = true
    })

    on('tracking:degraded', d => {
      if (degradedManuallyDismissed) return
      degradedBanner.style.display = 'flex'
      if (degradedQuietTimer) clearTimeout(degradedQuietTimer)
      degradedQuietTimer = setTimeout(() => {
        degradedBanner.style.display = 'none'
        degradedQuietTimer = null
      }, 5000)
    })

    on('score', d => {
      if (d.prediction === null || d.score == null) {
        scoreEl.textContent = '—'
        return
      }
      const display = SP.inflateScore ? SP.inflateScore(d.score) : d.score
      scoreEl.textContent = display
      scoreEl.style.color = SP.scoreColor(display)
    })

    on('attempt:start', d => {
      activeDurationMs = d.durationMs || durationMs
      progEl.style.width = '0%'
      recordBtn.disabled = true
      recordBtn.innerHTML = '<span class="material-symbols-outlined">hourglass_top</span><span>Đang ghi…</span>'
      coachTextEl.textContent = '🎥 Thực hiện dấu ngay — Signing now…'
    })
    on('attempt:tick', d => {
      const pct = Math.max(0, Math.min(100, 100 * d.elapsedMs / (activeDurationMs || 1)))
      progEl.style.width = pct + '%'
    })
    on('attempt:abort', d => {
      progEl.style.width = '0%'
      recordBtn.disabled = !hasTemplate
      recordBtn.innerHTML = '<span class="material-symbols-outlined filled">fiber_manual_record</span><span>Quay · Record</span>'
      coachTextEl.textContent = d.reason === 'no_signing_detected'
        ? 'Không thấy cử chỉ — hãy đảm bảo tay bạn trong khung hình, rồi thử lại.'
        : 'Đã hủy. Nhấn Quay để thử lại.'
    })
    on('attempt:end', d => {
      progEl.style.width = '100%'
      if (d.advice) coachTextEl.textContent = d.advice
    })
    on('attempt:coach-update', d => {
      if (d.advice) coachTextEl.textContent = d.advice
    })

    // Start (or restart) the capture pipeline now that the error + tracking
    // handlers are attached. Idempotent — safe to call across UI instances.
    if (typeof app.engine.resumeCapture === 'function') {
      app.engine.resumeCapture().catch(e => console.error('[practiceUI] resumeCapture failed:', e))
    }

    // Default modal completion flow (used when caller didn't provide
    // onAttemptComplete). Encapsulated so that runAttempt's happy path
    // has a single branching point.
    function defaultModalFlow(result) {
      SP.pushRecent(signKey)
      const modalActions = opts.modalActions || {}
      SP.modals.showResult(result, {
        onTryAgain: modalActions.onTryAgain || (() => { runAttempt() }),
        onNext:     modalActions.onNext     || (() => { location.hash = '#home' }),
        onBack:     modalActions.onBack     || (() => { location.hash = backHref }),
      })
    }

    async function runAttempt() {
      if (!hasTemplate || app.session.isActive()) return
      try {
        const result = await app.practiceSign(signKey, durationMs)
        if (opts.onAttemptComplete) {
          // Caller owns post-attempt flow — still handles aborted results.
          try { await opts.onAttemptComplete(result) }
          catch(e) { console.error('[practiceUI] onAttemptComplete threw:', e) }
        } else {
          if (result.aborted) return
          defaultModalFlow(result)
        }
      } catch (e) {
        SP.toast('Lỗi: ' + e.message)
        console.error(e)
      } finally {
        // recordOnce freezes the button so the skip-test can't fire a
        // second attempt on the same sign (task: "no retry, no re-record").
        if (opts.recordOnce) {
          recordBtn.disabled = true
        } else {
          recordBtn.disabled = !hasTemplate
        }
        recordBtn.innerHTML = '<span class="material-symbols-outlined filled">fiber_manual_record</span><span>Quay · Record</span>'
      }
    }

    // ── Air-tap overlay (gesture-nav WIP) ──────────────────────────────
    // Back / Start-Stop / Next buttons mounted over the camera. Actions
    // come from opts.airtapActions (each caller supplies its own context:
    // practice advances within a chapter; skiptest/placement within the
    // attempt sequence). Start/Stop and getIsRecording are owned here so
    // the click Record button and the air-tap stay in sync — recording
    // remains idempotent (session.isActive() guards both entry points).
    let airtapHandle = null
    if (SP.airtap && typeof SP.airtap.mount === 'function') {
      const airtapActions = opts.airtapActions || {}
      airtapHandle = SP.airtap.mount(practiceWrap, {
        subscribeTracking: (handler) => {
          app.on('tracking', handler)
          return () => app.off('tracking', handler)
        },
        onBack:  airtapActions.onBack  || function() {},
        onNext:  airtapActions.onNext  || function() {},
        onStartStop: () => {
          if (app.session && app.session.isActive()) {
            if (app.session.cancelAttempt) app.session.cancelAttempt()
          } else {
            runAttempt()
          }
        },
        getIsRecording: () => !!(app.session && app.session.isActive()),
      })
    }

    function teardown() {
      clearInterval(streamPoller)
      if (degradedQuietTimer) clearTimeout(degradedQuietTimer)
      window.removeEventListener('resize', applyResponsive)
      detachAll()
      if (refFloaterHandle && refFloaterHandle.teardown) {
        try { refFloaterHandle.teardown() } catch(_) {}
      }
      if (airtapHandle && airtapHandle.teardown) {
        try { airtapHandle.teardown() } catch(_) {}
      }
      if (landmarkCtx) landmarkCtx.clearRect(0, 0, landmarkCanvas.width, landmarkCanvas.height)
      SP.modals.close()
    }

    return { root, recordBtn, runAttempt, teardown }
  }

  SP.practiceUI.buildAttemptUI = buildAttemptUI

  // ── Screen render ────────────────────────────────────────────────────
  function render(signKeyRaw) {
    const host = document.getElementById('sp-screen')
    host.innerHTML = ''

    const app = SP.getApp()
    const ready = SP.isEngineReady()
    if (!ready) {
      host.innerHTML = '<div style="padding:4rem; text-align:center; color:var(--sp-on-surface-variant);">Đang khởi động engine…<br/><small>Camera + MediaPipe đang tải</small></div>'
      return { teardown() {} }
    }

    const signKey = signKeyRaw
    const signData = app.getSignDetailData(signKey)
    if (!signData) {
      host.innerHTML = '<div style="padding:4rem; text-align:center;"><h2>Không tìm thấy dấu</h2><p>' + SP.escapeHTML(signKey) + '</p><a class="sp-btn sp-btn-primary" href="#home">Về trang chủ</a></div>'
      return { teardown() {} }
    }

    const homeData = app.getHomeScreenData()
    const topbar = SP.topbar({
      streak: homeData.streak.current,
      xp: homeData.user.xp,
      level: homeData.user.level,
      rank: homeData.user.rank,
    })
    host.appendChild(topbar)

    // Helpers reused by the result modal AND the air-tap Back/Next buttons.
    function navPrevSignInChapter() {
      const lesson = app.getLessonScreenData(signData.unitId)
      if (!lesson) { location.hash = '#lesson/' + encodeURIComponent(signData.unitId); return }
      const i = lesson.signs.findIndex(s => s.key === signKey)
      const prev = (i > 0) ? lesson.signs[i - 1] : null
      if (prev) location.hash = '#practice/' + encodeURIComponent(prev.key)
      else      location.hash = '#lesson/' + encodeURIComponent(signData.unitId)
    }
    function navNextSignInChapter() {
      const lesson = app.getLessonScreenData(signData.unitId)
      if (!lesson) { location.hash = '#home'; return }
      const i = lesson.signs.findIndex(s => s.key === signKey)
      const next = (i >= 0 && i + 1 < lesson.signs.length) ? lesson.signs[i + 1] : null
      if (next) location.hash = '#practice/' + encodeURIComponent(next.key)
      else      location.hash = '#home'
    }

    const ui = buildAttemptUI(app, {
      signData,
      modalActions: {
        // "Dấu tiếp theo" advances within the current chapter; once
        // every sign has been attempted we drop the user back on the
        // chapter-selection screen (#home) rather than the single
        // chapter detail, per the v0.5 spec.
        onNext: navNextSignInChapter,
        onBack: () => { location.hash = '#lesson/' + encodeURIComponent(signData.unitId) },
      },
      airtapActions: {
        onBack: navPrevSignInChapter,
        onNext: navNextSignInChapter,
      },
    })
    host.appendChild(ui.root)

    return {
      teardown() {
        ui.teardown()
        try { app.engine.clearSign() } catch(_) {}
        if (typeof app.engine.pauseCapture === 'function') {
          app.engine.pauseCapture().catch(e => console.error('[practice] pauseCapture failed:', e))
        }
      }
    }
  }

  function speedBtn(video, rate, label, selected) {
    const btn = SP.h('button', {
      class: 'sp-chip' + (selected ? ' active' : ''),
      onclick: () => {
        if (btn.parentElement) {
          SP.$$('.sp-chip', btn.parentElement).forEach(b => b.classList.remove('active'))
        }
        btn.classList.add('active')
        const v = video.querySelector('video')
        if (v) v.playbackRate = rate
      }
    }, label)
    if (selected) {
      setTimeout(() => {
        const v = video.querySelector('video')
        if (v) v.playbackRate = rate
      }, 100)
    }
    return btn
  }

  SP.screens.practice = { render }
})();
