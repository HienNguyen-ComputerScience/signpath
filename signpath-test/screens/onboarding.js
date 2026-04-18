/**
 * Onboarding flow — 3 steps:
 *   1. Language choice (VI default)
 *   2. Camera permission
 *   3. First sign preview ("Cảm ơn") + Start Learning
 * Sets localStorage['signpath:onboarded']=true when user finishes.
 */
;(function() {
  'use strict'

  const SP = window.SP
  SP.screens = SP.screens || {}

  function goldenBg() {
    const bg = document.createElement('div')
    bg.style.cssText = `
      position: absolute; inset: 0; z-index: -1;
      background: radial-gradient(ellipse at top left, #f9eca6 0%, #fef8f1 40%),
                  radial-gradient(ellipse at bottom right, #f68a2f33 0%, #fef8f1 60%);
    `
    return bg
  }

  function skipSidebar() {
    document.getElementById('sp-sidebar').style.display = 'none'
    document.getElementById('sp-main').style.marginLeft = '0'
    document.getElementById('sp-main').style.width = '100%'
  }
  function restoreSidebar() {
    document.getElementById('sp-sidebar').style.display = ''
    document.getElementById('sp-main').style.marginLeft = ''
    document.getElementById('sp-main').style.width = ''
  }

  // ── Step 1: Language ──────────────────────────────────────────────
  function step1() {
    skipSidebar()
    const host = document.getElementById('sp-screen')
    host.innerHTML = ''

    const wrap = SP.h('div', { class: 'sp-screen-enter', style: {
      minHeight:'100vh', padding:'3rem 2rem', display:'flex',
      flexDirection:'column', alignItems:'center', justifyContent:'center',
      position:'relative',
    }})
    wrap.appendChild(goldenBg())

    const stepBadge = SP.h('div', { style: {
      background:'var(--sp-surface-container-low)', padding:'.5rem 1.25rem',
      borderRadius:'9999px', color:'var(--sp-on-surface-variant)',
      fontSize:'.75rem', letterSpacing:'1px', fontWeight:600,
    }}, 'BƯỚC 1 / 3 · STEP 1 OF 3')

    const title = SP.h('h1', { style: {
      fontSize:'3rem', fontWeight:800, color:'var(--sp-primary)',
      marginTop:'2rem', marginBottom:'.75rem', textAlign:'center',
      lineHeight:1.15,
    }}, 'Chào mừng đến SignPath')

    const subtitle = SP.h('p', { style: {
      fontSize:'1.25rem', color:'var(--sp-on-surface-variant)',
      textAlign:'center', maxWidth:'36rem', marginBottom:'3rem',
    }}, 'Welcome — choose your language to begin')

    const langCard = SP.h('div', { class: 'sp-card', style: { maxWidth:'36rem', width:'100%' }},
      SP.h('div', { style:{fontSize:'.875rem', color:'var(--sp-on-surface-variant)', marginBottom:'1rem', fontWeight:600}}, 'Ngôn ngữ / Language'),
      langOption('vi', 'Tiếng Việt', 'Vietnamese (primary)', true),
      langOption('en', 'English', 'English (secondary)', false),
    )

    function langOption(code, label, note, selected) {
      const btn = SP.h('button', {
        class: 'sp-lang-opt',
        'data-code': code,
        style: {
          display:'flex', alignItems:'center', justifyContent:'space-between',
          width:'100%', padding:'1.25rem 1.5rem',
          background: selected ? 'var(--sp-tertiary-fixed)' : 'transparent',
          border: selected ? '2px solid var(--sp-primary)' : '2px solid var(--sp-surface-container-high)',
          borderRadius:'.875rem', marginBottom:'.75rem',
          cursor:'pointer', fontFamily:'inherit',
          transition:'all .15s',
        },
        onclick: (e) => {
          // Toggle selection styling
          SP.$$('.sp-lang-opt', langCard).forEach(el => {
            const isMe = el === btn
            el.style.background = isMe ? 'var(--sp-tertiary-fixed)' : 'transparent'
            el.style.border = isMe ? '2px solid var(--sp-primary)' : '2px solid var(--sp-surface-container-high)'
          })
          // Persist to engine on continue (no setter until engine ready); store intention
          localStorage.setItem('signpath:preferredLang', code)
        }
      },
        SP.h('div', { style:{textAlign:'left'}},
          SP.h('div', { style:{fontSize:'1.125rem', fontWeight:700, color:'var(--sp-on-surface)'}}, label),
          SP.h('div', { style:{fontSize:'.875rem', color:'var(--sp-on-surface-variant)', marginTop:'.25rem'}}, note),
        ),
        SP.h('span', { class:'material-symbols-outlined filled', style:{color:'var(--sp-primary)'}}, 'radio_button_checked')
      )
      return btn
    }

    const continueBtn = SP.h('button', {
      class: 'sp-btn sp-btn-primary sp-btn-lg',
      style: { marginTop:'2rem', minWidth:'16rem' },
      onclick: () => { location.hash = '#onboarding/2' }
    },
      SP.h('span', {}, 'Tiếp tục'),
      SP.h('span', { class:'material-symbols-outlined' }, 'arrow_forward'),
    )

    wrap.appendChild(stepBadge)
    wrap.appendChild(title)
    wrap.appendChild(subtitle)
    wrap.appendChild(langCard)
    wrap.appendChild(continueBtn)
    host.appendChild(wrap)
  }

  // ── Step 2: Camera permission ─────────────────────────────────────
  function step2() {
    skipSidebar()
    const host = document.getElementById('sp-screen')
    host.innerHTML = ''

    const wrap = SP.h('div', { class: 'sp-screen-enter', style: {
      minHeight:'100vh', padding:'3rem 2rem', display:'flex',
      flexDirection:'column', alignItems:'center', justifyContent:'center', position:'relative',
    }})
    wrap.appendChild(goldenBg())

    const stepBadge = SP.h('div', { style: {
      background:'var(--sp-surface-container-low)', padding:'.5rem 1.25rem',
      borderRadius:'9999px', color:'var(--sp-on-surface-variant)',
      fontSize:'.75rem', letterSpacing:'1px', fontWeight:600,
    }}, 'BƯỚC 2 / 3 · STEP 2 OF 3')

    const icon = SP.h('div', { style: {
      width:'6rem', height:'6rem', borderRadius:'9999px',
      background:'linear-gradient(135deg, #954b00 0%, #f68a2f 100%)',
      color:'#fff', display:'flex', alignItems:'center', justifyContent:'center',
      marginTop:'2rem', marginBottom:'1.5rem', fontSize:'3rem',
    }},
      SP.h('span', { class:'material-symbols-outlined', style:{fontSize:'3rem'}}, 'videocam')
    )

    const title = SP.h('h1', { style:{fontSize:'2.5rem', fontWeight:800, color:'var(--sp-primary)', textAlign:'center', marginBottom:'.75rem'}},
      'Cho phép sử dụng camera')
    const subtitle = SP.h('p', { style:{fontSize:'1.125rem', color:'var(--sp-on-surface-variant)', textAlign:'center', maxWidth:'32rem', marginBottom:'2rem'}},
      'We need your camera to see your signs — nothing leaves your device.')

    const why = SP.h('details', { style:{ maxWidth:'36rem', width:'100%', marginBottom:'2rem' }},
      SP.h('summary', { style:{ cursor:'pointer', color:'var(--sp-primary)', fontWeight:600, padding:'.75rem 1rem' }},
        'Vì sao chúng tôi cần quyền này? · Why do we need this?'),
      SP.h('div', { class:'sp-card', style:{ marginTop:'.5rem' }},
        SP.h('p', { style:{marginBottom:'.75rem', color:'var(--sp-on-surface)'}},
          '• Camera được dùng để nhận diện cử chỉ tay của bạn trong thời gian thực.'),
        SP.h('p', { style:{marginBottom:'.75rem', color:'var(--sp-on-surface)'}},
          '• Mọi xử lý diễn ra ngay trên máy của bạn. Không video nào được tải lên máy chủ.'),
        SP.h('p', { style:{color:'var(--sp-on-surface)'}},
          '• All processing happens on your device. No video is uploaded anywhere.'),
      )
    )

    // [Fix 4] Framing guidance. The scoring pipeline normalizes landmarks to
    // the shoulder midpoint — if shoulders aren't visible the engine falls
    // back to a palm-based coordinate system that is incompatible with the
    // VSL400 templates and scores become meaningless. Set expectations here
    // so users start with correct framing; the practice screen shows a live
    // warning banner if shoulders drop out mid-attempt.
    const framingTip = SP.h('div', { class:'sp-card', style:{
      maxWidth:'36rem', width:'100%', marginBottom:'1.5rem',
      padding:'1rem 1.25rem', display:'flex', gap:'.75rem', alignItems:'flex-start',
      background:'var(--sp-tertiary-fixed)',
    }},
      SP.h('span', { class:'material-symbols-outlined', style:{ color:'var(--sp-tertiary)', flexShrink:0 }}, 'tips_and_updates'),
      SP.h('div', {},
        SP.h('div', { style:{ fontWeight:700, color:'var(--sp-on-tertiary-container)', marginBottom:'.25rem' }},
          'Mẹo đặt khung hình · Framing tips'),
        SP.h('div', { style:{ color:'var(--sp-on-surface)', fontSize:'.875rem', lineHeight:1.5 }},
          'Ngồi cách camera khoảng một sải tay. Đảm bảo cả hai vai đều nằm trong khung hình và ánh sáng đủ sáng.', SP.h('br',{}),
          SP.h('span', { style:{ color:'var(--sp-on-surface-variant)', fontSize:'.8125rem' }},
            'Sit at arm\'s length. Make sure both shoulders are in frame and there is enough light.'),
        ),
      ),
    )

    const statusLine = SP.h('div', { id:'cam-status', style:{minHeight:'1.5rem', color:'var(--sp-on-surface-variant)', marginBottom:'1rem'}})

    const grantBtn = SP.h('button', {
      class:'sp-btn sp-btn-primary sp-btn-lg',
      style:{ minWidth:'16rem' },
      onclick: async () => {
        const s = document.getElementById('cam-status')
        s.textContent = 'Đang yêu cầu quyền truy cập camera…'
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
          // Stop this probe stream; the engine will open its own.
          stream.getTracks().forEach(t => t.stop())
          s.textContent = '✓ Đã được cấp quyền / Permission granted'
          s.style.color = 'var(--sp-primary)'
          setTimeout(() => { location.hash = '#onboarding/3' }, 400)
        } catch (e) {
          s.innerHTML = '<span style="color:var(--sp-error)">✗ Không thể truy cập camera. Vui lòng cấp quyền trong cài đặt trình duyệt.</span>'
        }
      }
    },
      SP.h('span', { class:'material-symbols-outlined'}, 'videocam'),
      SP.h('span', {}, 'Cho phép & tiếp tục')
    )

    const skipLink = SP.h('button', {
      class:'sp-btn sp-btn-ghost sp-btn-sm',
      style:{ marginTop:'.75rem' },
      onclick: () => { location.hash = '#onboarding/3' }
    }, 'Bỏ qua / Skip for now')

    wrap.appendChild(stepBadge)
    wrap.appendChild(icon)
    wrap.appendChild(title)
    wrap.appendChild(subtitle)
    wrap.appendChild(why)
    wrap.appendChild(framingTip)
    wrap.appendChild(statusLine)
    wrap.appendChild(grantBtn)
    wrap.appendChild(skipLink)
    host.appendChild(wrap)
  }

  // ── Step 3: First sign preview ────────────────────────────────────
  function step3() {
    skipSidebar()
    const host = document.getElementById('sp-screen')
    host.innerHTML = ''

    const wrap = SP.h('div', { class: 'sp-screen-enter', style: {
      minHeight:'100vh', padding:'3rem 2rem', display:'flex',
      flexDirection:'column', alignItems:'center', justifyContent:'center', position:'relative',
    }})
    wrap.appendChild(goldenBg())

    const stepBadge = SP.h('div', { style: {
      background:'var(--sp-surface-container-low)', padding:'.5rem 1.25rem',
      borderRadius:'9999px', color:'var(--sp-on-surface-variant)',
      fontSize:'.75rem', letterSpacing:'1px', fontWeight:600,
    }}, 'BƯỚC 3 / 3 · STEP 3 OF 3')

    const title = SP.h('h1', { style:{fontSize:'2.5rem', fontWeight:800, color:'var(--sp-primary)', textAlign:'center', marginTop:'2rem', marginBottom:'.75rem'}},
      'Dấu đầu tiên của bạn')
    const subtitle = SP.h('p', { style:{fontSize:'1.125rem', color:'var(--sp-on-surface-variant)', textAlign:'center', marginBottom:'2.5rem'}},
      'Your first sign')

    // Video card for "Cảm ơn"
    const firstSign = 'Cảm ơn'
    const card = SP.h('div', { class:'sp-card', style:{ maxWidth:'30rem', width:'100%', padding:'1.5rem' }})
    const videoEl = SP.videoEl(firstSign, { preload: 'auto' })
    videoEl.style.aspectRatio = '4/3'
    videoEl.style.maxHeight = '22rem'
    card.appendChild(videoEl)
    const nameBlock = SP.h('div', { style:{ textAlign:'center', marginTop:'1.25rem' }},
      SP.h('div', { style:{ fontSize:'2rem', fontWeight:700, color:'var(--sp-on-surface)' }}, firstSign),
      SP.h('div', { style:{ fontSize:'1rem', color:'var(--sp-on-surface-variant)', marginTop:'.25rem' }}, 'Thank you'),
    )
    card.appendChild(nameBlock)

    const startBtn = SP.h('button', {
      class:'sp-btn sp-btn-primary sp-btn-lg',
      style:{ marginTop:'2rem', minWidth:'18rem' },
      onclick: () => {
        SP.setOnboarded()
        restoreSidebar()
        location.hash = '#home'
      }
    },
      SP.h('span', {}, 'Bắt đầu học / Start Learning'),
      SP.h('span', { class:'material-symbols-outlined filled'}, 'play_arrow'),
    )

    wrap.appendChild(stepBadge)
    wrap.appendChild(title)
    wrap.appendChild(subtitle)
    wrap.appendChild(card)
    wrap.appendChild(startBtn)
    host.appendChild(wrap)
  }

  SP.screens.onboarding = {
    render(step) {
      if (step === 1) step1()
      else if (step === 2) step2()
      else if (step === 3) step3()
      return { teardown: () => restoreSidebar() }
    }
  }
})();
