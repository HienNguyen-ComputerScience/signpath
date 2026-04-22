/**
 * Practice screen (#practice/:sign). THE critical screen.
 *   Camera fills the main surface; reference video thumbnail is pinned
 *   top-right (~25% width); coach-advice panel sits beneath it, above
 *   the record controls. A transparent <canvas> overlay draws hand +
 *   pose landmarks from every MediaPipe frame.
 * On record, runs a 4s attempt and shows the result modal.
 */
;(function() {
  'use strict'

  const SP = window.SP
  SP.screens = SP.screens || {}

  // Event handler refs (for teardown)
  let activeHandlers = []
  let activeDurationMs = 0

  function on(eventName, handler) {
    const app = SP.getApp()
    app.on(eventName, handler)
    activeHandlers.push([eventName, handler])
  }
  function detachAll() {
    const app = SP.getApp()
    if (!app) return
    for (const [e, h] of activeHandlers) app.off(e, h)
    activeHandlers = []
  }

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

    const hasTemplate = signData.hasTemplate
    app.engine.selectSign(signKey)
    // Defer resumeCapture until after handler wiring (below) so camera /
    // MediaPipe init errors route into the denied-state painter instead of
    // being dropped on the floor before listeners attach.

    const homeData = app.getHomeScreenData()
    const topbar = SP.topbar({
      streak: homeData.streak.current,
      xp: homeData.user.xp,
      level: homeData.user.level,
      rank: homeData.user.rank,
    })
    host.appendChild(topbar)

    // Palm-fallback warning banner — hidden until engine emits
    // 'tracking:degraded'. Auto-hides 5s after last degraded event.
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
    host.appendChild(degradedBanner)

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

    // Webcam feed (mirror of the engine's hidden stream)
    const camVideo = SP.h('video', { autoplay:'', muted:'', playsinline:'',
      style:{
        position:'absolute', inset:0,
        width:'100%', height:'100%',
        objectFit:'cover',
        transform:'scaleX(-1)',
      },
    })
    practiceWrap.appendChild(camVideo)

    // Transparent landmark overlay — draws hand + pose connections every frame.
    // Mirrored in-step with the video so skeleton lines up with the user.
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

    // Stream: mirror engine's hidden <video>.srcObject onto the visible element
    const engineVideo = document.getElementById('sp-engine-video')
    function syncStream() {
      try { camVideo.srcObject = engineVideo.srcObject } catch(_){}
    }
    syncStream()
    const streamPoller = setInterval(() => {
      if (!engineVideo.srcObject) return
      if (camVideo.srcObject !== engineVideo.srcObject) syncStream()
    }, 300)

    // Sign title + back link (top-left overlay)
    const backOverlay = SP.h('div', { style:{
      position:'absolute', top:'1rem', left:'1rem', zIndex:3,
      display:'flex', flexDirection:'column', gap:'.125rem',
      background:'rgba(15, 14, 10, 0.6)',
      color:'#fff', padding:'.5rem .875rem',
      borderRadius:'.625rem',
      maxWidth:'20rem',
    }},
      SP.h('a', { href: '#lesson/' + encodeURIComponent(signData.unitId),
        style:{ color:'rgba(255,255,255,.78)', textDecoration:'none',
          display:'inline-flex', alignItems:'center', gap:'.25rem', fontSize:'.75rem' }},
        SP.h('span', { class:'material-symbols-outlined', style:{ fontSize:'1rem' }}, 'arrow_back'),
        SP.h('span', {}, 'Về chương'),
      ),
      SP.h('div', { style:{ fontSize:'1.125rem', fontWeight:800, lineHeight:1.1 }}, signData.vi),
      SP.h('div', { style:{ fontSize:'.75rem', opacity:.75 }}, signData.en),
    )
    practiceWrap.appendChild(backOverlay)

    // Hand detection indicator (bottom-left)
    const handDot = SP.h('div', { id: 'sp-hand-dot', style:{
      position:'absolute', bottom:'1rem', left:'1rem', zIndex:3,
      padding:'.375rem .75rem', borderRadius:'9999px',
      background:'rgba(99, 95, 86, 0.78)', color:'#fff', fontSize:'.75rem', fontWeight:600,
    }}, 'Chưa thấy tay')
    practiceWrap.appendChild(handDot)

    // ── Framing guide (advisory, does NOT block recording) ────────────
    // Three pre-attempt checks on the live camera feed: face centred,
    // both shoulders visible, and adequate lighting. Green when OK, red
    // with one-line Vietnamese guidance on fail. Updates are driven off
    // the existing 'tracking' event; lighting is sampled every 5 frames
    // via a detached (off-DOM) canvas.
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
    const framingGuide = SP.h('div', { 'aria-label':'Hướng dẫn khung hình',
      style:{
        position:'absolute', top:'1rem', left:'50%', transform:'translateX(-50%)', zIndex:3,
        display:'flex', flexWrap:'wrap', gap:'.375rem', justifyContent:'center',
        pointerEvents:'none',   // advisory only — never intercept record clicks
      }},
      framePillFace, framePillShoulders, framePillLight,
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

    // ── Framing checks (advisory, per-frame or per-5-frame) ───────────
    // Exposed as named helpers so reviewers can locate them quickly.
    // Face-centred: mean (x,y) of face landmarks in image-normalised coords
    // (0..1). Shoulders-visible: reuses engine's SHOULDER_VIS_STRICT threshold
    // via _internals — no duplicated constant. Lighting: mean luminance
    // (Rec. 601 0.299R + 0.587G + 0.114B) sampled off a 64×48 canvas.
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
    // Reusable 64×48 off-DOM canvas for the luminance sample.
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
        // Canvas taint (unlikely with same-origin stream) or transient read
        // failure — leave the pill in its previous state.
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

    // ── Right-column panels: reference thumb / advice / record ──────────
    const rightCol = SP.h('div', { class:'sp-practice-rightcol', style:{
      position:'absolute', top:'1rem', right:'1rem', zIndex:3,
      width:'25%', minWidth:'15rem', maxWidth:'22rem',
      display:'flex', flexDirection:'column', gap:'.625rem',
    }})

    // Reference video thumbnail
    const refVideoEl = SP.videoEl(signKey, { preload:'auto' })
    refVideoEl.style.aspectRatio = '1/1'
    refVideoEl.style.borderRadius = '.5rem'
    refVideoEl.style.overflow = 'hidden'

    // Per-attempt hide/show toggle (in-memory only; resets on every render).
    let refHidden = false
    const eyeIcon = SP.h('span', { class:'material-symbols-outlined', style:{ fontSize:'1.125rem' }}, 'visibility')
    const eyeBtn = SP.h('button', {
      'aria-label': 'Ẩn video mẫu · Hide reference',
      style:{
        background:'transparent', border:'none', cursor:'pointer',
        color:'#fff', padding:'.125rem', marginLeft:'auto',
        display:'inline-flex', alignItems:'center', fontFamily:'inherit',
        opacity:.85,
      },
      onclick: (e) => { e.stopPropagation(); toggleRef() },
    }, eyeIcon)
    const headerText = SP.h('span', {}, 'Video mẫu · Reference')
    const stripText = SP.h('span', { style:{ display:'none', alignItems:'center', gap:'.25rem' }},
      SP.h('span', {}, 'Hiện video mẫu · Show reference'),
      SP.h('span', { class:'material-symbols-outlined', style:{ fontSize:'1rem' }}, 'arrow_forward'),
    )
    const refHeader = SP.h('div', { style:{
      display:'flex', alignItems:'center', gap:'.5rem',
      fontSize:'.625rem',
      fontWeight:700, textTransform:'uppercase', letterSpacing:'.5px',
      padding:'.125rem 0 .375rem', opacity:.8,
      cursor:'default',
    }}, headerText, stripText, eyeBtn)
    const speedRow = SP.h('div', { style:{ display:'flex', gap:'.25rem', justifyContent:'center', marginTop:'.5rem' }},
      speedBtn(refVideoEl, 0.5, '0.5×'),
      speedBtn(refVideoEl, 0.75, '0.75×', true),
      speedBtn(refVideoEl, 1.0, '1×'),
    )
    function toggleRef() {
      refHidden = !refHidden
      if (refHidden) {
        refVideoEl.style.display = 'none'
        speedRow.style.display = 'none'
        headerText.style.display = 'none'
        stripText.style.display = 'inline-flex'
        eyeIcon.textContent = 'visibility_off'
        eyeBtn.setAttribute('aria-label', 'Hiện video mẫu · Show reference')
        refHeader.style.cursor = 'pointer'
      } else {
        refVideoEl.style.display = ''
        speedRow.style.display = 'flex'
        headerText.style.display = ''
        stripText.style.display = 'none'
        eyeIcon.textContent = 'visibility'
        eyeBtn.setAttribute('aria-label', 'Ẩn video mẫu · Hide reference')
        refHeader.style.cursor = 'default'
      }
    }
    refHeader.addEventListener('click', () => { if (refHidden) toggleRef() })
    const refWrap = SP.h('div', { style:{
      background:'rgba(28, 26, 22, 0.82)',
      color:'#fff',
      borderRadius:'.75rem',
      padding:'.5rem .625rem .625rem',
      boxShadow:'0 6px 18px rgba(0,0,0,.38)',
    }},
      refHeader,
      refVideoEl,
      speedRow,
    )

    // Coach advice panel — shows the latest AI feedback text.
    const adviceCard = SP.h('div', { id:'sp-coach-box', style:{
      background:'rgba(28, 26, 22, 0.82)',
      color:'#fff',
      borderLeft:'4px solid var(--sp-primary)',
      borderRadius:'.625rem',
      padding:'.75rem .875rem',
      fontSize:'.8125rem',
      lineHeight:1.45,
      minHeight:'3.5rem',
      boxShadow:'0 6px 18px rgba(0,0,0,.38)',
    }},
      SP.h('div', { style:{
        fontSize:'.625rem', fontWeight:700,
        textTransform:'uppercase', letterSpacing:'.5px',
        marginBottom:'.25rem', opacity:.8,
      }}, 'Lời khuyên AI'),
      SP.h('div', { id:'sp-coach-text' },
        hasTemplate ? 'Xem video mẫu rồi nhấn Quay để bắt đầu.'
                    : 'Dấu này chưa có dữ liệu chấm điểm. Bạn chỉ có thể xem video mẫu.'),
    )

    // Record controls panel
    const progressWrap = SP.h('div', { style:{ flex:1, height:'.375rem', background:'rgba(255,255,255,.16)', borderRadius:'9999px', overflow:'hidden' }},
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
      background:'rgba(28, 26, 22, 0.82)',
      borderRadius:'.625rem',
      padding:'.75rem .875rem',
      display:'flex', flexDirection:'column', gap:'.5rem',
      boxShadow:'0 6px 18px rgba(0,0,0,.38)',
    }},
      recordBtn, progressWrap,
    )

    rightCol.appendChild(refWrap)
    rightCol.appendChild(adviceCard)
    rightCol.appendChild(recordPanel)
    practiceWrap.appendChild(rightCol)
    host.appendChild(practiceWrap)

    // Responsive: on narrow viewports stack the right column BELOW the
    // camera instead of overlaying it. Spec: < 768px → stacked.
    function applyResponsive() {
      const narrow = window.innerWidth < 768
      if (narrow) {
        practiceWrap.style.height = 'auto'
        practiceWrap.style.display = 'flex'
        practiceWrap.style.flexDirection = 'column'
        practiceWrap.style.background = 'transparent'
        rightCol.style.position = 'static'
        rightCol.style.top = ''
        rightCol.style.right = ''
        rightCol.style.width = 'auto'
        rightCol.style.maxWidth = 'none'
        rightCol.style.padding = '.75rem 0 0'
        // Give the camera a fixed aspect so it doesn't collapse to 0 in flex.
        camVideo.style.position = 'relative'
        camVideo.style.height = 'auto'
        camVideo.style.aspectRatio = '4/3'
        landmarkCanvas.style.position = 'absolute'
      } else {
        practiceWrap.style.height = 'calc(100vh - 7rem)'
        practiceWrap.style.display = 'block'
        practiceWrap.style.background = '#000'
        rightCol.style.position = 'absolute'
        rightCol.style.top = '1rem'
        rightCol.style.right = '1rem'
        rightCol.style.width = '25%'
        rightCol.style.maxWidth = '22rem'
        rightCol.style.padding = '0'
        camVideo.style.position = 'absolute'
        camVideo.style.height = '100%'
        camVideo.style.aspectRatio = ''
      }
    }
    applyResponsive()
    window.addEventListener('resize', applyResponsive)

    // ── Event wiring ─────────────────────────────────────────────────
    detachAll()
    const scoreEl = document.getElementById('sp-live-score')
    const coachTextEl = document.getElementById('sp-coach-text')
    const progEl  = document.getElementById('sp-rec-progress')

    // Landmark rendering: fired every MediaPipe frame via 'tracking'.
    let _lightFrameTick = 0
    on('tracking', d => {
      handDot.textContent = d.detected ? '✓ Thấy tay' : 'Chưa thấy tay'
      handDot.style.background = d.detected ? 'rgba(27, 67, 50, 0.78)' : 'rgba(99, 95, 86, 0.78)'

      // Framing-guide updates — advisory only; recording is never blocked.
      const face = checkFaceCentered(d.face)
      setPillState(framePillFace, face.ok ? 'ok' : 'bad', face.tip)
      const shoulders = checkShouldersVisible(d.pose)
      setPillState(framePillShoulders, shoulders.ok ? 'ok' : 'bad', shoulders.tip)
      // Luminance sample: 1-in-5 frames is plenty for an ambient-light hint.
      _lightFrameTick = (_lightFrameTick + 1) % 5
      if (_lightFrameTick === 0) {
        const light = checkLighting(camVideo)
        if (light) setPillState(framePillLight, light.ok ? 'ok' : 'bad', light.tip)
      }

      // Keep canvas sized to the video's native resolution so 0..1
      // normalized landmark coords map pixel-correctly.
      const vw = camVideo.videoWidth, vh = camVideo.videoHeight
      if (vw && vh && (landmarkCanvas.width !== vw || landmarkCanvas.height !== vh)) {
        landmarkCanvas.width = vw
        landmarkCanvas.height = vh
      }
      landmarkCtx.clearRect(0, 0, landmarkCanvas.width, landmarkCanvas.height)
      // Drawing utils aren't loaded → skip; no overlay rather than a crash.
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

    // Camera/MediaPipe init failure (e.g. permission denied or blocked in
    // browser settings). Swap the live surface for a styled explainer so
    // the user isn't staring at a black box. Non-practice routes are
    // unaffected because camera/MediaPipe is no longer acquired at boot.
    let _deniedPainted = false
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
      // Recording makes no sense without a camera.
      recordBtn.disabled = true
    })

    // Palm-fallback warning: shoulders not reliably detected.
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
      // Engine emits raw scores; UI shows inflated. SP.inflateScore is
      // the single source of the +20/clamp mapping (shared.js).
      const display = SP.inflateScore ? SP.inflateScore(d.score) : d.score
      scoreEl.textContent = display
      scoreEl.style.color = SP.scoreColor(display)
    })

    on('attempt:start', d => {
      activeDurationMs = d.durationMs || 4000
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
    // handlers are attached. Camera / MediaPipe init is deferred to this
    // point so non-practice screens never trigger a permission prompt.
    if (typeof app.engine.resumeCapture === 'function') {
      app.engine.resumeCapture().catch(e => console.error('[practice] resumeCapture failed:', e))
    }

    async function runAttempt() {
      if (!hasTemplate || app.session.isActive()) return
      try {
        const result = await app.practiceSign(signKey, 4000)
        if (result.aborted) { /* abort handler already updated UI */ return }
        SP.pushRecent(signKey)
        SP.modals.showResult(result, {
          onTryAgain: () => { runAttempt() },
          onNext: () => {
            // "Dấu tiếp theo" advances within the current chapter; once
            // every sign has been attempted we drop the user back on the
            // chapter-selection screen (#home) rather than the single
            // chapter detail, per the v0.5 spec.
            const lesson = app.getLessonScreenData(signData.unitId)
            if (!lesson) { location.hash = '#home'; return }
            const i = lesson.signs.findIndex(s => s.key === signKey)
            const next = (i >= 0 && i + 1 < lesson.signs.length) ? lesson.signs[i + 1] : null
            if (next) location.hash = '#practice/' + encodeURIComponent(next.key)
            else      location.hash = '#home'
          },
          onBack: () => { location.hash = '#lesson/' + encodeURIComponent(signData.unitId) },
        })
      } catch (e) {
        SP.toast('Lỗi: ' + e.message)
        console.error(e)
      } finally {
        recordBtn.disabled = !hasTemplate
        recordBtn.innerHTML = '<span class="material-symbols-outlined filled">fiber_manual_record</span><span>Quay · Record</span>'
      }
    }

    return {
      teardown() {
        clearInterval(streamPoller)
        if (degradedQuietTimer) clearTimeout(degradedQuietTimer)
        window.removeEventListener('resize', applyResponsive)
        detachAll()
        // Overlay disappears when camera is off — clear the canvas.
        if (landmarkCtx) landmarkCtx.clearRect(0, 0, landmarkCanvas.width, landmarkCanvas.height)
        app.engine.clearSign()
        SP.modals.close()
        // Stop the camera + inference loop. Route guard on the modals
        // handles the race where a pending attempt:end fires after we
        // navigate off the practice route.
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
