/**
 * Lesson detail screen (#lesson/:id).
 * Renders the sign grid in "Luyện tập" (practice) mode and a flashcard
 * deck in "Thẻ ghi nhớ" mode. The mode toggle flips content in place;
 * no route change, no camera init, no scoring.
 */
;(function() {
  'use strict'

  const SP = window.SP
  SP.screens = SP.screens || {}

  function render(lessonId) {
    const host = document.getElementById('sp-screen')
    host.innerHTML = ''

    const app = SP.getApp()

    // Loading state if engine not ready
    if (!SP.isEngineReady()) {
      host.innerHTML = '<div style="padding:4rem; text-align:center; color:var(--sp-on-surface-variant);">Đang khởi động engine…</div>'
      return { teardown() {} }
    }

    const data = app.getLessonScreenData(lessonId)
    if (!data) {
      host.innerHTML = '<div style="padding:4rem; text-align:center;"><h2>Không tìm thấy chương</h2><p>' + SP.escapeHTML(lessonId) + '</p><a class="sp-btn sp-btn-primary" href="#home">Về trang chủ</a></div>'
      return { teardown() {} }
    }

    SP.setLastLesson(lessonId)
    const homeData = app.getHomeScreenData()
    const topbar = SP.topbar({
      streak: homeData.streak.current,
      xp: homeData.user.xp,
      level: homeData.user.level,
      rank: homeData.user.rank,
    })

    // Header
    const header = SP.h('section', { style:{ padding:'2rem 3rem 0' }},
      SP.h('a', { href:'#home', style:{
        color:'var(--sp-on-surface-variant)', textDecoration:'none',
        display:'inline-flex', alignItems:'center', gap:'.25rem', marginBottom:'1rem',
        fontSize:'.875rem',
      }},
        SP.h('span', { class:'material-symbols-outlined', style:{ fontSize:'1.125rem' }}, 'arrow_back'),
        SP.h('span', {}, 'Về trang chủ'),
      ),
      SP.h('div', { style:{ display:'flex', alignItems:'center', gap:'1rem', marginBottom:'.5rem' }},
        SP.h('span', { style:{ fontSize:'3rem' }}, data.icon || '📚'),
        SP.h('div', {},
          SP.h('h1', { style:{ fontSize:'2.5rem', fontWeight:800, color:'var(--sp-primary)', lineHeight:1.1 }}, data.goal.vi),
          SP.h('p', { style:{ fontSize:'1.125rem', color:'var(--sp-on-surface-variant)' }}, data.goal.en),
        ),
      ),
    )

    // Mastery summary
    const pct = data.totalSigns ? Math.round(100 * data.masteredCount / data.totalSigns) : 0
    const progress = SP.h('div', { class:'sp-card', style:{
      maxWidth:'42rem', marginTop:'1.5rem', padding:'1.25rem 1.5rem',
      display:'flex', flexDirection:'column', gap:'.75rem',
    }},
      SP.h('div', { style:{ display:'flex', justifyContent:'space-between', alignItems:'center' }},
        SP.h('div', { style:{ fontSize:'.875rem', color:'var(--sp-on-surface-variant)', fontWeight:600 }},
          'Đã thông thạo ' + data.masteredCount + ' / ' + data.totalSigns + ' dấu'),
        SP.h('div', { style:{ fontSize:'1.25rem', fontWeight:700, color:'var(--sp-primary)' }}, pct + '%'),
      ),
      SP.h('div', { class:'sp-progress' },
        SP.h('div', { class:'sp-progress-fill', style:{ width: Math.max(3, pct) + '%' }})
      ),
      data.completed ? SP.h('div', { style:{ color:'var(--sp-tertiary)', fontWeight:600, fontSize:'.875rem' }},
        '✓ Chương này đã hoàn thành · Chapter complete') : null,
    )
    header.appendChild(progress)

    // ── Mode toggle: Luyện tập (default) vs Thẻ ghi nhớ ────────────────
    // Local state only; flipping does not route, re-fetch data, or touch
    // the camera. Default 'practice' preserves the pre-toggle behaviour.
    let mode = 'practice'
    let flashIndex = 0
    let flashFlipped = false

    const modeBar = SP.h('section', { style:{ padding:'1.25rem 3rem 0' }})
    const toggleWrap = SP.h('div', { role:'tablist', 'aria-label':'Chế độ học',
      style:{
        display:'inline-flex', gap:'.25rem', padding:'.25rem',
        background:'var(--sp-surface-container-low)', borderRadius:'9999px',
      }})
    function modeBtn(key, labelVi, labelEn, icon) {
      const active = mode === key
      const btn = SP.h('button', {
        role:'tab',
        'aria-selected': active ? 'true' : 'false',
        'data-mode': key,
        style:{
          display:'inline-flex', alignItems:'center', gap:'.375rem',
          padding:'.5rem 1rem', borderRadius:'9999px', border:'none',
          cursor:'pointer', fontWeight:600, fontSize:'.875rem',
          fontFamily:'inherit',
          background: active ? 'var(--sp-primary)' : 'transparent',
          color: active ? 'var(--sp-on-primary)' : 'var(--sp-on-surface)',
          transition:'background .15s',
        },
        onclick: () => { if (mode !== key) { mode = key; renderContent(); refreshToggle() } },
      },
        SP.h('span', { class:'material-symbols-outlined', style:{ fontSize:'1.125rem' }}, icon),
        SP.h('span', {}, labelVi),
        SP.h('span', { style:{ opacity:.7, fontWeight:400 }}, '· ' + labelEn),
      )
      return btn
    }
    toggleWrap.appendChild(modeBtn('practice', 'Luyện tập', 'Practice', 'fitness_center'))
    toggleWrap.appendChild(modeBtn('flashcard', 'Thẻ ghi nhớ', 'Flashcards', 'style'))
    modeBar.appendChild(toggleWrap)
    function refreshToggle() {
      Array.from(toggleWrap.querySelectorAll('button[data-mode]')).forEach(b => {
        const active = b.dataset.mode === mode
        b.setAttribute('aria-selected', active ? 'true' : 'false')
        b.style.background = active ? 'var(--sp-primary)' : 'transparent'
        b.style.color = active ? 'var(--sp-on-primary)' : 'var(--sp-on-surface)'
      })
    }

    // Content host — re-rendered on mode toggle without touching header.
    const contentHost = SP.h('section', { style:{ padding:'1.5rem 3rem 4rem' }})

    function renderContent() {
      contentHost.innerHTML = ''
      if (mode === 'flashcard') renderFlashcards()
      else renderSignGrid()
    }

    function renderSignGrid() {
      contentHost.appendChild(SP.h('h2', { style:{ fontSize:'1.25rem', fontWeight:700, color:'var(--sp-on-surface)', marginBottom:'1rem' }},
        data.signs.length + ' dấu trong chương này'))

      if (data.signs.length === 0) {
        contentHost.appendChild(SP.h('div', { style:{ color:'var(--sp-on-surface-variant)', padding:'2rem' }},
          'Không có dấu nào trong chương này (chưa có template). / No signs in this chapter yet.'))
        return
      }
      const grid = SP.h('div', { style:{
        display:'grid',
        gridTemplateColumns:'repeat(auto-fill, minmax(14rem, 1fr))',
        gap:'1.25rem',
      }})
      for (const s of data.signs) grid.appendChild(renderSignCard(s, lessonId, app))
      contentHost.appendChild(grid)
    }

    function renderFlashcards() {
      if (data.signs.length === 0) {
        contentHost.appendChild(SP.h('div', { style:{ color:'var(--sp-on-surface-variant)', padding:'2rem' }},
          'Không có dấu nào trong chương này. / No signs to study.'))
        return
      }
      if (flashIndex >= data.signs.length) flashIndex = 0
      const sign = data.signs[flashIndex]
      const total = data.signs.length

      contentHost.appendChild(SP.h('div', { style:{
        display:'flex', justifyContent:'space-between', alignItems:'center',
        marginBottom:'1rem', maxWidth:'36rem',
      }},
        SP.h('h2', { style:{ fontSize:'1.125rem', fontWeight:700, color:'var(--sp-on-surface)' }},
          'Thẻ ' + (flashIndex + 1) + ' / ' + total),
        SP.h('div', { style:{ fontSize:'.8125rem', color:'var(--sp-on-surface-variant)' }},
          'Nhấn thẻ để lật · Tap to flip'),
      ))

      const card = SP.h('div', {
        role:'button', 'aria-label':'Thẻ ghi nhớ — nhấn để lật',
        tabindex:'0',
        style:{
          maxWidth:'36rem', minHeight:'22rem',
          borderRadius:'var(--sp-r-md)',
          background: flashFlipped ? 'var(--sp-surface-container-low)' : 'var(--sp-primary-container, var(--sp-surface-container-high))',
          color:'var(--sp-on-surface)',
          padding:'2rem', cursor:'pointer',
          display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
          gap:'1rem', textAlign:'center',
          boxShadow:'0 6px 18px rgba(0,0,0,.08)',
          userSelect:'none',
        },
        onclick: () => { flashFlipped = !flashFlipped; renderContent() },
        onkeydown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flashFlipped = !flashFlipped; renderContent() }
        },
      })

      if (!flashFlipped) {
        // FRONT — Vietnamese word, no video, no camera.
        card.appendChild(SP.h('div', {
          style:{ fontSize:'.75rem', fontWeight:700, letterSpacing:'.5px', textTransform:'uppercase',
            color:'var(--sp-on-surface-variant)' }}, 'Dấu · Sign'))
        card.appendChild(SP.h('div', {
          style:{ fontSize:'3rem', fontWeight:800, lineHeight:1.1, color:'var(--sp-primary)' }},
          sign.vi))
        card.appendChild(SP.h('div', {
          style:{ fontSize:'.9375rem', color:'var(--sp-on-surface-variant)', marginTop:'.25rem' }},
          'Nhấn để xem video mẫu · Tap for reference'))
      } else {
        // BACK — reference video + metadata. Uses SP.videoEl (reference-
        // video element only; no live camera, no MediaPipe, no session).
        const video = SP.videoEl(sign.key)
        video.style.width = '100%'
        video.style.maxWidth = '20rem'
        video.style.aspectRatio = '4/3'
        card.appendChild(video)
        card.appendChild(SP.h('div', {
          style:{ fontSize:'1.5rem', fontWeight:700, color:'var(--sp-on-surface)' }}, sign.vi))
        card.appendChild(SP.h('div', {
          style:{ fontSize:'.9375rem', color:'var(--sp-on-surface-variant)' }}, sign.en))
        const metaRow = SP.h('div', {
          style:{ display:'flex', gap:'.75rem', flexWrap:'wrap', justifyContent:'center',
            fontSize:'.75rem', color:'var(--sp-on-surface-variant)', marginTop:'.5rem' }},
          SP.h('span', {}, 'Cấp độ: ' + SP.masteryLabel(sign.mastery)),
          sign.best ? SP.h('span', {}, 'Kỷ lục: ' + (SP.inflateScore ? SP.inflateScore(sign.best) : sign.best) + '%') : null,
          SP.h('span', {}, 'Lượt thử: ' + (sign.attempts || 0)),
        )
        card.appendChild(metaRow)
      }
      contentHost.appendChild(card)

      // Navigation
      const nav = SP.h('div', { style:{
        display:'flex', gap:'.75rem', marginTop:'1.25rem', maxWidth:'36rem',
      }},
        SP.h('button', { class:'sp-btn',
          disabled: flashIndex === 0,
          style:{ flex:1, opacity: flashIndex === 0 ? .5 : 1 },
          onclick: () => { if (flashIndex > 0) { flashIndex--; flashFlipped = false; renderContent() } },
        },
          SP.h('span', { class:'material-symbols-outlined' }, 'arrow_back'),
          SP.h('span', {}, 'Trước · Previous'),
        ),
        SP.h('button', { class:'sp-btn sp-btn-primary',
          disabled: flashIndex >= total - 1,
          style:{ flex:1, opacity: flashIndex >= total - 1 ? .5 : 1 },
          onclick: () => { if (flashIndex < total - 1) { flashIndex++; flashFlipped = false; renderContent() } },
        },
          SP.h('span', {}, 'Tiếp · Next'),
          SP.h('span', { class:'material-symbols-outlined' }, 'arrow_forward'),
        ),
      )
      contentHost.appendChild(nav)
    }

    renderContent()

    host.appendChild(topbar)
    host.appendChild(header)
    host.appendChild(modeBar)
    host.appendChild(contentHost)
    return { teardown() {} }
  }

  function renderSignCard(sign, lessonId, app) {
    const hasTemplate = !!(app.engine.getTemplate && app.engine.getTemplate(sign.key))
    const hasVideo = SP.hasRefVideo(sign.key)
    const video = SP.videoEl(sign.key)
    video.style.aspectRatio = '4/3'

    // Mastery stars
    const starsHtml = SP.starsHTML(sign.mastery, 3)

    // Status badge
    let badge = null
    if (sign.mastery === 3) badge = tag('Thông thạo', 'var(--sp-tertiary)', 'var(--sp-tertiary-fixed)')
    else if (sign.mastery === 2) badge = tag('Quen thuộc', 'var(--sp-primary)', 'var(--sp-surface-container-low)')
    else if (sign.mastery === 1) badge = tag('Đang học', 'var(--sp-on-surface-variant)', 'var(--sp-surface-container-low)')
    else if (!hasTemplate) badge = tag('Chưa có dữ liệu', 'var(--sp-on-surface-variant)', 'var(--sp-surface-container-high)')

    const card = SP.h('div', { class:'sp-card', style:{ padding:'1rem', display:'flex', flexDirection:'column', gap:'.75rem', cursor:'pointer' },
      onclick: () => {
        if (!hasTemplate) {
          SP.toast('Dấu này chưa có dữ liệu chấm điểm. Bạn vẫn có thể xem video mẫu.', 2800)
        }
        location.hash = '#practice/' + encodeURIComponent(sign.key)
      }
    },
      video,
      SP.h('div', {},
        SP.h('div', { style:{ fontSize:'1.125rem', fontWeight:700, color:'var(--sp-on-surface)', lineHeight:1.2 }}, sign.vi),
        SP.h('div', { style:{ fontSize:'.8125rem', color:'var(--sp-on-surface-variant)', marginTop:'.125rem' }}, sign.en),
      ),
      SP.h('div', { style:{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:'.5rem' }},
        SP.h('div', { html: starsHtml }),
        sign.best ? SP.h('div', { style:{ fontSize:'.8125rem', color:'var(--sp-on-surface-variant)' }},
          'Kỷ lục ' + (SP.inflateScore ? SP.inflateScore(sign.best) : sign.best) + '%') : null,
      ),
      badge,
    )
    return card
  }
  function tag(text, color, bg) {
    return SP.h('div', { style:{
      display:'inline-block', alignSelf:'flex-start', padding:'.25rem .625rem',
      borderRadius:'9999px', background: bg, color: color,
      fontSize:'.6875rem', fontWeight:700, letterSpacing:'.25px',
    }}, text)
  }

  SP.screens.lesson = { render }
})();
