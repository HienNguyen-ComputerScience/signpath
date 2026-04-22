/**
 * About Us screen (#about).
 * Static text-only page: hero, project, team, tech stack, credits, footer.
 */
;(function() {
  'use strict'

  const SP = window.SP
  SP.screens = SP.screens || {}

  function render() {
    const host = document.getElementById('sp-screen')
    host.innerHTML = ''

    const app = SP.getApp()
    // Topbar mirrors the chrome shown on dictionary/progress when the
    // engine is ready; if not ready yet, skip the chips rather than block.
    let topbar
    if (app && SP.isEngineReady()) {
      const homeData = app.getHomeScreenData()
      topbar = SP.topbar({
        streak: homeData.streak.current, xp: homeData.user.xp,
        level: homeData.user.level, rank: homeData.user.rank,
      })
    } else {
      topbar = SP.topbar({ streak: 0, xp: 0 })
    }
    host.appendChild(topbar)

    const col = SP.h('section', { style:{
      maxWidth:'48rem', margin:'0 auto', padding:'2rem 1.5rem 4rem',
    }})
    host.appendChild(col)

    // ── Hero ──
    col.appendChild(SP.h('div', { style:{ marginBottom:'2.5rem' }},
      SP.h('h1', { style:{
        fontSize:'2.5rem', fontWeight:800, color:'var(--sp-primary)',
        marginBottom:'.5rem', lineHeight:1.1,
      }}, 'SignPath'),
      SP.h('p', { style:{
        fontSize:'1.125rem', color:'var(--sp-on-surface)',
        fontWeight:500, margin:'0 0 .25rem',
      }}, 'Học ngôn ngữ ký hiệu Việt Nam với phản hồi AI thời gian thực'),
      SP.h('p', { style:{
        fontSize:'.875rem', fontStyle:'italic',
        color:'var(--sp-on-surface-variant)', margin:0,
      }}, 'Learn Vietnamese Sign Language with real-time AI feedback'),
    ))

    // ── Về dự án · About the project ──
    col.appendChild(sectionHeading('Về dự án · About the project'))
    col.appendChild(body(
      'SignPath là ứng dụng học Ngôn ngữ Ký hiệu Việt Nam (VSL) sử dụng thị giác máy tính và trí tuệ nhân tạo để chấm điểm từng lần thực hiện dấu của người học và đưa ra lời khuyên bằng tiếng Việt trong thời gian thực.'
    ))
    col.appendChild(body([
      'Ứng dụng được xây dựng cho cuộc thi ', strong('AI Young Guru 2026'),
      '. Mục tiêu của nhóm là tạo ra một công cụ học VSL mà người học có thể sử dụng ngay trên trình duyệt, không cần cài đặt, không cần phần cứng đặc biệt, và đặc biệt phù hợp với ngữ cảnh Việt Nam.',
    ]))
    col.appendChild(bodyMuted(
      'SignPath is a Vietnamese Sign Language learning web app that uses computer vision and AI to score each sign attempt and provide real-time feedback in Vietnamese. Built for the AI Young Guru 2026 contest, the app runs entirely in the browser — no installation, no special hardware — and is designed specifically for Vietnamese learners.'
    ))

    // ── Đội ngũ · The team ──
    col.appendChild(sectionHeading('Đội ngũ · The team'))
    col.appendChild(SP.h('p', { style:{
      fontSize:'.9375rem', fontWeight:600, color:'var(--sp-on-surface)',
      margin:'0 0 .75rem',
    }}, 'HAM — AI Young Guru 2026 finalist team'))
    col.appendChild(SP.h('ul', { style:{
      margin:'0 0 1.5rem', padding:'0 0 0 1.25rem',
      color:'var(--sp-on-surface)', fontSize:'1rem', lineHeight:1.7,
    }},
      SP.h('li', {}, 'Nguyễn Hy Hiền'),
      SP.h('li', {}, 'Nguyễn Minh Anh'),
      SP.h('li', {}, 'Hoàng Quang Minh'),
    ))

    // ── Công nghệ · Tech stack ──
    col.appendChild(sectionHeading('Công nghệ · Tech stack'))
    col.appendChild(SP.h('ul', { style:{
      margin:'0 0 1.5rem', padding:'0 0 0 1.25rem',
      color:'var(--sp-on-surface)', fontSize:'1rem', lineHeight:1.6,
    }},
      SP.h('li', { style:{ marginBottom:'.5rem' }},
        strong('MediaPipe Holistic'),
        ' cho phát hiện 162 điểm đặc trưng trên tay, tư thế, và khuôn mặt'),
      SP.h('li', { style:{ marginBottom:'.5rem' }},
        strong('Thuật toán chấm điểm tùy chỉnh'),
        ' được hiệu chuẩn trên 400 dấu VSL chuẩn theo 5 chiều ngôn ngữ học của Stokoe'),
      SP.h('li', { style:{ marginBottom:'.5rem' }},
        strong('Gemini 2.5 Flash'),
        ' sinh lời khuyên bằng tiếng Việt tự nhiên trong chưa đầy một giây'),
      SP.h('li', {},
        'Toàn bộ xử lý chạy trên trình duyệt — dữ liệu video không rời khỏi thiết bị người dùng'),
    ))

    // ── Cảm ơn · Acknowledgments ──
    col.appendChild(sectionHeading('Cảm ơn · Acknowledgments'))
    col.appendChild(body([
      'Dự án này được xây dựng dựa trên bộ dữ liệu ',
      strong('VSL400'),
      ' — ',
      SP.h('em', {}, 'A Multi-view Dataset for Vietnamese Word-Level Sign Language Recognition'),
      '. Cảm ơn các tác giả đã công khai nguồn dữ liệu chất lượng cao cho cộng đồng nghiên cứu VSL:',
    ]))
    col.appendChild(SP.h('p', { style:{
      fontSize:'.875rem', color:'var(--sp-on-surface-variant)',
      margin:'0 0 1rem', lineHeight:1.6,
    }}, 'Nguyen Quoc Trung, Pham Dang Khoi, Truong Duy Viet, Truong Hoang Vinh, Simon Bilik, Matej Sindelar, Jakub Stefansky, Adam Łysiak, Radek Martinek, và Petr Bilik.'))
    col.appendChild(body([
      'Cảm ơn cộng đồng ',
      strong('người khiếm thính Việt Nam'),
      ' đã đóng góp vào việc bảo tồn và phát triển ngôn ngữ ký hiệu.',
    ]))
    col.appendChild(bodyMuted(
      'This project is built on the VSL400 dataset — "A Multi-view Dataset for Vietnamese Word-Level Sign Language Recognition." Thanks to the authors for making this high-quality data publicly available to the VSL research community. Thanks to the Vietnamese deaf community for their ongoing work preserving and developing sign language.'
    ))

    // ── Footer row ──
    col.appendChild(SP.h('div', { style:{
      display:'flex', alignItems:'center', justifyContent:'space-between',
      flexWrap:'wrap', gap:'.75rem',
      marginTop:'2.5rem', paddingTop:'1.25rem',
      borderTop:'1px solid var(--sp-outline-variant)',
      fontSize:'.8125rem', color:'var(--sp-on-surface-variant)',
    }},
      SP.h('div', {}, 'v0.5 · Tháng 4, 2026'),
      SP.h('a', {
        href:'https://github.com/HienNguyen-ComputerScience/signpath',
        target:'_blank', rel:'noopener noreferrer',
        style:{
          display:'inline-flex', alignItems:'center', gap:'.375rem',
          color:'var(--sp-on-surface-variant)', textDecoration:'none',
        },
      },
        SP.h('span', { class:'material-symbols-outlined', style:{ fontSize:'1.125rem' }}, 'code'),
        SP.h('span', {}, 'Mã nguồn · Source code'),
      ),
    ))

    return { teardown() {} }
  }

  function sectionHeading(text) {
    return SP.h('h2', { style:{
      fontSize:'1.25rem', fontWeight:700, color:'var(--sp-on-surface)',
      marginTop:'2rem', marginBottom:'1rem',
    }}, text)
  }
  function body(content) {
    const p = SP.h('p', { style:{
      fontSize:'1rem', color:'var(--sp-on-surface)',
      lineHeight:1.65, margin:'0 0 1rem',
    }})
    appendInline(p, content)
    return p
  }
  function bodyMuted(text) {
    return SP.h('p', { style:{
      fontSize:'.9375rem', fontStyle:'italic',
      color:'var(--sp-on-surface-variant)',
      lineHeight:1.6, margin:'0 0 1.5rem',
    }}, text)
  }
  function strong(text) {
    return SP.h('strong', { style:{ fontWeight:700 }}, text)
  }
  function appendInline(parent, content) {
    if (Array.isArray(content)) {
      for (const c of content) appendInline(parent, c)
    } else if (content instanceof Node) {
      parent.appendChild(content)
    } else if (content != null) {
      parent.appendChild(document.createTextNode(String(content)))
    }
  }

  SP.screens.about = { render }
})();
