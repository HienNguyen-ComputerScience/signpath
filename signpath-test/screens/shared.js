/**
 * Shared helpers used by every screen.
 * Attached to window.SP so scripts don't need imports.
 */
;(function(global) {
  'use strict'

  const SP = global.SP = global.SP || {}

  // ── Reference-video manifest (populated during boot) ───────────────
  SP.manifest = { signs: {}, total: 0 }

  async function loadManifest() {
    try {
      const r = await fetch('reference_videos/manifest.json', { cache: 'no-store' })
      if (!r.ok) throw new Error('status ' + r.status)
      SP.manifest = await r.json()
    } catch (_) {
      SP.manifest = { signs: {}, total: 0, missing: true }
    }
    return SP.manifest
  }
  SP.loadManifest = loadManifest

  // ── URL for a reference video (URL-encoded Vietnamese filename) ────
  SP.refVideoUrl = function(signKey) {
    const entry = SP.manifest.signs && SP.manifest.signs[signKey]
    if (!entry) return null
    return 'reference_videos/' + encodeURIComponent(entry.file)
  }
  SP.hasRefVideo = function(signKey) {
    return !!(SP.manifest.signs && SP.manifest.signs[signKey])
  }

  // ── Localstorage helpers (UI-only state; backend uses sp3_*) ───────
  const LS = {
    onboarded:         'signpath:onboarded',
    lastLesson:        'signpath:lastLesson',
    recentlyPracticed: 'signpath:recentlyPracticed', // array of {key, ts}
  }
  SP.LS = LS

  SP.isOnboarded = () => localStorage.getItem(LS.onboarded) === 'true'
  SP.setOnboarded = () => localStorage.setItem(LS.onboarded, 'true')

  SP.getLastLesson = () => localStorage.getItem(LS.lastLesson) || null
  SP.setLastLesson = (id) => localStorage.setItem(LS.lastLesson, id)

  SP.pushRecent = function(signKey) {
    const raw = localStorage.getItem(LS.recentlyPracticed)
    let list = []
    try { list = raw ? JSON.parse(raw) : [] } catch(_) {}
    list = list.filter(r => r.key !== signKey)
    list.unshift({ key: signKey, ts: Date.now() })
    if (list.length > 10) list = list.slice(0, 10)
    localStorage.setItem(LS.recentlyPracticed, JSON.stringify(list))
  }
  SP.getRecent = function() {
    try { return JSON.parse(localStorage.getItem(LS.recentlyPracticed) || '[]') }
    catch(_) { return [] }
  }

  // ── Time-ago formatter (Vietnamese primary) ────────────────────────
  SP.timeAgo = function(ts) {
    const s = Math.max(1, Math.floor((Date.now() - ts) / 1000))
    if (s < 60)    return `${s} giây trước`
    const m = Math.floor(s / 60)
    if (m < 60)    return `${m} phút trước`
    const h = Math.floor(m / 60)
    if (h < 24)    return `${h} giờ trước`
    const d = Math.floor(h / 24)
    if (d < 7)     return `${d} ngày trước`
    return `${Math.floor(d / 7)} tuần trước`
  }

  // ── Diacritic-insensitive string search ────────────────────────────
  SP.deburr = function(s) {
    return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  }

  // ── DOM helpers ─────────────────────────────────────────────────────
  SP.h = function(tag, attrs, ...children) {
    const el = document.createElement(tag)
    if (attrs) for (const k in attrs) {
      if (k === 'class' || k === 'className') el.className = attrs[k]
      else if (k === 'style' && typeof attrs[k] === 'object') Object.assign(el.style, attrs[k])
      else if (k.startsWith('on') && typeof attrs[k] === 'function') el.addEventListener(k.slice(2), attrs[k])
      else if (k === 'html') el.innerHTML = attrs[k]
      else if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== false) el.setAttribute(k, attrs[k])
    }
    for (const c of children) {
      if (c === null || c === undefined || c === false) continue
      if (Array.isArray(c)) c.forEach(cc => el.appendChild(cc instanceof Node ? cc : document.createTextNode(String(cc))))
      else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)))
    }
    return el
  }
  SP.$ = (sel, root) => (root || document).querySelector(sel)
  SP.$$ = (sel, root) => Array.from((root || document).querySelectorAll(sel))
  SP.escapeHTML = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))

  // ── Star rendering ─────────────────────────────────────────────────
  SP.starsHTML = function(n, total) {
    total = total || 3
    const filled = Math.max(0, Math.min(total, n|0))
    let html = '<span class="sp-stars">'
    for (let i=0; i<filled; i++) html += '★'
    for (let i=filled; i<total; i++) html += '<span class="empty">★</span>'
    html += '</span>'
    return html
  }

  // ── Reference-video element (always autoplay, muted, loop) ─────────
  SP.videoEl = function(signKey, opts) {
    opts = opts || {}
    const url = SP.refVideoUrl(signKey)
    const wrap = document.createElement('div')
    wrap.className = 'sp-video-card' + (opts.extraClass ? ' ' + opts.extraClass : '')
    if (!url) {
      const fb = document.createElement('div')
      fb.className = 'sp-video-fallback'
      fb.innerHTML = '<div class="sp-title">' + SP.escapeHTML(signKey) + '</div>' +
                     '<div class="sp-note">Chưa có video</div>'
      wrap.appendChild(fb)
      return wrap
    }
    const v = document.createElement('video')
    v.src = url
    v.autoplay = true; v.muted = true; v.loop = true; v.playsInline = true
    v.setAttribute('playsinline', '')
    v.preload = opts.preload || 'metadata'
    if (opts.playbackRate) v.playbackRate = opts.playbackRate
    v.addEventListener('canplay', () => { v.play().catch(()=>{}) })
    wrap.appendChild(v)
    return wrap
  }

  // ── Score coloring helper ──────────────────────────────────────────
  SP.scoreColor = function(s) {
    if (s >= 80) return '#5a9a3c'
    if (s >= 60) return '#d4922a'
    if (s >= 30) return '#c9533a'
    return '#7f7a71'
  }
  SP.tierLabel = function(stars) {
    return ['Chưa đạt', 'Tốt', 'Rất tốt', 'Xuất sắc'][stars | 0] || ''
  }

  // ── Mastery label in Vietnamese ────────────────────────────────────
  SP.masteryLabel = function(m) {
    return ['Mới', 'Đang học', 'Quen thuộc', 'Thông thạo'][m | 0] || 'Mới'
  }

  // ── Toast ───────────────────────────────────────────────────────────
  SP.toast = function(message, durationMs) {
    const mount = document.getElementById('sp-toast-mount')
    if (!mount) return
    const el = document.createElement('div')
    el.className = 'sp-toast'
    el.textContent = message
    mount.appendChild(el)
    setTimeout(() => {
      el.style.transition = 'opacity .3s'
      el.style.opacity = '0'
      setTimeout(() => el.remove(), 320)
    }, durationMs || 2800)
  }

  // ── Sidebar active state ───────────────────────────────────────────
  SP.setActiveRoute = function(routeName) {
    document.querySelectorAll('.sp-sidebar-link').forEach(a => {
      a.classList.toggle('active', a.dataset.route === routeName)
    })
  }

  // ── Topbar (rendered per-screen that wants it) ─────────────────────
  SP.topbar = function({ streak, xp, masteredCount, rightExtras }) {
    return SP.h('header', { class: 'sp-topbar' },
      SP.h('div', { class: 'sp-topbar-brand' }, 'SignPath'),
      SP.h('div', { class: 'sp-topbar-actions' },
        rightExtras || null,
        SP.h('div', { class: 'sp-chip-streak', title: 'Chuỗi ngày' },
          SP.h('span', { class: 'material-symbols-outlined filled' }, 'local_fire_department'),
          SP.h('span', {}, String(streak == null ? 0 : streak))
        ),
        SP.h('div', { class: 'sp-chip-streak', title: 'Điểm kinh nghiệm', style: { color: 'var(--sp-primary)' } },
          SP.h('span', { class: 'material-symbols-outlined' }, 'bolt'),
          SP.h('span', {}, 'XP ' + (xp == null ? 0 : xp))
        ),
        SP.h('div', { class: 'sp-avatar', title: 'Người học' }, 'H')
      )
    )
  }

})(window);
