/**
 * Skip-evaluation screen (#skiptest/:lessonId).
 *
 * Launched from the "Kiểm tra đầu vào" button next to each locked unit on
 * the home screen. Presents 3 signs drawn from the unit (weighted toward
 * unseen signs) and records one attempt per sign through the normal
 * app.practiceSign() pipeline. A pass (≥ 2 of 3 attempts at or above
 * SP.PASS_GATE post-inflation) calls progression.completeUnit() which
 * marks the lesson complete and unlocks the next lesson.
 *
 * Each of the 3 attempts counts as a real attempt: XP, mastery, streak,
 * and review scheduling all flow through the normal practice code path.
 * The per-attempt camera UI is built by SP.practiceUI.buildAttemptUI —
 * the same helper the practice screen uses — so skip-test and practice
 * share one DOM, one event-wire, one camera pipeline.
 */
;(function() {
  'use strict'

  const SP = window.SP
  SP.screens = SP.screens || {}

  const NUM_EVAL_SIGNS = 3
  const MIN_PASSES = 2
  const UNSEEN_WEIGHT = 3
  const SEEN_WEIGHT = 1

  function render(lessonId) {
    const host = document.getElementById('sp-screen')
    host.innerHTML = ''

    const app = SP.getApp()
    if (!SP.isEngineReady()) {
      host.innerHTML = '<div style="padding:4rem; text-align:center; color:var(--sp-on-surface-variant);">Đang khởi động engine…</div>'
      return { teardown() {} }
    }

    const lessonData = app.getLessonScreenData(lessonId)
    if (!lessonData) {
      host.innerHTML = '<div style="padding:4rem; text-align:center;"><h2>Không tìm thấy chương</h2><a class="sp-btn sp-btn-primary" href="#home">Về trang chủ</a></div>'
      return { teardown() {} }
    }

    // Pick signs with template data only — otherwise practiceSign has
    // nothing to score against.
    const eligible = lessonData.signs.filter(s =>
      app.engine.getTemplate && !!app.engine.getTemplate(s.key))
    if (eligible.length < NUM_EVAL_SIGNS) {
      host.innerHTML = '<div style="padding:4rem; text-align:center;">' +
        '<h2>Chưa thể kiểm tra</h2>' +
        '<p style="color:var(--sp-on-surface-variant); max-width:32rem; margin:.5rem auto 1.25rem;">' +
        'Chương này chưa có đủ dấu để kiểm tra đầu vào. Hãy học theo trình tự bình thường.</p>' +
        '<a class="sp-btn sp-btn-primary" href="#home">Về trang chủ</a></div>'
      return { teardown() {} }
    }

    const picked = pickWeighted(eligible, NUM_EVAL_SIGNS)

    // State
    let step = 0
    const results = []          // [{ signKey, inflatedScore, passed, aborted }]
    let currentUI = null        // the active buildAttemptUI handle
    let finished = false

    const homeData = app.getHomeScreenData()
    const topbar = SP.topbar({
      streak: homeData.streak.current,
      xp: homeData.user.xp,
      level: homeData.user.level,
      rank: homeData.user.rank,
    })
    host.appendChild(topbar)

    // The per-step camera UI is swapped into `stage`; the results screen
    // replaces `stage`'s children when finished.
    const stage = SP.h('div', { class:'sp-skiptest-stage' })
    host.appendChild(stage)

    renderStep()

    function renderStep() {
      // Tear down the previous step's UI (if any) so its event handlers
      // and stream poller release cleanly before we wire new ones.
      if (currentUI) {
        try { currentUI.teardown() } catch(e) { console.error('[skiptest] teardown failed:', e) }
        currentUI = null
      }
      stage.innerHTML = ''

      if (finished || step >= picked.length) {
        finished = true
        renderResults()
        return
      }

      const sign = picked[step]
      const stepBadge = 'Kiểm tra · Dấu ' + (step + 1) + ' / ' + NUM_EVAL_SIGNS

      currentUI = SP.practiceUI.buildAttemptUI(app, {
        signData: {
          key: sign.key,
          vi: sign.vi,
          en: sign.en,
          unitId: lessonId,
          hasTemplate: true,
        },
        backHref: '#home',
        backLabel: 'Về trang chủ',
        stepBadge,
        recordOnce: true,
        // No cheat sheet during evaluation — camera feed reclaims the
        // right-column space previously used by the reference video.
        hideReferenceVideo: true,
        onAttemptComplete: async (result) => {
          // Single attempt per sign, pass or fail. practiceSign already
          // routed XP / mastery / review for non-aborted attempts — we
          // just record the outcome here and advance.
          let inflatedScore, passed, aborted
          if (result.aborted) {
            aborted = true; passed = false; inflatedScore = 0
          } else {
            aborted = false
            inflatedScore = typeof result.inflatedFinalScore === 'number'
              ? result.inflatedFinalScore
              : (SP.inflateScore ? SP.inflateScore(result.finalScore) : 0)
            passed = typeof result.passed === 'boolean'
              ? result.passed
              : (inflatedScore >= (SP.PASS_GATE || 50))
            SP.pushRecent(sign.key)
          }
          results.push({ signKey: sign.key, inflatedScore, passed, aborted })
          step++
          renderStep()
        },
      })
      stage.appendChild(currentUI.root)

      // Progress chip row: "Dấu X/3" + pass/fail dots for completed
      // attempts. Positioned above the camera surface so it doesn't
      // overlap any practice overlay.
      const chipRow = SP.h('div', {
        style:{ display:'flex', gap:'.5rem', alignItems:'center',
          padding:'.5rem 1rem 0', flexWrap:'wrap' }},
        SP.h('div', { style:{ fontSize:'.8125rem', fontWeight:700,
          color:'var(--sp-on-surface-variant)' }},
          'Kiểm tra đầu vào · ' + SP.escapeHTML(lessonData.goal.vi)),
      )
      for (let i = 0; i < NUM_EVAL_SIGNS; i++) {
        let dotColor = 'var(--sp-outline-variant)'
        if (i < results.length) dotColor = results[i].passed ? 'var(--sp-tertiary)' : 'var(--sp-error)'
        else if (i === step) dotColor = 'var(--sp-primary)'
        chipRow.appendChild(SP.h('div', { style:{
          width:'.625rem', height:'.625rem', borderRadius:'9999px', background: dotColor,
        }}))
      }
      currentUI.root.insertBefore(chipRow, currentUI.root.firstChild)
    }

    function renderResults() {
      const passedCount = results.filter(r => r.passed).length
      const didPass = passedCount >= MIN_PASSES

      // Award unit completion via the progression facade. No attempt
      // stamping, no mastery forging — just the completion + unlock
      // transition (see signpath-progression.js:completeUnit).
      let unitResult = null
      if (didPass) {
        try { unitResult = app.progression.completeUnit(lessonId) }
        catch (e) { console.error('[skiptest] completeUnit failed:', e) }
      }

      stage.innerHTML = ''
      const wrap = SP.h('div', { style:{ padding:'1.5rem 2rem 3rem', maxWidth:'60rem', margin:'0 auto' }})
      stage.appendChild(wrap)

      wrap.appendChild(SP.h('a', { href:'#home', style:{
        color:'var(--sp-on-surface-variant)', textDecoration:'none',
        display:'inline-flex', alignItems:'center', gap:'.25rem',
        fontSize:'.875rem', marginBottom:'1rem',
      }},
        SP.h('span', { class:'material-symbols-outlined', style:{ fontSize:'1.125rem' }}, 'arrow_back'),
        SP.h('span', {}, 'Về trang chủ'),
      ))

      const banner = SP.h('div', { style:{
        padding:'1.5rem', borderRadius:'var(--sp-r-md)',
        marginBottom:'1.5rem', textAlign:'center',
        background: didPass ? 'var(--sp-tertiary-fixed)' : 'var(--sp-surface-container-low)',
      }},
        SP.h('div', { style:{ fontSize:'3rem', lineHeight:1, marginBottom:'.25rem' }},
          didPass ? '🎉' : '🌱'),
        SP.h('h2', { style:{ fontSize:'2rem', fontWeight:800, color:'var(--sp-primary)', lineHeight:1.1 }},
          didPass ? 'Đạt yêu cầu!' : 'Chưa đạt'),
        SP.h('p', { style:{ color:'var(--sp-on-surface-variant)', marginTop:'.25rem' }},
          passedCount + ' / ' + NUM_EVAL_SIGNS + ' đạt điểm ≥ ' + (SP.PASS_GATE || 50)),
        didPass && unitResult && unitResult.completed
          ? SP.h('p', { style:{ marginTop:'.5rem', color:'var(--sp-tertiary)', fontWeight:600 }},
              '✓ Mở khóa chương này · Chapter unlocked')
          : null,
      )
      wrap.appendChild(banner)

      const list = SP.h('div', { style:{
        display:'flex', flexDirection:'column', gap:'.625rem',
        maxWidth:'40rem', margin:'0 auto 1.5rem',
      }})
      results.forEach((r, i) => {
        const tone = r.passed ? 'var(--sp-tertiary)' : 'var(--sp-error)'
        list.appendChild(SP.h('div', { style:{
          display:'flex', alignItems:'center', justifyContent:'space-between',
          padding:'.75rem 1rem',
          background:'var(--sp-surface-container-low)',
          borderLeft:'4px solid ' + tone,
          borderRadius:'.5rem',
        }},
          SP.h('div', {},
            SP.h('div', { style:{ fontSize:'.75rem', color:'var(--sp-on-surface-variant)', fontWeight:600 }},
              'Dấu ' + (i + 1)),
            SP.h('div', { style:{ fontSize:'1rem', fontWeight:700, color:'var(--sp-on-surface)' }}, r.signKey),
          ),
          SP.h('div', { style:{ textAlign:'right' }},
            SP.h('div', { style:{ fontSize:'1.25rem', fontWeight:800, color: tone }},
              r.aborted ? '—' : String(r.inflatedScore)),
            SP.h('div', { style:{ fontSize:'.75rem', color:'var(--sp-on-surface-variant)' }},
              r.passed ? 'Đạt · Pass' : (r.aborted ? 'Hủy · Aborted' : 'Chưa đạt · Fail')),
          ),
        ))
      })
      wrap.appendChild(list)

      const actionRow = SP.h('div', { style:{
        display:'flex', gap:'.75rem', justifyContent:'center', flexWrap:'wrap',
      }})
      if (didPass) {
        actionRow.appendChild(SP.h('a', { href:'#home', class:'sp-btn sp-btn-primary sp-btn-lg' },
          SP.h('span', {}, 'Về trang chủ · Home'),
          SP.h('span', { class:'material-symbols-outlined filled' }, 'arrow_forward'),
        ))
      } else {
        actionRow.appendChild(SP.h('a', {
          href:'#lesson/' + encodeURIComponent(lessonId),
          class:'sp-btn sp-btn-primary sp-btn-lg',
        },
          SP.h('span', { class:'material-symbols-outlined' }, 'school'),
          SP.h('span', {}, 'Học đơn vị này · Study this unit'),
        ))
        actionRow.appendChild(SP.h('a', { href:'#home', class:'sp-btn' },
          SP.h('span', {}, 'Về trang chủ'),
        ))
      }
      wrap.appendChild(actionRow)
    }

    return {
      teardown() {
        if (currentUI) {
          try { currentUI.teardown() } catch(_) {}
          currentUI = null
        }
        try { app.engine.clearSign && app.engine.clearSign() } catch(_) {}
        if (typeof app.engine.pauseCapture === 'function') {
          app.engine.pauseCapture().catch(e => console.error('[skiptest] pauseCapture failed:', e))
        }
      }
    }
  }

  /**
   * Weighted random sampling without replacement. Weight 3 for signs the
   * user has never attempted (progression.attempts === 0), weight 1 for
   * the rest. Roulette-wheel selection per pick, with the chosen item
   * removed from the pool before the next draw so we never repeat.
   */
  function pickWeighted(pool, n) {
    const remaining = pool.slice()
    const picks = []
    while (picks.length < n && remaining.length) {
      const weights = remaining.map(s => (s.attempts === 0 ? UNSEEN_WEIGHT : SEEN_WEIGHT))
      const total = weights.reduce((a, b) => a + b, 0)
      let r = Math.random() * total
      let idx = 0
      for (let i = 0; i < weights.length; i++) {
        r -= weights[i]
        if (r <= 0) { idx = i; break }
        idx = i
      }
      picks.push(remaining[idx])
      remaining.splice(idx, 1)
    }
    return picks
  }

  SP.screens.skiptest = { render }
})();
