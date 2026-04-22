/**
 * Placement test screen (#placement).
 *
 * Assesses a user's starting level on 9 signs (3 easy + 3 medium + 3 hard)
 * and unlocks a proportional number of chapters based on the average
 * score. Launched automatically on first visit (routed from app.js after
 * onboarding) and also from the "Kiểm tra trình độ" button on the home
 * screen.
 *
 * Difficulty classification combines two template-derived signals that
 * the engine already computes at template-load time:
 *   - Handedness (nonDomMotionRatio < NONDOM_MOTION_RATIO_THRESHOLD = 0.75)
 *     → one-handed vs two-handed. Read from each template's cached field.
 *   - Dominant-hand wrist-Y trajectory range across the template's mean
 *     frames (feature index 1 = landmark 0 Y). Computed once per sign,
 *     cached on the template object itself (tmpl._placementDifficulty)
 *     so re-access is O(1). Threshold 0.3 shoulder-widths separates low
 *     and high motion variance. No engine file modification required —
 *     the cache lives on a template instance field.
 *
 *     easy   = one-handed + low motion
 *     medium = one-handed + high motion, OR two-handed + low motion
 *     hard   = two-handed + high motion
 *
 * Unlock mapping is monotonic: progression.unlockFirstNLessons(n) only
 * ADDS lesson IDs, never removes. A user who retakes the test with a
 * lower score keeps every chapter they've already unlocked.
 */
;(function() {
  'use strict'

  const SP = window.SP
  SP.screens = SP.screens || {}

  const NUM_PLACEMENT_SIGNS = 9
  const PER_BUCKET = 3
  const UNSEEN_WEIGHT = 3
  const SEEN_WEIGHT = 1
  const BACKFILL_PENALTY = 3
  const MOTION_VARIANCE_THRESHOLD = 0.3   // dom-hand wrist-Y range, shoulder-widths

  // Read the engine's handedness threshold from its exposed internals so
  // we never duplicate the 0.75 literal. Fallback is defensive only.
  function handednessThreshold() {
    const i = window.SignPathEngine && window.SignPathEngine._internals
    return (i && typeof i.NONDOM_MOTION_RATIO_THRESHOLD === 'number')
      ? i.NONDOM_MOTION_RATIO_THRESHOLD : 0.75
  }

  /**
   * Classify a sign by its template's cached signals. Result is memoised
   * on the template object so repeated access is free.
   */
  function classifySign(app, signKey) {
    const tmpl = app.engine.getTemplate ? app.engine.getTemplate(signKey) : null
    if (!tmpl) return null
    if (tmpl._placementDifficulty) return tmpl._placementDifficulty

    const ratio = typeof tmpl.nonDomMotionRatio === 'number' ? tmpl.nonDomMotionRatio : 1.0
    const oneHanded = ratio < handednessThreshold()

    // Dominant-hand wrist-Y range across template.mean. Feature index 1
    // is landmark 0's Y (engine lays out dom-hand landmarks first).
    let minY = Infinity, maxY = -Infinity
    if (tmpl.mean && tmpl.mean.length) {
      for (const frame of tmpl.mean) {
        const y = frame[1]
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
    const yRange = (maxY - minY)
    const lowMotion = !isFinite(yRange) || yRange < MOTION_VARIANCE_THRESHOLD

    let d
    if (oneHanded && lowMotion) d = 'easy'
    else if (!oneHanded && !lowMotion) d = 'hard'
    else d = 'medium'
    tmpl._placementDifficulty = d
    return d
  }

  /**
   * Install a read-only getter on the engine instance once so callers
   * can ask `app.engine.getSignDifficulty(key)` idiomatically.
   */
  function ensureEngineExposure(app) {
    if (typeof app.engine.getSignDifficulty === 'function') return
    app.engine.getSignDifficulty = function(key) { return classifySign(app, key) }
  }

  /**
   * Weighted random sampling without replacement. Weight 3 for signs
   * with zero attempts, 1 for seen. Optional penalty divides weights so
   * backfilled picks are strictly less preferred than in-bucket picks.
   */
  function pickWeighted(pool, n, penalty) {
    const remaining = pool.slice()
    const picks = []
    const penaltyDiv = penalty || 1
    while (picks.length < n && remaining.length) {
      const weights = remaining.map(s => (
        (s.attempts === 0 ? UNSEEN_WEIGHT : SEEN_WEIGHT) / penaltyDiv))
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

  /**
   * Build the 9-sign sequence: 3 easy, 3 medium, 3 hard. When easy or
   * hard runs short, pull the remainder from medium's leftover pool
   * with a weight penalty so true-bucket signs are strictly preferred.
   */
  function pickPlacementSet(app, eligibleSigns) {
    const buckets = { easy: [], medium: [], hard: [] }
    for (const s of eligibleSigns) {
      const d = classifySign(app, s.key)
      if (buckets[d]) buckets[d].push(s)
    }

    const picks = { easy: [], medium: [], hard: [] }

    // Medium first so its leftovers are available to backfill easy+hard.
    picks.medium = pickWeighted(buckets.medium, PER_BUCKET)
    const mediumUsed = new Set(picks.medium.map(s => s.key))
    const mediumLeftover = buckets.medium.filter(s => !mediumUsed.has(s.key))

    picks.easy = pickWeighted(buckets.easy, PER_BUCKET)
    if (picks.easy.length < PER_BUCKET) {
      const need = PER_BUCKET - picks.easy.length
      const extras = pickWeighted(mediumLeftover, need, BACKFILL_PENALTY)
      picks.easy = picks.easy.concat(extras)
      const used = new Set(extras.map(s => s.key))
      for (let i = mediumLeftover.length - 1; i >= 0; i--) {
        if (used.has(mediumLeftover[i].key)) mediumLeftover.splice(i, 1)
      }
    }

    picks.hard = pickWeighted(buckets.hard, PER_BUCKET)
    if (picks.hard.length < PER_BUCKET) {
      const need = PER_BUCKET - picks.hard.length
      const extras = pickWeighted(mediumLeftover, need, BACKFILL_PENALTY)
      picks.hard = picks.hard.concat(extras)
    }

    return picks.easy.concat(picks.medium, picks.hard)
  }

  function render() {
    const host = document.getElementById('sp-screen')
    host.innerHTML = ''

    const app = SP.getApp()
    if (!SP.isEngineReady()) {
      host.innerHTML = '<div style="padding:4rem; text-align:center; color:var(--sp-on-surface-variant);">Đang khởi động engine…<br/><small>Tải dấu kiểm tra · Loading signs</small></div>'
      return { teardown() {} }
    }

    ensureEngineExposure(app)

    // Assemble the candidate pool: every sign with a scorable template.
    const lessons = app.engine.getLessons ? app.engine.getLessons() : []
    const totalChapters = lessons.length
    const allSigns = []
    for (const lesson of lessons) {
      for (const sign of (lesson.signs || [])) {
        if (!app.engine.getTemplate || !app.engine.getTemplate(sign.key)) continue
        allSigns.push({
          key: sign.key,
          vi: sign.vi,
          en: sign.en,
          unitId: lesson.id,
          attempts: app.progression.getAttempts(sign.key),
        })
      }
    }

    if (allSigns.length < NUM_PLACEMENT_SIGNS) {
      renderUnavailable(host)
      return { teardown() {} }
    }

    // State
    let phase = 'intro'       // 'intro' | 'test' | 'results'
    let step = 0
    let picked = null
    const results = []        // [{ signKey, inflatedScore, passed, aborted }]
    let currentUI = null

    const homeData = app.getHomeScreenData()
    const topbar = SP.topbar({
      streak: homeData.streak.current,
      xp: homeData.user.xp,
      level: homeData.user.level,
      rank: homeData.user.rank,
    })
    host.appendChild(topbar)

    const stage = SP.h('div', { class:'sp-placement-stage' })
    host.appendChild(stage)

    renderPhase()

    function renderPhase() {
      if (currentUI) {
        try { currentUI.teardown() } catch(e) { console.error('[placement] teardown failed:', e) }
        currentUI = null
      }
      stage.innerHTML = ''
      if (phase === 'intro')   renderIntro()
      else if (phase === 'test')    renderTestStep()
      else                          renderResults()
    }

    function renderIntro() {
      const wrap = SP.h('section', { style:{
        padding:'3rem 2rem', maxWidth:'42rem', margin:'0 auto',
      }})
      wrap.appendChild(SP.h('div', { style:{
        fontSize:'.75rem', fontWeight:700, letterSpacing:'.5px',
        textTransform:'uppercase', color:'var(--sp-on-surface-variant)',
      }}, 'Bước khởi đầu'))
      wrap.appendChild(SP.h('h1', { style:{
        fontSize:'2.5rem', fontWeight:800, color:'var(--sp-primary)',
        marginTop:'.375rem', marginBottom:'.75rem', lineHeight:1.15,
      }}, 'Kiểm tra trình độ'))
      wrap.appendChild(SP.h('p', { style:{
        fontSize:'1.0625rem', color:'var(--sp-on-surface)', lineHeight:1.55,
        marginBottom:'.75rem',
      }}, '9 dấu · 3 dễ · 3 trung bình · 3 khó. Mỗi dấu quay một lần duy nhất.'))
      wrap.appendChild(SP.h('p', { style:{
        fontSize:'.9375rem', color:'var(--sp-on-surface-variant)', lineHeight:1.55,
        marginBottom:'1.5rem',
      }}, 'Điểm trung bình sẽ quyết định số chương được mở đầu tiên. Bạn luôn có thể học thêm các chương khác bằng cách hoàn thành chương trước đó.'))

      const startBtn = SP.h('button', { class:'sp-btn sp-btn-primary sp-btn-lg',
        onclick: () => {
          picked = pickPlacementSet(app, allSigns)
          if (!picked || picked.length < NUM_PLACEMENT_SIGNS) {
            SP.toast('Chưa đủ dấu để kiểm tra · Not enough signs', 2800)
            return
          }
          phase = 'test'; step = 0
          renderPhase()
        }
      },
        SP.h('span', { class:'material-symbols-outlined filled' }, 'play_arrow'),
        SP.h('span', {}, 'Bắt đầu kiểm tra'),
      )
      const skipBtn = SP.h('button', { class:'sp-btn',
        style:{ marginLeft:'.75rem' },
        onclick: () => {
          // Skip path: mark done + unlock chapter 1 so the user lands
          // somewhere useful. Any future re-test grows unlocks monotonically.
          app.progression.unlockFirstNLessons(1)
          app.progression.setPlacementTestCompleted()
          location.hash = '#home'
        }
      }, 'Bỏ qua')

      const actions = SP.h('div', { style:{ display:'flex', flexWrap:'wrap', gap:'.5rem', alignItems:'center' }},
        startBtn, skipBtn,
      )
      wrap.appendChild(actions)
      stage.appendChild(wrap)
    }

    function renderTestStep() {
      if (step >= picked.length) { phase = 'results'; renderPhase(); return }
      const sign = picked[step]
      const stepBadge = 'Kiểm tra trình độ · Dấu ' + (step + 1) + ' / ' + NUM_PLACEMENT_SIGNS

      currentUI = SP.practiceUI.buildAttemptUI(app, {
        signData: {
          key: sign.key,
          vi: sign.vi,
          en: sign.en,
          unitId: sign.unitId,
          hasTemplate: true,
        },
        backHref: '#home',
        backLabel: 'Về trang chủ',
        stepBadge,
        recordOnce: true,
        hideReferenceVideo: true,
        airtapActions: {
          onBack: () => { SP.toast('Xem lại đang phát triển · Review coming soon', 2000) },
          // Next = skip this sign as score-0, advance. Score counts
          // toward the average like any failed attempt.
          onNext: () => {
            results.push({ signKey: sign.key, inflatedScore: 0, passed: false, aborted: true })
            step++
            renderPhase()
          },
        },
        onAttemptComplete: async (result) => {
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

          const advance = () => { step++; renderPhase() }
          if (SP.attemptToast && SP.attemptToast.show) {
            SP.attemptToast.show({
              passed: aborted ? null : passed,
              score:  aborted ? null : inflatedScore,
              coachText: result.advice || '',
              onNext:  advance,
              onRetry: advance,
            })
          } else {
            advance()
          }
        },
      })
      stage.appendChild(currentUI.root)

      // Step counter + per-sign dots inserted above the camera surface.
      const chipRow = SP.h('div', {
        style:{ display:'flex', gap:'.5rem', alignItems:'center',
          padding:'.5rem 1rem 0', flexWrap:'wrap' }},
        SP.h('div', { style:{ fontSize:'.8125rem', fontWeight:700,
          color:'var(--sp-on-surface-variant)' }},
          'Kiểm tra trình độ'),
      )
      for (let i = 0; i < NUM_PLACEMENT_SIGNS; i++) {
        let dotColor = 'var(--sp-outline-variant)'
        if (i < results.length) dotColor = results[i].passed ? 'var(--sp-tertiary)' : 'var(--sp-error)'
        else if (i === step) dotColor = 'var(--sp-primary)'
        chipRow.appendChild(SP.h('div', { style:{
          width:'.5rem', height:'.5rem', borderRadius:'9999px', background: dotColor,
        }}))
      }
      currentUI.root.insertBefore(chipRow, currentUI.root.firstChild)
    }

    function renderResults() {
      // Average of what each attempt counted as — aborts count as zero
      // so the user can't game the score by bailing mid-test.
      const sum = results.reduce((a, r) => a + (r.inflatedScore || 0), 0)
      const avgScore = results.length ? Math.round(sum / results.length) : 0
      const unlockCount = Math.max(1, Math.round(avgScore / 100 * totalChapters))
      const newlyUnlocked = app.progression.unlockFirstNLessons(unlockCount)
      app.progression.setPlacementTestCompleted()

      const wrap = SP.h('section', { style:{
        padding:'2rem', maxWidth:'60rem', margin:'0 auto',
      }})
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
        background:'var(--sp-tertiary-fixed)',
      }},
        SP.h('div', { style:{ fontSize:'3rem', lineHeight:1, marginBottom:'.25rem' }}, '🧭'),
        SP.h('h2', { style:{ fontSize:'2rem', fontWeight:800, color:'var(--sp-primary)', lineHeight:1.1 }},
          'Kết quả kiểm tra trình độ'),
        SP.h('p', { style:{ color:'var(--sp-on-surface)', marginTop:'.5rem', fontSize:'1.0625rem' }},
          'Điểm trung bình · Average: ' + avgScore + ' / 100'),
        SP.h('p', { style:{ color:'var(--sp-tertiary)', fontWeight:700, marginTop:'.25rem' }},
          'Bạn đã mở khoá ' + unlockCount + ' chương'),
        newlyUnlocked.length > 0
          ? SP.h('p', { style:{ color:'var(--sp-on-surface-variant)', fontSize:'.8125rem', marginTop:'.25rem' }},
              'Mới mở lần này: ' + newlyUnlocked.length + ' chương')
          : SP.h('p', { style:{ color:'var(--sp-on-surface-variant)', fontSize:'.8125rem', marginTop:'.25rem' }},
              'Không có chương mới (đã mở sẵn từ trước)'),
      )
      wrap.appendChild(banner)

      const grid = SP.h('div', { style:{
        display:'grid',
        gridTemplateColumns:'repeat(auto-fill, minmax(12rem, 1fr))',
        gap:'.75rem',
        maxWidth:'52rem', margin:'0 auto 1.5rem',
      }})
      results.forEach((r, i) => {
        const tone = r.passed ? 'var(--sp-tertiary)' : 'var(--sp-error)'
        grid.appendChild(SP.h('div', { style:{
          padding:'.75rem 1rem',
          background:'var(--sp-surface-container-low)',
          borderLeft:'4px solid ' + tone,
          borderRadius:'.5rem',
          display:'flex', alignItems:'center', justifyContent:'space-between', gap:'.5rem',
        }},
          SP.h('div', { style:{ minWidth:0, flex:1 }},
            SP.h('div', { style:{ fontSize:'.6875rem', color:'var(--sp-on-surface-variant)', fontWeight:600 }},
              'Dấu ' + (i + 1)),
            SP.h('div', { style:{ fontSize:'.9375rem', fontWeight:700, color:'var(--sp-on-surface)',
              whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }},
              r.signKey),
          ),
          SP.h('div', { style:{ textAlign:'right' }},
            SP.h('div', { style:{ fontSize:'1.125rem', fontWeight:800, color: tone }},
              r.aborted ? '—' : String(r.inflatedScore)),
            SP.h('div', { style:{ fontSize:'.6875rem', color:'var(--sp-on-surface-variant)' }},
              r.passed ? 'Đạt' : (r.aborted ? 'Huỷ' : 'Chưa đạt')),
          ),
        ))
      })
      wrap.appendChild(grid)

      wrap.appendChild(SP.h('div', { style:{
        display:'flex', justifyContent:'center',
      }},
        SP.h('a', { href:'#home', class:'sp-btn sp-btn-primary sp-btn-lg' },
          SP.h('span', {}, 'Bắt đầu học'),
          SP.h('span', { class:'material-symbols-outlined filled' }, 'arrow_forward'),
        ),
      ))

      stage.appendChild(wrap)
    }

    function renderUnavailable(hostEl) {
      const homeData2 = app.getHomeScreenData()
      const topbar2 = SP.topbar({
        streak: homeData2.streak.current,
        xp: homeData2.user.xp,
        level: homeData2.user.level,
        rank: homeData2.user.rank,
      })
      hostEl.appendChild(topbar2)
      hostEl.appendChild(SP.h('div', { style:{ padding:'4rem', textAlign:'center' }},
        SP.h('h2', { style:{ fontSize:'1.75rem', fontWeight:800, color:'var(--sp-primary)' }}, 'Chưa thể kiểm tra'),
        SP.h('p', { style:{
          color:'var(--sp-on-surface-variant)', maxWidth:'32rem',
          margin:'.5rem auto 1.25rem', lineHeight:1.5,
        }}, 'Hệ thống chưa có đủ dấu để kiểm tra trình độ. Hãy học theo trình tự bình thường.'),
        SP.h('a', { class:'sp-btn sp-btn-primary', href:'#home',
          onclick: () => {
            // No point gating a user who literally can't take the test.
            app.progression.unlockFirstNLessons(1)
            app.progression.setPlacementTestCompleted()
          }
        }, 'Về trang chủ'),
      ))
    }

    return {
      teardown() {
        if (currentUI) {
          try { currentUI.teardown() } catch(_) {}
          currentUI = null
        }
        try { app.engine.clearSign && app.engine.clearSign() } catch(_) {}
        if (typeof app.engine.pauseCapture === 'function') {
          app.engine.pauseCapture().catch(e => console.error('[placement] pauseCapture failed:', e))
        }
      }
    }
  }

  SP.screens.placement = { render }
})();
