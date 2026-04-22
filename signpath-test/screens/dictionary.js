/**
 * Sign dictionary — browse all 400 signs.
 * Category chips, search (diacritic-insensitive), paginated card grid.
 */
;(function() {
  'use strict'

  const SP = window.SP
  SP.screens = SP.screens || {}

  const PAGE_SIZE = 12
  let state = null

  function render() {
    const host = document.getElementById('sp-screen')
    host.innerHTML = ''

    const app = SP.getApp()
    if (!SP.isEngineReady()) {
      host.innerHTML = '<div style="padding:4rem; text-align:center; color:var(--sp-on-surface-variant);">Đang khởi động engine…</div>'
      return { teardown() {} }
    }

    const lessons = app.engine.getLessons()
    // Flatten all signs with their category attached for filtering.
    const allSigns = []
    for (const l of lessons) {
      for (const s of (l.signs || [])) allSigns.push({ ...s, categoryId: l.id, categoryVi: l.goal.vi, categoryEn: l.goal.en, icon: l.icon })
    }

    const homeData = app.getHomeScreenData()

    state = {
      category: 'all',
      query: '',
      visible: PAGE_SIZE,
      filtered: allSigns,
      allSigns, lessons, app,
    }

    const topbar = SP.topbar({
      streak: homeData.streak.current, xp: homeData.user.xp,
      level: homeData.user.level, rank: homeData.user.rank,
    })
    host.appendChild(topbar)

    // Header
    host.appendChild(SP.h('section', { style:{ padding:'2rem 3rem 0' }},
      SP.h('h1', { style:{ fontSize:'2.5rem', fontWeight:800, color:'var(--sp-primary)', marginBottom:'.25rem' }}, 'Từ điển'),
      SP.h('p', { style:{ color:'var(--sp-on-surface-variant)' }},
        allSigns.length + ' dấu trong bộ dữ liệu VSL400 · Sign dictionary'),
    ))

    // Search
    const searchInput = SP.h('input', {
      class:'sp-input', type:'search', placeholder:'Tìm kiếm dấu… / Search signs',
      oninput: (e) => { state.query = e.target.value; state.visible = PAGE_SIZE; applyFilter(); }
    })
    host.appendChild(SP.h('section', { style:{ padding:'1rem 3rem 0' }},
      SP.h('div', { style:{ maxWidth:'36rem', position:'relative' }},
        SP.h('span', { class:'material-symbols-outlined',
          style:{ position:'absolute', left:'1rem', top:'50%', transform:'translateY(-50%)', color:'var(--sp-on-surface-variant)', pointerEvents:'none' }}, 'search'),
        (() => { searchInput.style.paddingLeft = '3rem'; return searchInput })(),
      ),
    ))

    // Category chips (main + sidebar split: main for "all" + recent/popular; full list wraps)
    const chipsRow = SP.h('div', { style:{ display:'flex', flexWrap:'wrap', gap:'.5rem', padding:'1rem 3rem 0' }})
    const chipAll = chipButton('all', 'Tất cả', '🔖', true)
    chipsRow.appendChild(chipAll)
    for (const l of lessons) chipsRow.appendChild(chipButton(l.id, l.goal.vi, l.icon, false))
    host.appendChild(chipsRow)

    // Grid fills the full-width surface now that the recently-practiced
    // sidebar has moved to the dedicated History page.
    const gridSection = SP.h('section', { style:{ padding:'2rem 3rem 4rem' }})
    const gridHeader = SP.h('div', { id:'sp-dict-header', style:{ marginBottom:'1rem', color:'var(--sp-on-surface-variant)', fontSize:'.875rem', fontWeight:600 }},
      'Hiển thị tất cả ' + allSigns.length + ' dấu')
    const grid = SP.h('div', { id:'sp-dict-grid', style:{
      display:'grid',
      gridTemplateColumns:'repeat(auto-fill, minmax(12rem, 1fr))',
      gap:'1rem',
    }})
    const loadMoreBtn = SP.h('button', { id:'sp-dict-more', class:'sp-btn sp-btn-secondary',
      style:{ marginTop:'2rem', display:'none' },
      onclick: () => { state.visible += PAGE_SIZE; applyFilter() }
    }, 'Tải thêm · Load more')

    gridSection.appendChild(gridHeader)
    gridSection.appendChild(grid)
    gridSection.appendChild(loadMoreBtn)

    host.appendChild(gridSection)

    applyFilter()

    // Chip click handler
    function chipButton(id, label, icon, selected) {
      return SP.h('button', {
        class: 'sp-chip' + (selected ? ' active' : ''),
        'data-cat': id,
        onclick: (e) => {
          SP.$$('.sp-chip', chipsRow).forEach(c => c.classList.remove('active'))
          e.currentTarget.classList.add('active')
          state.category = id
          state.visible = PAGE_SIZE
          applyFilter()
        }
      },
        SP.h('span', { style:{ fontSize:'1rem' }}, icon || ''),
        SP.h('span', {}, label),
      )
    }

    return { teardown() { state = null } }
  }

  function applyFilter() {
    if (!state) return
    const q = SP.deburr(state.query.trim())
    let pool = state.allSigns
    if (state.category !== 'all') pool = pool.filter(s => s.categoryId === state.category)
    if (q) pool = pool.filter(s => SP.deburr(s.vi).includes(q) || SP.deburr(s.en).includes(q))
    state.filtered = pool

    const headerEl = document.getElementById('sp-dict-header')
    const gridEl = document.getElementById('sp-dict-grid')
    const moreBtn = document.getElementById('sp-dict-more')
    if (!headerEl || !gridEl) return

    const shown = Math.min(state.visible, pool.length)
    headerEl.textContent = pool.length === 0
      ? 'Không tìm thấy dấu nào'
      : `Hiển thị ${shown} / ${pool.length} dấu`

    gridEl.innerHTML = ''
    if (pool.length === 0) {
      gridEl.appendChild(SP.h('div', { style:{
        gridColumn:'1 / -1', padding:'3rem', textAlign:'center', color:'var(--sp-on-surface-variant)',
      }}, 'Thử từ khóa khác hoặc chọn chương khác.'))
    } else {
      for (let i = 0; i < shown; i++) gridEl.appendChild(renderCard(pool[i]))
    }
    moreBtn.style.display = shown < pool.length ? '' : 'none'
  }

  function renderCard(sign) {
    const app = state.app
    const d = app.getSignDetailData(sign.key)
    const hasTpl = d && d.hasTemplate
    const mastery = d ? d.mastery : 0

    const videoEl = SP.videoEl(sign.key)
    videoEl.style.aspectRatio = '4/3'

    const masteryTag = mastery === 3 ? tag('Thông thạo', 'var(--sp-tertiary)', 'var(--sp-tertiary-fixed)')
                    : mastery === 2 ? tag('Quen thuộc', 'var(--sp-primary)', 'var(--sp-surface-container-low)')
                    : mastery === 1 ? tag('Đang học', 'var(--sp-on-surface-variant)', 'var(--sp-surface-container-low)')
                    : tag('Mới', 'var(--sp-on-surface-variant)', 'var(--sp-surface-container-high)')

    const card = SP.h('div', {
      class:'sp-card', style:{ padding:'.75rem', cursor:'pointer', display:'flex', flexDirection:'column', gap:'.5rem' },
      onclick: () => {
        if (!hasTpl) SP.toast('Dấu này chưa có dữ liệu chấm điểm', 2000)
        location.hash = '#practice/' + encodeURIComponent(sign.key)
      }
    },
      videoEl,
      SP.h('div', {},
        SP.h('div', { style:{ fontSize:'1rem', fontWeight:700, color:'var(--sp-on-surface)', lineHeight:1.2 }}, sign.vi),
        SP.h('div', { style:{ fontSize:'.75rem', color:'var(--sp-on-surface-variant)' }}, sign.en),
      ),
      SP.h('div', { style:{ display:'flex', justifyContent:'space-between', alignItems:'center', marginTop:'auto' }},
        masteryTag,
        SP.h('div', { style:{ fontSize:'.6875rem', color:'var(--sp-on-surface-variant)' }}, sign.icon || ''),
      )
    )
    return card
  }

  function tag(text, color, bg) {
    return SP.h('div', { style:{
      display:'inline-block', padding:'.125rem .5rem',
      borderRadius:'9999px', background:bg, color:color,
      fontSize:'.625rem', fontWeight:700, letterSpacing:'.25px',
    }}, text)
  }

  SP.screens.dictionary = { render }
})();
