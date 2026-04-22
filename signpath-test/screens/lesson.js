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

    // ── Mode toggle: Luyện tập (default) · Thẻ ghi nhớ · Trắc nghiệm ───
    // Local state only; flipping does not route, re-fetch data, or touch
    // the camera. Default 'practice' preserves the pre-toggle behaviour.
    let mode = 'practice'
    let flashIndex = 0
    let flashFlipped = false

    // Quiz state (Trắc nghiệm). Lives per-render; switching away and
    // back resets the quiz to its setup phase.
    let quizPhase = 'setup'          // 'setup' | 'playing' | 'results'
    let quizQuestions = []           // [{ sign, options:[{vi,correct}], answeredIdx, correct }]
    let quizIdx = 0
    let quizXpEarned = 0
    let quizFeedbackTimer = null

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
    toggleWrap.appendChild(modeBtn('quiz', 'Trắc nghiệm', 'Quiz', 'quiz'))
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
      // Any pending quiz feedback timer must clear on mode change so a
      // stale setTimeout doesn't write to a torn-down DOM.
      if (quizFeedbackTimer) { clearTimeout(quizFeedbackTimer); quizFeedbackTimer = null }
      contentHost.innerHTML = ''
      if (mode === 'flashcard')      renderFlashcards()
      else if (mode === 'quiz')      renderQuiz()
      else                           renderSignGrid()
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

    // ── Quiz (Trắc nghiệm) ────────────────────────────────────────────
    // Click-based MCQ — no camera, no MediaPipe, no session lifecycle.
    // Each answer logs a synthetic attempt through progression.recordAttempt
    // (the same API practice/skiptest/placement route through) so XP,
    // streak, history, and weighting all behave uniformly. Correct =
    // raw 55 / 1★ → inflated 75 (well past SP.PASS_GATE). Wrong = 0 / 0★.
    function renderQuiz() {
      const templated = data.signs.filter(s =>
        app.engine.getTemplate && !!app.engine.getTemplate(s.key))

      // Empty state mirrors skiptest's "Chưa thể kiểm tra" when a 4-option
      // MCQ isn't even formable — need 1 correct + 3 distractors.
      if (templated.length < 4) {
        const distractorPool = collectDistractorPool([])
        if (templated.length < 1 || (templated.length + distractorPool.length) < 4) {
          contentHost.appendChild(SP.h('div', { style:{
            padding:'3rem 1rem', textAlign:'center',
          }},
            SP.h('h2', { style:{ fontSize:'1.5rem', fontWeight:800, color:'var(--sp-primary)' }},
              'Chưa thể kiểm tra'),
            SP.h('p', { style:{ color:'var(--sp-on-surface-variant)', maxWidth:'28rem', margin:'.5rem auto', lineHeight:1.5 }},
              'Chương này chưa có đủ dấu để làm trắc nghiệm.'),
          ))
          return
        }
      }

      if (quizPhase === 'setup')   return renderQuizSetup(templated)
      if (quizPhase === 'playing') return renderQuizQuestion()
      return renderQuizResults()
    }

    function renderQuizSetup(templated) {
      const wrap = SP.h('div', { style:{
        maxWidth:'36rem', display:'flex', flexDirection:'column', gap:'1rem',
      }})
      wrap.appendChild(SP.h('h2', { style:{ fontSize:'1.25rem', fontWeight:700, color:'var(--sp-on-surface)' }},
        'Trắc nghiệm · Chọn độ dài'))

      let chosen = templated.length >= 10 ? 10 : templated.length >= 5 ? 5 : templated.length
      const optRow = SP.h('div', { style:{ display:'flex', gap:'.5rem', flexWrap:'wrap' }})
      const buildOpt = (label, value, enabled) => {
        const btn = SP.h('button', {
          'data-qlen': String(value),
          disabled: !enabled,
          style:{
            padding:'.625rem 1.25rem', borderRadius:'9999px',
            border: '2px solid var(--sp-outline-variant)',
            background: chosen === value ? 'var(--sp-primary)' : 'transparent',
            color: chosen === value ? 'var(--sp-on-primary)' : 'var(--sp-on-surface)',
            fontWeight:600, fontSize:'.875rem', cursor: enabled ? 'pointer' : 'not-allowed',
            fontFamily:'inherit', opacity: enabled ? 1 : .45,
          },
          onclick: () => {
            if (!enabled) return
            chosen = value
            optRow.querySelectorAll('button[data-qlen]').forEach(b => {
              const v = Number(b.dataset.qlen)
              const active = v === chosen
              b.style.background = active ? 'var(--sp-primary)' : 'transparent'
              b.style.color      = active ? 'var(--sp-on-primary)' : 'var(--sp-on-surface)'
            })
          },
        }, label)
        return btn
      }
      const has5  = templated.length >= 5
      const has10 = templated.length >= 10
      optRow.appendChild(buildOpt('5 câu',  5,  has5))
      optRow.appendChild(buildOpt('10 câu', 10, has10))
      optRow.appendChild(buildOpt('Tất cả', templated.length, templated.length >= 1))
      wrap.appendChild(optRow)

      if (!has5) {
        wrap.appendChild(SP.h('div', { style:{
          fontSize:'.8125rem', color:'var(--sp-on-surface-variant)',
          background:'var(--sp-surface-container-low)',
          padding:'.625rem .75rem', borderRadius:'.5rem',
        }}, 'Chương này chỉ có ' + templated.length + ' dấu có dữ liệu — dùng "Tất cả".'))
      }

      wrap.appendChild(SP.h('button', {
        class:'sp-btn sp-btn-primary sp-btn-lg',
        style:{ alignSelf:'flex-start', marginTop:'.5rem' },
        onclick: () => {
          quizQuestions = buildQuizQueue(templated, chosen)
          if (!quizQuestions.length) {
            SP.toast('Không tạo được trắc nghiệm', 2500)
            return
          }
          quizPhase = 'playing'
          quizIdx = 0
          quizXpEarned = 0
          renderContent()
        },
      },
        SP.h('span', { class:'material-symbols-outlined filled' }, 'play_arrow'),
        SP.h('span', {}, 'Bắt đầu'),
      ))

      contentHost.appendChild(wrap)
    }

    function renderQuizQuestion() {
      if (quizIdx >= quizQuestions.length) { quizPhase = 'results'; renderContent(); return }
      const q = quizQuestions[quizIdx]
      const total = quizQuestions.length

      const wrap = SP.h('div', { style:{ maxWidth:'36rem' }})

      wrap.appendChild(SP.h('div', { style:{
        display:'flex', justifyContent:'space-between', alignItems:'center',
        marginBottom:'1rem',
      }},
        SP.h('div', { style:{ fontSize:'.8125rem', fontWeight:700, color:'var(--sp-on-surface-variant)' }},
          'Câu ' + (quizIdx + 1) + ' / ' + total),
        SP.h('div', { style:{ fontSize:'.8125rem', color:'var(--sp-on-surface-variant)' }},
          'Chọn từ đúng với video'),
      ))

      // Video (reference video only — no camera).
      const video = SP.videoEl(q.sign.key)
      video.style.aspectRatio = '4/3'
      video.style.borderRadius = 'var(--sp-r-md)'
      video.style.overflow = 'hidden'
      wrap.appendChild(video)

      const optGrid = SP.h('div', { style:{
        display:'grid', gridTemplateColumns:'repeat(2, 1fr)', gap:'.625rem',
        marginTop:'1rem',
      }})
      q.options.forEach((opt, i) => {
        const btn = SP.h('button', {
          'data-qopt': String(i),
          style:{
            padding:'.875rem 1rem', borderRadius:'.75rem',
            border:'2px solid var(--sp-outline-variant)',
            background:'var(--sp-surface-container-low)',
            color:'var(--sp-on-surface)',
            fontSize:'1rem', fontWeight:600, cursor:'pointer',
            fontFamily:'inherit', textAlign:'left',
            transition:'background .15s, border-color .15s',
          },
          onclick: () => handleAnswer(i),
        }, opt.vi)
        optGrid.appendChild(btn)
      })
      wrap.appendChild(optGrid)

      contentHost.appendChild(wrap)

      function handleAnswer(answeredIdx) {
        if (q.answeredIdx != null) return // already answered, ignore
        q.answeredIdx = answeredIdx
        const correct = q.options[answeredIdx].correct
        q.correct = correct

        // Log the attempt via the normal progression pipeline. Synthetic
        // score: raw 55 / 1★ for correct (inflated 75 — clears PASS_GATE),
        // 0 / 0★ for wrong (registers attempt, no XP). attemptId prefixed
        // so it never collides with real practice attempts in the dedupe
        // ring buffer.
        try {
          const progResult = app.progression.recordAttempt({
            signKey: q.sign.key,
            finalScore: correct ? 55 : 0,
            stars: correct ? 1 : 0,
            attemptId: 'quiz_' + Date.now() + '_' + quizIdx,
            timestamp: Date.now(),
          })
          if (progResult && progResult.xpGained) quizXpEarned += progResult.xpGained
        } catch(e) {
          console.error('[quiz] recordAttempt failed:', e)
        }

        // Paint feedback: chosen red or green; correct option also green.
        const buttons = optGrid.querySelectorAll('button[data-qopt]')
        buttons.forEach((b, bi) => {
          b.disabled = true
          b.style.cursor = 'default'
          if (q.options[bi].correct) {
            b.style.background = 'var(--sp-tertiary-fixed)'
            b.style.borderColor = 'var(--sp-tertiary)'
            b.style.color = 'var(--sp-on-tertiary-container)'
          } else if (bi === answeredIdx) {
            b.style.background = 'var(--sp-error-container, #f7d6d0)'
            b.style.borderColor = 'var(--sp-error, #c0392b)'
            b.style.color = 'var(--sp-on-error-container, #c0392b)'
          } else {
            b.style.opacity = '.55'
          }
        })

        quizFeedbackTimer = setTimeout(() => {
          quizFeedbackTimer = null
          quizIdx++
          renderContent()
        }, 1200)
      }
    }

    function renderQuizResults() {
      const total = quizQuestions.length
      const correctCount = quizQuestions.filter(q => q.correct).length
      const pct = total ? Math.round(100 * correctCount / total) : 0
      const message =
        pct >= 90 ? 'Tuyệt vời!' :
        pct >= 70 ? 'Rất tốt!' :
        pct >= 50 ? 'Tiếp tục cố gắng!' :
        'Hãy xem lại video mẫu rồi thử lại.'

      const wrap = SP.h('div', { style:{ maxWidth:'42rem' }})
      wrap.appendChild(SP.h('div', { style:{
        padding:'1.25rem 1.5rem', background:'var(--sp-tertiary-fixed)',
        borderRadius:'var(--sp-r-md)', marginBottom:'1.25rem',
      }},
        SP.h('div', { style:{ fontSize:'.75rem', fontWeight:700, letterSpacing:'.5px',
          textTransform:'uppercase', color:'var(--sp-on-surface-variant)' }}, 'Kết quả trắc nghiệm'),
        SP.h('div', { style:{ fontSize:'2rem', fontWeight:800, color:'var(--sp-primary)', marginTop:'.25rem' }},
          correctCount + ' / ' + total + ' đúng'),
        SP.h('div', { style:{ fontSize:'.9375rem', color:'var(--sp-on-surface)', marginTop:'.25rem' }},
          pct + '% · ' + message),
        SP.h('div', { style:{ fontSize:'.8125rem', color:'var(--sp-on-surface-variant)', marginTop:'.25rem' }},
          'XP nhận được: +' + quizXpEarned),
      ))

      const list = SP.h('div', { style:{
        display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(12rem, 1fr))',
        gap:'.5rem', marginBottom:'1.25rem',
      }})
      quizQuestions.forEach((q, i) => {
        const ok = q.correct
        list.appendChild(SP.h('div', { style:{
          display:'flex', alignItems:'center', gap:'.5rem',
          padding:'.5rem .75rem', borderRadius:'.5rem',
          background:'var(--sp-surface-container-low)',
          borderLeft: '4px solid ' + (ok ? 'var(--sp-tertiary)' : 'var(--sp-error)'),
        }},
          SP.h('span', { style:{ fontSize:'1.125rem', color: ok ? 'var(--sp-tertiary)' : 'var(--sp-error)' }},
            ok ? '✓' : '✗'),
          SP.h('div', { style:{ minWidth:0, flex:1 }},
            SP.h('div', { style:{ fontSize:'.6875rem', color:'var(--sp-on-surface-variant)' }},
              'Câu ' + (i + 1)),
            SP.h('div', { style:{ fontSize:'.875rem', fontWeight:700, color:'var(--sp-on-surface)',
              whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}, q.sign.vi),
          ),
        ))
      })
      wrap.appendChild(list)

      wrap.appendChild(SP.h('div', { style:{ display:'flex', gap:'.625rem', flexWrap:'wrap' }},
        SP.h('button', { class:'sp-btn',
          onclick: () => {
            // "Học lại" — back to Luyện tập mode for this chapter.
            quizPhase = 'setup'; quizQuestions = []; quizIdx = 0; quizXpEarned = 0
            mode = 'practice'
            renderContent(); refreshToggle()
          }
        },
          SP.h('span', { class:'material-symbols-outlined' }, 'fitness_center'),
          SP.h('span', {}, 'Học lại'),
        ),
        SP.h('a', { class:'sp-btn sp-btn-primary', href:'#home' },
          SP.h('span', {}, 'Về trang chủ'),
          SP.h('span', { class:'material-symbols-outlined' }, 'home'),
        ),
      ))

      contentHost.appendChild(wrap)
    }

    /**
     * Build the question queue from a templated sign list + chosen count.
     * Each question = one correct answer + three distractors drawn first
     * from the same chapter and then (if needed) from other chapters.
     */
    function buildQuizQueue(templated, count) {
      const chosenSigns = shuffle(templated.slice()).slice(0, count)
      const questions = []
      for (const sign of chosenSigns) {
        const distractors = collectDistractorPool([sign.key])
          .filter(d => templated.some(t => t.key === d.key))
        shuffle(distractors)
        let picked = distractors.slice(0, 3)
        if (picked.length < 3) {
          const cross = collectDistractorPool([sign.key, ...picked.map(p => p.key)])
            .filter(d => !templated.some(t => t.key === d.key))
          shuffle(cross)
          picked = picked.concat(cross.slice(0, 3 - picked.length))
        }
        const options = [{ vi: sign.vi, correct: true }]
          .concat(picked.slice(0, 3).map(d => ({ vi: d.vi, correct: false })))
        shuffle(options)
        questions.push({ sign, options, answeredIdx: null, correct: false })
      }
      return questions
    }

    /**
     * Collect distractor candidates: every templated sign across all
     * lessons, excluded by an exclude-key list. Returns [{ key, vi }, ...].
     * De-duplicated on `vi` so visually identical options don't appear.
     */
    function collectDistractorPool(excludeKeys) {
      const excluded = new Set(excludeKeys)
      const pool = []
      const seenVi = new Set()
      const lessons = app.engine.getLessons ? app.engine.getLessons() : []
      for (const lesson of lessons) {
        for (const s of (lesson.signs || [])) {
          if (excluded.has(s.key)) continue
          if (seenVi.has(s.vi)) continue
          if (!app.engine.getTemplate || !app.engine.getTemplate(s.key)) continue
          seenVi.add(s.vi)
          pool.push({ key: s.key, vi: s.vi })
        }
      }
      return pool
    }

    function shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        const t = arr[i]; arr[i] = arr[j]; arr[j] = t
      }
      return arr
    }

    renderContent()

    // ── Disqus comments (below content, one thread per chapter) ──────
    // Lives as a sibling of contentHost so mode toggles (which re-render
    // contentHost) don't tear down the thread. Follows the chapter.
    const commentsSection = SP.h('section', { style:{
      padding:'1rem 3rem 4rem',
    }},
      SP.h('h2', { style:{
        fontSize:'1.125rem', fontWeight:700,
        color:'var(--sp-on-surface)', marginBottom:'.75rem',
        maxWidth:'42rem',
      }}, 'Thảo luận chương này'),
    )
    const commentsHost = SP.h('div', { style:{
      maxWidth:'42rem',
    }})
    commentsSection.appendChild(commentsHost)

    let disqusTeardown = null
    if (SP.disqus && typeof SP.disqus.mount === 'function') {
      disqusTeardown = SP.disqus.mount(commentsHost, {
        threadId:    lessonId,
        threadTitle: data.goal && data.goal.vi ? data.goal.vi : lessonId,
        threadUrl:   'https://signpath.netlify.app/app.html#lesson/' + encodeURIComponent(lessonId),
      })
    }

    host.appendChild(topbar)
    host.appendChild(header)
    host.appendChild(modeBar)
    host.appendChild(contentHost)
    host.appendChild(commentsSection)
    return { teardown() {
      if (quizFeedbackTimer) { clearTimeout(quizFeedbackTimer); quizFeedbackTimer = null }
      if (disqusTeardown) { try { disqusTeardown() } catch(_) {} disqusTeardown = null }
    } }
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
