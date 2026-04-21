/**
 * Progress / stats screen.
 * Real data only: streak, masteredCount, per-lesson mastery bars, review queue.
 * Removes weekly-activity histogram and total-practice-time — backend doesn't track those.
 */
;(function() {
  'use strict'

  const SP = window.SP
  SP.screens = SP.screens || {}

  function render() {
    const host = document.getElementById('sp-screen')
    host.innerHTML = ''
    const app = SP.getApp()
    if (!SP.isEngineReady()) {
      host.innerHTML = '<div style="padding:4rem; text-align:center; color:var(--sp-on-surface-variant);">Đang khởi động engine…</div>'
      return { teardown() {} }
    }

    const homeData = app.getHomeScreenData()
    const lessons = app.engine.getLessons()
    const topbar = SP.topbar({
      streak: homeData.streak.current, xp: homeData.user.xp,
      level: homeData.user.level, rank: homeData.user.rank,
    })
    host.appendChild(topbar)

    // Header
    host.appendChild(SP.h('section', { style:{ padding:'2rem 3rem 0' }},
      SP.h('h1', { style:{ fontSize:'2.5rem', fontWeight:800, color:'var(--sp-primary)', marginBottom:'.25rem' }}, 'Tiến độ'),
      SP.h('p', { style:{ color:'var(--sp-on-surface-variant)' }}, 'Your learning progress'),
    ))

    // KPI row (3 cards; removed practice-time)
    const kpiRow = SP.h('section', { style:{ padding:'1.5rem 3rem 0', display:'grid',
      gridTemplateColumns:'repeat(auto-fit, minmax(15rem, 1fr))', gap:'1rem', maxWidth:'72rem' }},
      kpiCard('🔥', homeData.streak.current + ' ngày', 'Chuỗi hiện tại', 'Current streak'),
      kpiCard('✨', String(homeData.user.masteredCount), 'Dấu đã thông thạo', 'Signs mastered'),
      kpiCard('⭐', 'Lv ' + homeData.user.level + ' · ' + homeData.user.xp + ' XP',
               'Cấp độ', 'Experience level',
               Math.round(100 * homeData.user.xpIntoLevel / Math.max(1, homeData.user.xpForLevel))),
    )
    host.appendChild(kpiRow)

    // Two columns: mastery bars (left) + due-for-review (right)
    const twoCol = SP.h('section', { style:{
      padding:'2rem 3rem 4rem', display:'grid',
      gridTemplateColumns:'2fr 1fr', gap:'2rem', maxWidth:'72rem',
      alignItems:'start',
    }})

    // ── Mastery per chapter ──
    const lessonBars = []
    for (const l of lessons) {
      const d = app.getLessonScreenData(l.id)
      if (!d || d.totalSigns === 0) continue
      lessonBars.push({
        id: l.id, icon: l.icon, vi: l.goal.vi, en: l.goal.en,
        familiarRatio: d.familiarRatio,
        masteredCount: d.masteredCount,
        familiarCount: d.familiarCount,
        totalSigns: d.totalSigns,
        completed: d.completed, unlocked: d.unlocked,
      })
    }
    // Show all (not just top 5) but ordered by familiarRatio descending
    lessonBars.sort((a, b) => b.familiarRatio - a.familiarRatio)

    const masterySection = SP.h('div', {},
      SP.h('h2', { style:{ fontSize:'1.25rem', fontWeight:700, color:'var(--sp-on-surface)', marginBottom:'1rem' }},
        'Thông thạo theo chương · Chapter mastery'),
      ...lessonBars.map(b => SP.h('div', { class:'sp-card', style:{
        padding:'1rem 1.25rem', marginBottom:'.75rem', cursor:'pointer',
      },
        onclick: () => { location.hash = '#lesson/' + encodeURIComponent(b.id) }
      },
        SP.h('div', { style:{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:'.75rem', marginBottom:'.5rem' }},
          SP.h('div', { style:{ display:'flex', alignItems:'center', gap:'.5rem', minWidth:0 }},
            SP.h('span', { style:{ fontSize:'1.25rem' }}, b.icon),
            SP.h('span', { style:{ fontWeight:700, color:'var(--sp-on-surface)' }}, b.vi),
            b.completed ? SP.h('span', { style:{
              background:'var(--sp-tertiary-fixed)', color:'var(--sp-tertiary)',
              padding:'.125rem .5rem', borderRadius:'9999px', fontSize:'.625rem', fontWeight:700,
            }}, '✓ HOÀN THÀNH') : null,
          ),
          SP.h('div', { style:{ fontSize:'.875rem', color:'var(--sp-on-surface-variant)', whiteSpace:'nowrap' }},
            b.masteredCount + '/' + b.totalSigns + ' · ' + Math.round(b.familiarRatio * 100) + '%'),
        ),
        SP.h('div', { class:'sp-progress' },
          SP.h('div', { class:'sp-progress-fill', style:{ width: Math.max(2, Math.round(b.familiarRatio * 100)) + '%' }})
        ),
      ))
    )

    // ── Due for review ──
    const next = homeData.nextSigns
    const reviewSection = SP.h('div', {},
      SP.h('h2', { style:{ fontSize:'1.25rem', fontWeight:700, color:'var(--sp-on-surface)', marginBottom:'1rem' }},
        'Cần ôn tập · Due for review'),
      SP.h('div', { class:'sp-card', style:{ padding:'1rem 1.25rem' }},
        next.length === 0
          ? SP.h('div', { style:{ color:'var(--sp-on-surface-variant)', fontSize:'.875rem' }},
              'Chưa có gì cần ôn. Tiếp tục luyện tập!')
          : SP.h('div', { style:{ display:'flex', flexDirection:'column', gap:'.5rem' }},
              ...next.slice(0, 10).map(n => SP.h('a', {
                href:'#practice/' + encodeURIComponent(n.signKey),
                style:{
                  display:'flex', alignItems:'center', justifyContent:'space-between',
                  padding:'.625rem .75rem', borderRadius:'.5rem',
                  background:'var(--sp-surface-container-low)',
                  textDecoration:'none', color:'var(--sp-on-surface)',
                  fontSize:'.875rem',
                }
              },
                SP.h('span', { style:{ fontWeight:600 }}, n.signKey),
                SP.h('span', { style:{ fontSize:'.6875rem', color:reasonColor(n.reason), fontWeight:600, textTransform:'uppercase', letterSpacing:'.5px' }},
                  reasonLabel(n.reason)),
              ))
            )
      ),
    )

    twoCol.appendChild(masterySection)
    twoCol.appendChild(reviewSection)
    host.appendChild(twoCol)

    return { teardown() {} }
  }

  function kpiCard(emoji, value, vi, en, fillPct) {
    return SP.h('div', { class:'sp-card', style:{ padding:'1.25rem' }},
      SP.h('div', { style:{ fontSize:'2rem', lineHeight:1, marginBottom:'.5rem' }}, emoji),
      SP.h('div', { style:{ fontSize:'1.875rem', fontWeight:800, color:'var(--sp-primary)', lineHeight:1.1 }}, value),
      SP.h('div', { style:{ fontSize:'.875rem', color:'var(--sp-on-surface)', fontWeight:600, marginTop:'.5rem' }}, vi),
      SP.h('div', { style:{ fontSize:'.75rem', color:'var(--sp-on-surface-variant)' }}, en),
      typeof fillPct === 'number' ? SP.h('div', { class:'sp-progress', style:{ marginTop:'.75rem' }},
        SP.h('div', { class:'sp-progress-fill', style:{ width: Math.max(2, fillPct) + '%' }})) : null,
    )
  }

  function reasonLabel(r) {
    return { due_for_review:'Đến hạn', struggling:'Khó', new:'Mới', maintenance:'Duy trì' }[r] || r
  }
  function reasonColor(r) {
    return { due_for_review:'var(--sp-error)', struggling:'var(--sp-primary)',
             new:'var(--sp-tertiary)', maintenance:'var(--sp-on-surface-variant)' }[r] || 'var(--sp-on-surface-variant)'
  }

  SP.screens.progress = { render }
})();
