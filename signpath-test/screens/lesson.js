/**
 * Lesson detail screen (#lesson/:id).
 * Shows a grid of signs in the selected lesson with mastery indicators.
 * Each card links to #practice/:signKey.
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
    const topbar = SP.topbar({ streak: homeData.streak.current, xp: homeData.user.xp })

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

    // Sign grid
    const gridSection = SP.h('section', { style:{ padding:'2rem 3rem 4rem' }})
    gridSection.appendChild(SP.h('h2', { style:{ fontSize:'1.25rem', fontWeight:700, color:'var(--sp-on-surface)', marginBottom:'1rem' }},
      data.signs.length + ' dấu trong chương này'))

    if (data.signs.length === 0) {
      gridSection.appendChild(SP.h('div', { style:{ color:'var(--sp-on-surface-variant)', padding:'2rem' }},
        'Không có dấu nào trong chương này (chưa có template). / No signs in this chapter yet.'))
    } else {
      const grid = SP.h('div', { style:{
        display:'grid',
        gridTemplateColumns:'repeat(auto-fill, minmax(14rem, 1fr))',
        gap:'1.25rem',
      }})
      for (const s of data.signs) grid.appendChild(renderSignCard(s, lessonId, app))
      gridSection.appendChild(grid)
    }

    host.appendChild(topbar)
    host.appendChild(header)
    host.appendChild(gridSection)
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
