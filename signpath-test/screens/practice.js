/**
 * Practice screen (#practice/:sign). THE critical screen.
 *   Left column:  looping reference video + sign name + how-to steps.
 *   Right column: webcam (mirror of engine's video stream) + live score + record button.
 * On record, runs 4s attempt, then shows result modal.
 */
;(function() {
  'use strict'

  const SP = window.SP
  SP.screens = SP.screens || {}

  // Event handler refs (for teardown)
  let activeHandlers = []
  let activeDurationMs = 0
  let lastLiveScore = '—'

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

    // Back link row
    host.appendChild(SP.h('div', { style:{ padding:'1rem 2rem 0' }},
      SP.h('a', { href: '#lesson/' + encodeURIComponent(signData.unitId),
                  style:{ color:'var(--sp-on-surface-variant)', textDecoration:'none',
                          display:'inline-flex', alignItems:'center', gap:'.25rem', fontSize:'.875rem' }},
        SP.h('span', { class:'material-symbols-outlined', style:{ fontSize:'1.125rem' }}, 'arrow_back'),
        SP.h('span', {}, 'Về chương: ' + (signData.unitGoal && signData.unitGoal.vi || '')),
      ),
    ))

    // [Fix 4] Palm-fallback warning banner — hidden until engine emits
    // 'tracking:degraded' (palm-fallback rate > 20% = shoulders not reliably
    // detected, so scoring will be unreliable). Auto-hides after 5 seconds of
    // no new degraded events. Does NOT block the user from recording —
    // they can still attempt if they choose.
    const degradedBanner = SP.h('div', { id: 'sp-degraded-banner', style:{
      display: 'none',
      margin: '.75rem 2rem 0',
      padding: '.875rem 1.25rem',
      background: 'var(--sp-tertiary-container)',
      color: 'var(--sp-on-tertiary-container)',
      borderRadius: '.75rem',
      fontSize: '.875rem', fontWeight: 500,
      alignItems: 'flex-start', gap: '.75rem',
    }},
      SP.h('span', { class:'material-symbols-outlined', style:{ fontSize:'1.25rem', flexShrink:0 }}, 'warning'),
      SP.h('div', { style:{ flex:1, lineHeight:1.45 }},
        SP.h('div', { style:{ fontWeight:700 }}, 'Khung hình chưa đủ'),
        SP.h('div', {}, 'Lùi ra xa camera hoặc bật thêm ánh sáng · Step back from the camera or improve lighting'),
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

    // Two-column layout
    const layout = SP.h('div', { style:{
      display:'grid', gridTemplateColumns:'2fr 3fr',
      gap:'1.5rem', padding:'1rem 2rem 4rem',
      maxWidth:'78rem',
    }})

    // ── Left column: reference ─────────────────────────────
    const refVideoEl = SP.videoEl(signKey, { preload: 'auto' })
    refVideoEl.style.aspectRatio = '1/1'
    refVideoEl.style.maxHeight = '28rem'
    const speedRow = SP.h('div', { style:{ display:'flex', gap:'.5rem', alignItems:'center', marginTop:'.75rem' }},
      SP.h('span', { style:{ fontSize:'.75rem', color:'var(--sp-on-surface-variant)', marginRight:'.25rem' }}, 'Tốc độ:'),
      speedBtn(refVideoEl, 0.5, '0.5×'),
      speedBtn(refVideoEl, 0.75, '0.75×', true),
      speedBtn(refVideoEl, 1.0, '1×'),
    )

    const leftCol = SP.h('div', {},
      SP.h('div', { class:'sp-card', style:{ padding:'1.25rem' }},
        SP.h('div', { style:{ fontSize:'.75rem', color:'var(--sp-on-surface-variant)', fontWeight:600, textTransform:'uppercase', letterSpacing:'.5px', marginBottom:'.5rem' }},
          'Video mẫu · Reference'),
        refVideoEl,
        speedRow,
      ),
      SP.h('div', { style:{ marginTop:'1rem', padding:'1rem 1.25rem' }},
        SP.h('h1', { style:{ fontSize:'2.25rem', fontWeight:800, color:'var(--sp-primary)', lineHeight:1.1, marginBottom:'.25rem' }}, signData.vi),
        SP.h('p', { style:{ fontSize:'1.125rem', color:'var(--sp-on-surface-variant)', marginBottom:'1rem' }}, signData.en),
        SP.h('div', { style:{ display:'flex', gap:'.75rem', alignItems:'center', marginBottom:'1rem' }},
          SP.h('div', { html: SP.starsHTML(signData.mastery, 3), style:{ fontSize:'1.25rem' }}),
          SP.h('div', { style:{ fontSize:'.875rem', color:'var(--sp-on-surface-variant)' }},
            SP.masteryLabel(signData.mastery) + ' · ' + signData.attempts + ' lần thử'),
        ),
        SP.h('div', { style:{ padding:'.875rem 1rem', background:'var(--sp-surface-container-low)', borderRadius:'.75rem', fontSize:'.875rem', color:'var(--sp-on-surface-variant)', lineHeight:1.5 }},
          SP.h('div', { style:{ fontWeight:700, color:'var(--sp-on-surface)', marginBottom:'.25rem' }}, 'Cách thực hiện'),
          '1. Xem video mẫu vài lần để nắm chuyển động.', SP.h('br',{}),
          '2. Nhấn "Ghi âm" và thực hiện dấu trước camera.', SP.h('br',{}),
          '3. Giữ tay ở trung tâm khung hình, chiếu sáng đầy đủ.',
        ),
      ),
    )

    // ── Right column: webcam + score + record ──────────────
    // Mirror the engine's hidden <video>.srcObject onto a visible element.
    const camWrap = SP.h('div', { style:{
      position:'relative', background:'#000', borderRadius:'var(--sp-r-md)',
      aspectRatio:'4/3', overflow:'hidden', width:'100%',
    }})
    const camVideo = SP.h('video', { autoplay: '', muted:'', playsinline:'',
      style:{ width:'100%', height:'100%', objectFit:'cover', transform:'scaleX(-1)' }})
    camWrap.appendChild(camVideo)
    // Copy stream from the engine's hidden element
    const engineVideo = document.getElementById('sp-engine-video')
    function syncStream() {
      try { camVideo.srcObject = engineVideo.srcObject } catch(_){}
    }
    syncStream()
    // If not yet attached, poll briefly
    const streamPoller = setInterval(() => {
      if (!engineVideo.srcObject) return
      if (camVideo.srcObject !== engineVideo.srcObject) syncStream()
    }, 300)

    // Hand detection indicator
    const handDot = SP.h('div', { id: 'sp-hand-dot', style:{
      position:'absolute', bottom:'.75rem', left:'.75rem',
      padding:'.375rem .75rem', borderRadius:'9999px',
      background:'rgba(167, 59, 33, 0.78)', color:'#fff', fontSize:'.75rem', fontWeight:600,
      backdropFilter:'blur(4px)',
    }}, 'Chưa thấy tay')
    camWrap.appendChild(handDot)

    // Live score overlay
    const scoreOverlay = SP.h('div', { style:{
      position:'absolute', top:'.75rem', right:'.75rem',
      background:'rgba(15, 14, 10, 0.68)', color:'#fff',
      padding:'.625rem 1rem', borderRadius:'.75rem',
      backdropFilter:'blur(8px)', textAlign:'center', minWidth:'5rem',
    }},
      SP.h('div', { id:'sp-live-score', style:{ fontSize:'1.75rem', fontWeight:800, lineHeight:1 }}, '—'),
      SP.h('div', { style:{ fontSize:'.625rem', letterSpacing:'.5px', textTransform:'uppercase', opacity:.8 }}, 'Điểm thử'),
    )
    camWrap.appendChild(scoreOverlay)

    // Permanent framing reminder — always visible below the webcam.
    // Tells users to position themselves so their full body is in frame.
    const framingHint = SP.h('div', { id:'sp-framing-hint',
      style:{
        marginTop:'.5rem',
        padding:'.5rem .75rem',
        textAlign:'center',
        fontSize:'.875rem',
        color:'var(--sp-on-surface-variant)',
        lineHeight:1.45,
        background:'var(--sp-surface-container-low)',
        borderRadius:'.5rem',
      }},
      SP.h('div', {}, '📏 Đứng xa camera để thấy toàn thân'),
      SP.h('div', { style:{ fontSize:'.75rem', opacity:.85, marginTop:'.125rem' }},
        'Stand back so your whole body is visible'),
    )

    // Record controls
    const progressWrap = SP.h('div', { style:{ flex:1, height:'.5rem', background:'var(--sp-surface-container-high)', borderRadius:'9999px', overflow:'hidden' }},
      SP.h('div', { id:'sp-rec-progress', style:{ height:'100%', width:'0%', background:'linear-gradient(90deg, #954b00 0%, #f68a2f 100%)', transition:'width 100ms linear' }})
    )
    const recordBtn = SP.h('button', { id:'sp-record-btn', class:'sp-btn sp-btn-primary sp-btn-lg',
      disabled: !hasTemplate,
      onclick: runAttempt,
    },
      SP.h('span', { class:'material-symbols-outlined filled' }, 'fiber_manual_record'),
      SP.h('span', {}, 'Ghi âm · Record'),
    )
    const recordRow = SP.h('div', { style:{ marginTop:'1rem', display:'flex', gap:'1rem', alignItems:'center' }},
      recordBtn, progressWrap,
    )

    // Coach / feedback box
    const coachBox = SP.h('div', { id:'sp-coach-box', style:{
      marginTop:'1rem', padding:'.875rem 1rem',
      background:'var(--sp-surface-container-low)',
      borderLeft:'4px solid var(--sp-primary)', borderRadius:'.5rem',
      color:'var(--sp-on-surface)', fontSize:'.9375rem', minHeight:'3rem',
    }}, hasTemplate ? 'Xem video mẫu, sau đó nhấn Ghi âm.'
                    : 'Dấu này chưa có dữ liệu chấm điểm. Bạn chỉ có thể xem video mẫu.')

    // Warning banner for phantom signs
    const phantomBanner = !hasTemplate ? SP.h('div', { style:{
      padding:'.75rem 1rem', marginTop:'1rem',
      background:'var(--sp-error-container)', color:'var(--sp-on-error)',
      borderRadius:'.75rem', fontSize:'.875rem', fontWeight:500,
    }}, '⚠ Dấu này chưa có dữ liệu chấm điểm. Chỉ xem video mẫu để học.') : null

    const rightCol = SP.h('div', {},
      SP.h('div', { class:'sp-card', style:{ padding:'1.25rem' }},
        SP.h('div', { style:{ fontSize:'.75rem', color:'var(--sp-on-surface-variant)', fontWeight:600, textTransform:'uppercase', letterSpacing:'.5px', marginBottom:'.5rem' }},
          'Camera của bạn · Your camera'),
        camWrap,
        framingHint,
        recordRow,
        coachBox,
        phantomBanner,
      ),
    )

    layout.appendChild(leftCol)
    layout.appendChild(rightCol)
    host.appendChild(layout)

    // ── Event wiring ─────────────────────────────────────
    detachAll()
    const scoreEl = document.getElementById('sp-live-score')
    const coachEl = document.getElementById('sp-coach-box')
    const progEl  = document.getElementById('sp-rec-progress')

    on('tracking', d => {
      handDot.textContent = d.detected ? '✓ Thấy tay' : 'Chưa thấy tay'
      handDot.style.background = d.detected ? 'rgba(27, 67, 50, 0.78)' : 'rgba(167, 59, 33, 0.78)'
    })

    // [Fix 4] Palm-fallback warning (shoulders not reliably detected).
    // Show on first event; reset a 5-second quiet timer on every re-emit;
    // auto-hide once 5 consecutive seconds pass without a new event.
    // Manually-dismissed → stays dismissed for this screen instance.
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
      coachEl.textContent = '🎥 Thực hiện dấu ngay — Signing now…'
    })
    on('attempt:tick', d => {
      const pct = Math.max(0, Math.min(100, 100 * d.elapsedMs / (activeDurationMs || 1)))
      progEl.style.width = pct + '%'
    })
    on('attempt:abort', d => {
      progEl.style.width = '0%'
      recordBtn.disabled = !hasTemplate
      recordBtn.innerHTML = '<span class="material-symbols-outlined filled">fiber_manual_record</span><span>Ghi âm · Record</span>'
      coachEl.textContent = d.reason === 'no_signing_detected'
        ? 'Không thấy cử chỉ — hãy đảm bảo tay bạn trong khung hình, rồi thử lại.'
        : 'Đã hủy. Nhấn Ghi âm để thử lại.'
    })
    on('attempt:end', d => {
      progEl.style.width = '100%'
    })

    async function runAttempt() {
      if (!hasTemplate || app.session.isActive()) return
      try {
        const result = await app.practiceSign(signKey, 4000)
        if (result.aborted) { /* abort handler already updated UI */ return }
        // Push to recent practice list
        SP.pushRecent(signKey)
        // Show result modal
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
        detachAll()
        app.engine.clearSign()
        SP.modals.close()
      }
    }
  }

  function speedBtn(video, rate, label, selected) {
    const btn = SP.h('button', {
      class: 'sp-chip' + (selected ? ' active' : ''),
      onclick: () => {
        // Reset all siblings
        if (btn.parentElement) {
          SP.$$('.sp-chip', btn.parentElement).forEach(b => b.classList.remove('active'))
        }
        btn.classList.add('active')
        const v = video.querySelector('video')
        if (v) v.playbackRate = rate
      }
    }, label)
    if (selected) {
      // Apply default speed immediately once video is in DOM
      setTimeout(() => {
        const v = video.querySelector('video')
        if (v) v.playbackRate = rate
      }, 100)
    }
    return btn
  }

  SP.screens.practice = { render }
})();
