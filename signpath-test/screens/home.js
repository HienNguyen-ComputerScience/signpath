/**
 * Home / Journey screen.
 * Renders real data from app.getHomeScreenData() + engine.getLessons().
 * 25 lessons, laid out in rows of 6 (desktop).
 */
;(function() {
  'use strict'

  const SP = window.SP
  SP.screens = SP.screens || {}

  function render() {
    const host = document.getElementById('sp-screen')
    host.innerHTML = ''

    const app = SP.getApp()

    // If engine not ready yet, render a loading state but keep the screen structure.
    const ready = SP.isEngineReady()
    const data = ready ? app.getHomeScreenData() : null
    const lessons = ready ? app.engine.getLessons() : []

    const topbar = SP.topbar({
      streak: data ? data.streak.current : 0,
      xp: data ? data.user.xp : 0,
      level: data ? data.user.level : null,
      rank: data ? data.user.rank : null,
    })

    const hero = SP.h('section', { style:{ padding:'2rem 3rem 0' }},
      SP.h('h1', { style:{ fontSize:'3rem', fontWeight:800, color:'var(--sp-primary)', marginBottom:'.5rem', lineHeight:1.1, fontFamily:'inherit' }},
        'Hành trình của bạn'),
      SP.h('p', { style:{ fontSize:'1.125rem', color:'var(--sp-on-surface-variant)', maxWidth:'42rem' }},
        'Học ngôn ngữ ký hiệu Việt Nam với phản hồi AI thời gian thực'),
    )

    // Progress summary strip
    if (data) {
      const completedCount = data.completedLessons.length
      const totalChapters = lessons.length
      const strip = SP.h('div', { style:{
        marginTop:'2rem', display:'flex', gap:'2.5rem',
        padding:'1.25rem 1.75rem',
        background:'var(--sp-surface-container-low)',
        borderRadius:'var(--sp-r-md)',
        width:'fit-content', alignItems:'center',
      }},
        stat('Đã học', data.user.masteredCount + ' dấu'),
        divider(),
        stat('Hoàn thành', completedCount + '/' + totalChapters + ' chương'),
        divider(),
        stat('Chuỗi ngày', String(data.streak.current)),
        divider(),
        stat('XP', String(data.user.xp)),
        divider(),
        stat('Cấp độ', 'Lv ' + data.user.level),
      )
      hero.appendChild(strip)
    } else {
      hero.appendChild(SP.h('div', { style:{
        marginTop:'2rem', padding:'1rem 1.5rem',
        background:'var(--sp-surface-container-low)',
        borderRadius:'var(--sp-r-md)', width:'fit-content',
        color:'var(--sp-on-surface-variant)',
      }}, 'Đang khởi động engine…'))
    }

    function stat(label, value) {
      return SP.h('div', { style:{ display:'flex', flexDirection:'column' }},
        SP.h('span', { style:{ fontSize:'.75rem', color:'var(--sp-on-surface-variant)', fontWeight:600, textTransform:'uppercase', letterSpacing:'.5px' }}, label),
        SP.h('span', { style:{ fontSize:'1.5rem', fontWeight:700, color:'var(--sp-primary)' }}, value),
      )
    }
    function divider() {
      return SP.h('div', { style:{ width:'1px', height:'2.5rem', background:'var(--sp-outline-variant)', opacity:.3 }})
    }

    // "Continue from last time" card (only if lastLesson was stored)
    const lastLesson = SP.getLastLesson()
    const lastLessonData = ready && lastLesson ? app.getLessonScreenData(lastLesson) : null
    let continueCard = null
    if (lastLessonData) {
      // Find a sign in this lesson with the most attempts (most recent "current sign")
      const recent = SP.getRecent()
      const lessonSignKeys = new Set(lastLessonData.signs.map(s => s.key))
      const recentInLesson = recent.find(r => lessonSignKeys.has(r.key))
      const currentSignKey = (recentInLesson && recentInLesson.key) || (lastLessonData.signs[0] && lastLessonData.signs[0].key)

      const videoEl = currentSignKey ? SP.videoEl(currentSignKey) : null
      if (videoEl) { videoEl.style.width = '9rem'; videoEl.style.height = '9rem'; videoEl.style.flexShrink = '0' }

      continueCard = SP.h('section', { style:{ padding:'2rem 3rem 0' }},
        SP.h('div', { class:'sp-card', style:{
          display:'flex', alignItems:'center', justifyContent:'space-between', gap:'2rem',
          maxWidth:'56rem', cursor:'pointer',
        },
          onclick: () => { location.hash = '#lesson/' + encodeURIComponent(lastLesson) }
        },
          SP.h('div', { style:{ display:'flex', alignItems:'center', gap:'1.5rem', flex:'1', minWidth:0 }},
            videoEl,
            SP.h('div', {},
              SP.h('div', { style:{ fontSize:'.75rem', color:'var(--sp-on-surface-variant)', fontWeight:600, textTransform:'uppercase', letterSpacing:'.5px' }}, 'Tiếp tục từ lần trước'),
              SP.h('div', { style:{ fontSize:'1.75rem', fontWeight:700, color:'var(--sp-on-surface)', marginTop:'.25rem' }},
                (lastLessonData.icon || '') + ' ' + lastLessonData.goal.vi),
              currentSignKey ? SP.h('div', { style:{ fontSize:'1rem', color:'var(--sp-on-surface-variant)', marginTop:'.25rem' }},
                'Dấu đang học: "' + currentSignKey + '"') : null,
            ),
          ),
          SP.h('button', { class:'sp-btn sp-btn-primary' },
            SP.h('span', {}, 'Tiếp tục'),
            SP.h('span', { class:'material-symbols-outlined filled' }, 'play_arrow'),
          )
        )
      )
    }

    // Lesson path
    const pathSection = SP.h('section', { style:{ padding:'3rem 3rem 4rem' }},
      SP.h('h2', { style:{ fontSize:'1.5rem', fontWeight:700, color:'var(--sp-on-surface)', marginBottom:'1.5rem' }},
        '25 chương học · 25 chapters'),
    )

    if (ready && lessons.length) {
      // Determine "current" = first unlocked not-yet-completed lesson
      const completedSet = new Set(data.completedLessons)
      const unlockedSet = new Set(data.unlockedLessons)
      let currentFound = false
      const grid = SP.h('div', { style:{
        display:'grid',
        gridTemplateColumns:'repeat(auto-fill, minmax(10rem, 1fr))',
        gap:'2.5rem 1.5rem', maxWidth:'80rem',
      }})

      for (const lesson of lessons) {
        const mastered = completedSet.has(lesson.id)
        const unlocked = unlockedSet.has(lesson.id)
        let kind
        if (mastered) kind = 'mastered'
        else if (!unlocked) kind = 'locked'
        else if (!currentFound) { kind = 'current'; currentFound = true }
        else kind = 'unlocked'

        grid.appendChild(renderNode(lesson, kind, app))
      }
      pathSection.appendChild(grid)
    } else {
      pathSection.appendChild(SP.h('div', { style:{ color:'var(--sp-on-surface-variant)' }},
        'Đang tải…'))
    }

    host.appendChild(topbar)
    host.appendChild(hero)
    if (continueCard) host.appendChild(continueCard)
    host.appendChild(pathSection)

    return { teardown() {} }
  }

  function renderNode(lesson, kind, app) {
    const data = app.getLessonScreenData(lesson.id)
    const totalSigns = data ? data.totalSigns : (lesson.signs ? lesson.signs.length : 0)
    const masteredCount = data ? data.masteredCount : 0

    const iconEl = kind === 'mastered'
      ? SP.h('span', { class:'material-symbols-outlined filled', style:{ fontSize:'2.25rem' }}, 'check_circle')
      : kind === 'current'
      ? SP.h('span', { class:'material-symbols-outlined', style:{ fontSize:'2.5rem' }}, 'auto_stories')
      : kind === 'unlocked'
      ? SP.h('span', { class:'material-symbols-outlined', style:{ fontSize:'2.25rem' }}, 'play_circle')
      : SP.h('span', { class:'material-symbols-outlined', style:{ fontSize:'2.25rem' }}, 'lock')

    const circle = SP.h('div', { class:'sp-node-circle ' + kind, style:{ color: kind === 'mastered' ? 'var(--sp-tertiary)' : undefined }},
      iconEl,
      SP.h('div', { class:'sp-node-emoji' }, lesson.icon),
      kind === 'current' ? SP.h('div', { class:'sp-node-badge' }, 'HIỆN TẠI') : null,
    )
    const node = SP.h('div', { class:'sp-node ' + (kind === 'locked' ? 'locked' : ''),
      onclick: () => {
        if (kind !== 'locked') {
          SP.setLastLesson(lesson.id)
          location.hash = '#lesson/' + encodeURIComponent(lesson.id)
        } else {
          SP.toast('Hoàn thành chương trước để mở khóa / Complete the previous chapter to unlock', 2500)
        }
      }
    },
      circle,
      SP.h('div', { class:'sp-node-label' },
        SP.h('div', { class:'vi' }, lesson.goal.vi),
        SP.h('div', { class:'en' }, lesson.goal.en),
        SP.h('div', { class:'stat' }, masteredCount + ' / ' + totalSigns + ' dấu'),
      )
    )
    return node
  }

  SP.screens.home = { render }
})();
