/**
 * Result modals (success / keep-trying) shown after a practice attempt.
 * Takes the practiceSign() return payload + a pair of action callbacks.
 */
;(function() {
  'use strict'

  const SP = window.SP
  SP.modals = SP.modals || {}

  function close() {
    const mount = document.getElementById('sp-modal-mount')
    if (mount) mount.innerHTML = ''
  }
  SP.modals.close = close

  /**
   * @param {object} result   — the practiceSign() payload
   * @param {object} actions  — { onTryAgain, onNext, onBack }
   *                             onNext is called for pass; onBack for fail
   *
   * `passed` is the hard v0.5 gate from api.js: inflateScore(raw) >= 50.
   * Fail state renders a stripped-down "Chưa đạt" modal with retry only.
   */
  SP.modals.showResult = function(result, actions) {
    // Route guard — if the user has navigated away from #practice/<sign>
    // while an attempt was in flight, drop the result on the floor rather
    // than popping a modal over whatever screen they're on now. The
    // attempt payload still goes through progression/review via
    // api.practiceSign's normal path — this guard is strictly a render
    // suppressor, not a state mutator.
    const currentHash = (typeof location !== 'undefined' && location.hash) || ''
    const onPractice = (SP.isPracticeRoute && SP.isPracticeRoute(currentHash))
      || (currentHash === '#practice' || currentHash.indexOf('#practice/') === 0)
    if (!onPractice) return
    const mount = document.getElementById('sp-modal-mount')
    if (!mount) return
    mount.innerHTML = ''

    // Prefer api.js's pre-computed inflatedFinalScore; fall back to
    // inflating here (keeps legacy callers that pass a raw attempt
    // payload rendering sensibly).
    const inflate = (SP.inflateScore || function(s) {
      if (typeof s !== 'number' || !isFinite(s)) return 0
      const n = Math.round(s) + 20
      return n < 0 ? 0 : n > 100 ? 100 : n
    })
    const displayScore = (typeof result.inflatedFinalScore === 'number')
      ? result.inflatedFinalScore
      : inflate(result.finalScore)
    const passed = typeof result.passed === 'boolean' ? result.passed : (displayScore >= 50)

    const scrim = SP.h('div', { class:'sp-modal-scrim', onclick: (e) => {
      if (e.target === scrim) close()
    }})

    const modal = SP.h('div', { class:'sp-modal sp-modal-lg', onclick: (e) => e.stopPropagation() })
    scrim.appendChild(modal)

    // ── FAIL PATH ─────────────────────────────────────────────────────
    // No stars, no XP, no progression update — just the score, a coach
    // hint (if present) and a single retry button.
    if (!passed) {
      const failHeader = SP.h('div', { style:{ textAlign:'center', marginBottom:'1.25rem' }},
        SP.h('div', { style:{ fontSize:'4rem', lineHeight:1, marginBottom:'.75rem' }}, '🌱'),
        SP.h('h2', { style:{ fontSize:'2.25rem', fontWeight:800, color:'var(--sp-primary)', marginBottom:'.25rem' }}, 'Chưa đạt'),
        SP.h('p', { style:{ color:'var(--sp-on-surface-variant)', fontSize:'1rem' }}, 'Not quite — try again'),
      )
      const failScoreBlock = SP.h('div', { style:{
        padding:'1.25rem', background:'var(--sp-surface-container-low)',
        borderRadius:'var(--sp-r-md)', marginBottom:'1.25rem', textAlign:'center',
      }},
        SP.h('div', { style:{ fontSize:'.75rem', fontWeight:600, color:'var(--sp-on-surface-variant)', textTransform:'uppercase', letterSpacing:'.5px' }}, 'Điểm số · Score'),
        SP.h('div', { style:{ fontSize:'3rem', fontWeight:800, color:'var(--sp-primary)', lineHeight:1, marginTop:'.25rem' }},
          String(displayScore)),
        SP.h('div', { style:{ fontSize:'.8125rem', color:'var(--sp-on-surface-variant)', marginTop:'.375rem' }},
          'Cần ≥ ' + SP.PASS_GATE + ' để vượt qua · Need ≥ ' + SP.PASS_GATE + ' to pass'),
      )
      let failAdvice = null
      if (result.advice) {
        failAdvice = SP.h('div', { style:{
          background:'var(--sp-tertiary-fixed)', padding:'1rem 1.25rem',
          borderRadius:'var(--sp-r-md)', marginBottom:'1.25rem',
          display:'flex', gap:'.75rem', alignItems:'flex-start',
        }},
          SP.h('span', { class:'material-symbols-outlined', style:{ color:'var(--sp-tertiary)' }}, 'lightbulb'),
          SP.h('div', { style:{ flex:1 }},
            SP.h('div', { style:{ fontSize:'.75rem', fontWeight:600, color:'var(--sp-on-tertiary-container)', letterSpacing:'.5px' }}, 'LỜI KHUYÊN'),
            SP.h('div', { style:{ color:'var(--sp-on-surface)', marginTop:'.25rem', fontSize:'.95rem' }}, result.advice),
          )
        )
      }
      const failActions = SP.h('div', { style:{ display:'flex', justifyContent:'center' }},
        SP.h('button', { class:'sp-btn sp-btn-primary sp-btn-lg',
          onclick: () => { close(); (actions && actions.onTryAgain) && actions.onTryAgain() }
        },
          SP.h('span', { class:'material-symbols-outlined' }, 'replay'),
          SP.h('span', {}, 'Thử lại · Try again'),
        )
      )
      modal.appendChild(failHeader)
      modal.appendChild(failScoreBlock)
      if (failAdvice) modal.appendChild(failAdvice)
      modal.appendChild(failActions)
      mount.appendChild(scrim)
      return
    }

    // ── PASS PATH ─────────────────────────────────────────────────────
    // Header: emoji + title + score
    const emoji = result.stars === 3 ? '🌟' : result.stars === 2 ? '✨' : '👍'
    const vtitle = result.stars === 3 ? 'Xuất sắc!' : result.stars === 2 ? 'Tốt lắm!' : 'Đạt rồi!'
    const etitle = result.stars === 3 ? 'Outstanding!' : result.stars === 2 ? 'Great job!' : 'You did it!'

    const header = SP.h('div', { style:{ textAlign:'center', marginBottom:'1.5rem' }},
      SP.h('div', { style:{ fontSize:'4rem', lineHeight:1, marginBottom:'.75rem' }}, emoji),
      SP.h('h2', { style:{ fontSize:'2.25rem', fontWeight:800, color:'var(--sp-primary)', marginBottom:'.25rem' }}, vtitle),
      SP.h('p', { style:{ color:'var(--sp-on-surface-variant)', fontSize:'1rem' }}, etitle),
    )

    // Score + stars — uses inflated display score, not the raw finalScore.
    const scoreRow = SP.h('div', { style:{
      display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:'1rem',
      padding:'1.5rem', background:'var(--sp-surface-container-low)',
      borderRadius:'var(--sp-r-md)', marginBottom:'1.5rem',
    }},
      statBlock('Điểm số', String(displayScore), 'Score'),
      statBlock('Đánh giá', SP.starsHTML(result.stars || 0, 3), 'Rating', true),
      statBlock('XP', result.progression ? '+' + result.progression.xpGained : '—', 'Experience'),
    )

    // Level up banner (if any)
    let levelUpBanner = null
    if (result.progression && result.progression.levelAfter > result.progression.levelBefore) {
      levelUpBanner = SP.h('div', { style:{
        background:'linear-gradient(135deg, #f9eca6 0%, #f68a2f 100%)',
        color:'var(--sp-on-primary-container)', padding:'.75rem 1rem', borderRadius:'.75rem',
        marginBottom:'1rem', textAlign:'center', fontWeight:700,
      }}, '🎉 Lên cấp ' + result.progression.levelAfter + '! Level up!')
    }

    // Coach advice
    let adviceCard = null
    const advice = result.advice
    if (advice) {
      adviceCard = SP.h('div', { style:{
        background:'var(--sp-tertiary-fixed)', padding:'1rem 1.25rem',
        borderRadius:'var(--sp-r-md)', marginBottom:'1.5rem',
        display:'flex', gap:'.75rem', alignItems:'flex-start',
      }},
        SP.h('span', { class:'material-symbols-outlined', style:{ color:'var(--sp-tertiary)' }}, 'lightbulb'),
        SP.h('div', { style:{ flex:1 }},
          SP.h('div', { style:{ fontSize:'.75rem', fontWeight:600, color:'var(--sp-on-tertiary-container)', letterSpacing:'.5px' }}, 'LỜI KHUYÊN'),
          SP.h('div', { style:{ color:'var(--sp-on-surface)', marginTop:'.25rem', fontSize:'.95rem' }}, advice),
        )
      )
    }

    // Per-finger breakdown — pass/partial/fail pills (not percentages).
    // Signing is visual-interpretive; a "73%"-precise score implies clinical
    // accuracy the engine can't back up. Three-state icons are honest and the
    // user's mental model maps cleanly to them.
    let fingerSection = null
    const fingers = result.deviations && result.deviations.fingers
    if (fingers && fingers.length) {
      fingerSection = SP.h('div', { style:{ marginBottom:'1.5rem' }},
        SP.h('h3', { style:{ fontSize:'.875rem', fontWeight:700, color:'var(--sp-on-surface)', marginBottom:'.75rem', textTransform:'uppercase', letterSpacing:'.5px' }},
          'Chi tiết từng ngón'),
        SP.h('div', { style:{ display:'flex', flexWrap:'wrap', gap:'.5rem' }},
          ...fingers.map(f => {
            // Inflate per-finger at the display boundary too — pills live
            // in the user-facing modal, so they use the same +20/clamp
            // mapping as the top-line score.
            const status = fingerStatus(inflate(f.score || 0))
            return SP.h('div', {
              'aria-label': (f.nameVi || f.name) + ' — ' + status.label,
              style:{
                display:'flex', alignItems:'center', gap:'.5rem',
                background: status.bg,
                color: status.fg,
                padding:'.5rem .875rem',
                borderRadius:'999px',
                fontSize:'.875rem',
                fontWeight: 500,
              }
            },
              SP.h('span', { style:{ fontSize:'1rem', lineHeight:1 }}, status.icon),
              SP.h('span', {}, f.nameVi || f.name),
            )
          })
        )
      )
    }

    // If this attempt's progression crossed a rank boundary, chain the
    // rank-up modal onto whichever action button the user clicks. We
    // can't just subscribe to 'rank:up' and show the modal eagerly —
    // the event fires BEFORE this modal renders, and two stacked
    // modals on the single #sp-modal-mount clobber each other.
    const prog = result.progression
    const rankChanged = !!(prog && prog.rankChanged && prog.rankBefore !== prog.rankAfter)
    function sequence(then) {
      close()
      if (rankChanged) {
        SP.modals.showRankUp({
          newRank: prog.rankAfter, prevRank: prog.rankBefore,
          newLevel: prog.levelAfter, prevLevel: prog.levelBefore,
        }, { onContinue: then })
      } else if (then) {
        then()
      }
    }

    // Action buttons
    const actionsRow = SP.h('div', { style:{ display:'flex', gap:'.75rem', justifyContent:'center', flexWrap:'wrap' }},
      SP.h('button', { class:'sp-btn sp-btn-secondary sp-btn-lg',
        onclick: () => { sequence(() => { (actions && actions.onTryAgain) && actions.onTryAgain() }) }
      },
        SP.h('span', { class:'material-symbols-outlined' }, 'replay'),
        SP.h('span', {}, 'Thử lại · Try again'),
      ),
      SP.h('button', { class:'sp-btn sp-btn-primary sp-btn-lg',
        onclick: () => {
          sequence(() => {
            if (passed) { (actions && actions.onNext) && actions.onNext() }
            else        { (actions && actions.onBack) && actions.onBack() }
          })
        }
      },
        SP.h('span', {}, passed ? 'Dấu tiếp theo · Next sign' : 'Về chương · Back to lesson'),
        SP.h('span', { class:'material-symbols-outlined filled' }, passed ? 'arrow_forward' : 'grid_view'),
      )
    )

    modal.appendChild(header)
    modal.appendChild(scoreRow)
    if (levelUpBanner) modal.appendChild(levelUpBanner)
    if (adviceCard) modal.appendChild(adviceCard)
    if (fingerSection) modal.appendChild(fingerSection)
    modal.appendChild(actionsRow)

    mount.appendChild(scrim)
  }

  function statBlock(label, value, subLabel, isHtml) {
    const vEl = isHtml
      ? SP.h('div', { html: value, style:{ fontSize:'1.75rem', lineHeight:1 }})
      : SP.h('div', { style:{ fontSize:'2rem', fontWeight:800, color:'var(--sp-primary)', lineHeight:1 }}, value)
    return SP.h('div', { style:{ textAlign:'center', display:'flex', flexDirection:'column', gap:'.375rem' }},
      SP.h('div', { style:{ fontSize:'.75rem', fontWeight:600, color:'var(--sp-on-surface-variant)', textTransform:'uppercase', letterSpacing:'.5px' }}, label),
      vEl,
      SP.h('div', { style:{ fontSize:'.6875rem', color:'var(--sp-on-surface-variant)' }}, subLabel),
    )
  }

  /**
   * Rank-up modal. Fires when the user's level-up crosses a 10-level
   * boundary (progression emits 'rank:up'). Single "Tiếp tục" button;
   * reuses the same scrim + sp-modal shell as showResult.
   *
   * @param {object} data    — { newRank, prevRank, newLevel, prevLevel }
   * @param {object} actions — { onContinue? }
   */
  SP.modals.showRankUp = function(data, actions) {
    const mount = document.getElementById('sp-modal-mount')
    if (!mount) return
    mount.innerHTML = ''
    const scrim = SP.h('div', { class:'sp-modal-scrim', onclick: (e) => {
      if (e.target === scrim) { close(); (actions && actions.onContinue) && actions.onContinue() }
    }})
    const modal = SP.h('div', { class:'sp-modal', onclick: (e) => e.stopPropagation(),
      style:{ maxWidth:'28rem' },
    })
    scrim.appendChild(modal)

    const accent = (SP.RANK_COLORS && SP.RANK_COLORS[data.newRank]) || 'var(--sp-primary)'
    const header = SP.h('div', { style:{ textAlign:'center', marginBottom:'1.25rem' }},
      SP.h('div', { style:{ fontSize:'3.5rem', lineHeight:1, marginBottom:'.5rem' }}, '🏅'),
      SP.h('div', { style:{
        fontSize:'.75rem', fontWeight:700, letterSpacing:'.5px',
        textTransform:'uppercase', color:'var(--sp-on-surface-variant)',
      }}, 'Thăng hạng · Rank up'),
      SP.h('h2', { style:{
        fontSize:'2.25rem', fontWeight:800, lineHeight:1.1,
        color: accent, margin:'.25rem 0',
      }}, data.newRank),
      SP.h('p', { style:{ color:'var(--sp-on-surface-variant)', fontSize:'.9375rem' }},
        'Cấp ' + data.prevLevel + ' · ' + data.prevRank + '  →  Cấp ' + data.newLevel + ' · ' + data.newRank),
    )

    const actionsRow = SP.h('div', { style:{ display:'flex', justifyContent:'center' }},
      SP.h('button', { class:'sp-btn sp-btn-primary sp-btn-lg',
        onclick: () => { close(); (actions && actions.onContinue) && actions.onContinue() }
      },
        SP.h('span', {}, 'Tiếp tục'),
        SP.h('span', { class:'material-symbols-outlined filled' }, 'arrow_forward'),
      )
    )

    modal.appendChild(header)
    modal.appendChild(actionsRow)
    mount.appendChild(scrim)
  }

  // Helper: map finger score to a three-state visual (✓ pass / ⚠ partial /
  // ✗ fail) + the design-system colour pair for the pill. Thresholds (70,
  // 40) live in SCORE space — 70 matches the whole-frame passAt so "pass"
  // on a finger means the same thing it does overall; 40 is near the
  // midpoint of the lenient finger curve. Hardcoded fallbacks after the
  // comma keep pills readable if a theme omits one of the tokens.
  function fingerStatus(score) {
    if (score >= 70) return { icon:'✓', bg:'var(--sp-primary-container, #d7edc9)',  fg:'var(--sp-on-primary-container, #1e4620)',  label:'Chính xác' }
    if (score >= 40) return { icon:'⚠', bg:'var(--sp-tertiary-container, #f9eca6)', fg:'var(--sp-on-tertiary-container, #6b4a00)', label:'Gần đúng' }
    return              { icon:'✗', bg:'var(--sp-error-container, #f7d6d0)',    fg:'var(--sp-on-error-container, #c0392b)',    label:'Sai' }
  }
  SP.modals.fingerStatus = fingerStatus  // exposed for tests / other screens
})();
