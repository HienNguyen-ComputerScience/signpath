/**
 * History screen (#history) — recent practice attempts, one row per attempt.
 *
 * Data source: progression._getRawState().signHistory, the per-sign rolling
 * buffer capped at SIGN_HISTORY_CAP=10 per sign. We flatten across all signs,
 * sort newest-first, and cap the view at 100 rows. This read-only access is
 * the test hook already exposed by progression; no schema mutation.
 *
 * XP is reconstructed from the raw score: signHistory entries don't carry
 * stars or xp fields, so we derive stars from the "high" quality thresholds
 * (50 / 70 / 88) and call xpForAttempt(score, stars). This matches the
 * common case and stays within a handful of points for low-quality templates.
 */
;(function() {
  'use strict'

  const SP = window.SP
  SP.screens = SP.screens || {}

  const MAX_ROWS = 100

  function starsFromRaw(raw) {
    if (raw < 50) return 0
    if (raw < 70) return 1
    if (raw < 88) return 2
    return 3
  }

  function formatDate(ts) {
    const now = Date.now()
    const d = new Date(ts)
    const today = new Date()
    const isToday = d.getFullYear() === today.getFullYear()
                 && d.getMonth()    === today.getMonth()
                 && d.getDate()     === today.getDate()
    if (isToday) {
      const hh = String(d.getHours()).padStart(2, '0')
      const mm = String(d.getMinutes()).padStart(2, '0')
      return 'Hôm nay ' + hh + ':' + mm
    }
    const days = Math.floor((now - ts) / 86400000)
    if (days < 7) return days + ' ngày trước'
    const dd = String(d.getDate()).padStart(2, '0')
    const mo = String(d.getMonth() + 1).padStart(2, '0')
    return dd + '/' + mo
  }

  function render() {
    const host = document.getElementById('sp-screen')
    host.innerHTML = ''

    if (!SP.isEngineReady()) {
      host.innerHTML = '<div style="padding:4rem; text-align:center; color:var(--sp-on-surface-variant);">Đang khởi động engine…</div>'
      return { teardown() {} }
    }

    const app = SP.getApp()
    const homeData = app.getHomeScreenData()
    const topbar = SP.topbar({
      streak: homeData.streak.current, xp: homeData.user.xp,
      level: homeData.user.level, rank: homeData.user.rank,
    })
    host.appendChild(topbar)

    host.appendChild(SP.h('section', { style:{ padding:'2rem 3rem 0' }},
      SP.h('h1', { style:{ fontSize:'2.5rem', fontWeight:800, color:'var(--sp-primary)', marginBottom:'.25rem' }}, 'Lịch sử luyện tập'),
      SP.h('p', { style:{ color:'var(--sp-on-surface-variant)' }}, 'Các lần luyện tập gần đây'),
    ))

    // signKey → { id, vi, icon } lookup for the chapter column.
    const lessons = app.engine.getLessons ? app.engine.getLessons() : []
    const signToLesson = {}
    for (const l of lessons) {
      for (const s of (l.signs || [])) {
        signToLesson[s.key] = { id: l.id, vi: l.goal && l.goal.vi ? l.goal.vi : l.id, icon: l.icon || '' }
      }
    }

    // Flatten signHistory → one row per attempt.
    const state = (app.progression && app.progression._getRawState)
      ? app.progression._getRawState() : { signHistory: {} }
    const signHistory = state.signHistory || {}
    const rows = []
    for (const signKey in signHistory) {
      const list = signHistory[signKey] || []
      for (const h of list) {
        rows.push({ signKey, rawScore: h.score, timestamp: h.timestamp })
      }
    }
    rows.sort((a, b) => b.timestamp - a.timestamp)
    const limited = rows.slice(0, MAX_ROWS)

    if (!limited.length) {
      host.appendChild(SP.h('section', { style:{
        padding:'4rem 3rem', maxWidth:'32rem',
      }},
        SP.h('div', { class:'sp-card', style:{
          padding:'2.5rem 2rem', textAlign:'center',
        }},
          SP.h('div', { style:{ fontSize:'3rem', lineHeight:1, marginBottom:'.75rem' }}, '📒'),
          SP.h('h2', { style:{ fontSize:'1.25rem', fontWeight:700, color:'var(--sp-on-surface)', marginBottom:'.5rem' }},
            'Chưa có lịch sử. Bắt đầu luyện tập!'),
          SP.h('a', { href:'#home', class:'sp-btn sp-btn-primary', style:{ marginTop:'1rem' }},
            SP.h('span', { class:'material-symbols-outlined' }, 'home'),
            SP.h('span', {}, 'Về trang chủ'),
          ),
        ),
      ))
      return { teardown() {} }
    }

    // Table. Five columns; sign cell is a link to #practice/<key>.
    const inflate = SP.inflateScore || function(s) { return Math.max(0, Math.min(100, (s | 0) + 20)) }
    const xpFn = (window.SignPathProgression && window.SignPathProgression._internals
                  && window.SignPathProgression._internals.xpForAttempt)
      || function(score, stars) {
        const mult = [0, 1, 1.5, 2][stars] || 0
        return Math.round(Math.max(0, score - 50) * mult)
      }
    const passGate = SP.PASS_GATE || 50

    const th = (text) => SP.h('th', { style:{
      textAlign:'left', padding:'.625rem .875rem',
      fontSize:'.75rem', fontWeight:700,
      color:'var(--sp-on-surface-variant)',
      textTransform:'uppercase', letterSpacing:'.5px',
      borderBottom:'1px solid var(--sp-outline-variant)',
    }}, text)
    const td = (style, ...children) => SP.h('td', {
      style: Object.assign({ padding:'.75rem .875rem', fontSize:'.9375rem', verticalAlign:'middle' }, style || {})
    }, ...children)

    const table = SP.h('table', { style:{
      width:'100%', borderCollapse:'collapse', maxWidth:'64rem',
    }},
      SP.h('thead', {}, SP.h('tr', {},
        th('Ngày'), th('Dấu'), th('Điểm'), th('XP'), th('Chương'),
      )),
    )
    const tbody = SP.h('tbody', {})
    table.appendChild(tbody)

    for (const r of limited) {
      const inflated = inflate(r.rawScore)
      const stars = starsFromRaw(r.rawScore)
      const xp = xpFn(r.rawScore, stars)
      const passed = inflated >= passGate
      const lesson = signToLesson[r.signKey]
      const scoreColor = passed ? 'var(--sp-tertiary)' : 'var(--sp-error)'

      const signLink = SP.h('a', {
        href: '#practice/' + encodeURIComponent(r.signKey),
        style:{ color:'var(--sp-on-surface)', fontWeight:600, textDecoration:'none' },
      }, r.signKey)

      tbody.appendChild(SP.h('tr', {
        style:{ borderBottom:'1px solid var(--sp-outline-variant)' },
      },
        td({ color:'var(--sp-on-surface-variant)', whiteSpace:'nowrap' }, formatDate(r.timestamp)),
        td({}, signLink),
        td({ fontWeight:700, color: scoreColor }, String(inflated)),
        td({ color:'var(--sp-on-surface-variant)' }, xp > 0 ? '+' + xp : '—'),
        td({ color:'var(--sp-on-surface-variant)' },
          lesson
            ? (lesson.icon ? lesson.icon + ' ' : '') + lesson.vi
            : '—'),
      ))
    }

    const section = SP.h('section', { style:{ padding:'2rem 3rem 4rem' }})
    section.appendChild(SP.h('div', { style:{
      marginBottom:'1rem', color:'var(--sp-on-surface-variant)',
      fontSize:'.875rem', fontWeight:600,
    }},
      limited.length < rows.length
        ? 'Hiển thị ' + limited.length + ' / ' + rows.length + ' lần luyện tập'
        : limited.length + ' lần luyện tập'))
    section.appendChild(SP.h('div', { class:'sp-card', style:{ padding:'.5rem .25rem', overflowX:'auto' }}, table))
    host.appendChild(section)

    return { teardown() {} }
  }

  SP.screens.history = { render }
})();
