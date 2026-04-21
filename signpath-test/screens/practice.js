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

    const homeData = app.getHomeScreenData()
    const topbar = SP.topbar({ streak: homeData.streak.current, xp: homeData.user.xp })
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
      background:'rgba(167, 59, 33, 0.78)', color:'#fff', fontSize:'.75rem', fontWeight:600,
    }}, 'Chưa thấy tay')
    practiceWrap.appendChild(handDot)

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
    const refWrap = SP.h('div', { style:{
      background:'rgba(28, 26, 22, 0.82)',
      color:'#fff',
      borderRadius:'.75rem',
      padding:'.5rem .625rem .625rem',
      boxShadow:'0 6px 18px rgba(0,0,0,.38)',
    }},
      SP.h('div', { style:{
        fontSize:'.625rem',
        fontWeight:700, textTransform:'uppercase', letterSpacing:'.5px',
        padding:'.125rem 0 .375rem', opacity:.8,
      }}, 'Video mẫu · Reference'),
      refVideoEl,
      SP.h('div', { style:{ display:'flex', gap:'.25rem', justifyContent:'center', marginTop:'.5rem' }},
        speedBtn(refVideoEl, 0.5, '0.5×'),
        speedBtn(refVideoEl, 0.75, '0.75×', true),
        speedBtn(refVideoEl, 1.0, '1×'),
      ),
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
        hasTemplate ? 'Xem video mẫu rồi nhấn Ghi âm để bắt đầu.'
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
      SP.h('span', {}, 'Ghi âm · Record'),
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
    on('tracking', d => {
      handDot.textContent = d.detected ? '✓ Thấy tay' : 'Chưa thấy tay'
      handDot.style.background = d.detected ? 'rgba(27, 67, 50, 0.78)' : 'rgba(167, 59, 33, 0.78)'

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
      scoreEl.textContent = d.score
      scoreEl.style.color = SP.scoreColor(d.score)
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
      recordBtn.innerHTML = '<span class="material-symbols-outlined filled">fiber_manual_record</span><span>Ghi âm · Record</span>'
      coachTextEl.textContent = d.reason === 'no_signing_detected'
        ? 'Không thấy cử chỉ — hãy đảm bảo tay bạn trong khung hình, rồi thử lại.'
        : 'Đã hủy. Nhấn Ghi âm để thử lại.'
    })
    on('attempt:end', d => {
      progEl.style.width = '100%'
      if (d.advice) coachTextEl.textContent = d.advice
    })
    on('attempt:coach-update', d => {
      if (d.advice) coachTextEl.textContent = d.advice
    })

    async function runAttempt() {
      if (!hasTemplate || app.session.isActive()) return
      try {
        const result = await app.practiceSign(signKey, 4000)
        if (result.aborted) { /* abort handler already updated UI */ return }
        SP.pushRecent(signKey)
        SP.modals.showResult(result, {
          onTryAgain: () => { runAttempt() },
          onNext: () => {
            const lesson = app.getLessonScreenData(signData.unitId)
            if (!lesson) { location.hash = '#home'; return }
            const i = lesson.signs.findIndex(s => s.key === signKey)
            const next = (i >= 0 && i + 1 < lesson.signs.length) ? lesson.signs[i + 1] : null
            if (next) location.hash = '#practice/' + encodeURIComponent(next.key)
            else      location.hash = '#lesson/' + encodeURIComponent(signData.unitId)
          },
          onBack: () => { location.hash = '#lesson/' + encodeURIComponent(signData.unitId) },
        })
      } catch (e) {
        SP.toast('Lỗi: ' + e.message)
        console.error(e)
      } finally {
        recordBtn.disabled = !hasTemplate
        recordBtn.innerHTML = '<span class="material-symbols-outlined filled">fiber_manual_record</span><span>Ghi âm · Record</span>'
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
