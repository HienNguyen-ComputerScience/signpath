/**
 * SignPath app bootstrap + hash router.
 *
 * Boot sequence:
 *   1. loadManifest()                  — reference-video index
 *   2. new SignPathApp()               — builds facade + all sub-modules
 *   3. app.init(engineVideo)           — requests camera, loads templates,
 *                                         MediaPipe Holistic, emits 'ready'
 *   4. wire global event forwarders    — home/lesson progress chips refresh
 *   5. route()                          — render first screen (onboarding or home)
 *
 * Hash route formats:
 *   #onboarding/1  #onboarding/2  #onboarding/3
 *   #home
 *   #lesson/greetings
 *   #practice/C%E1%BA%A3m%20%C6%A1n   (URL-encoded Vietnamese)
 *   #dictionary
 *   #progress
 */
;(function() {
  'use strict'

  const SP = window.SP

  // ── Boot ──────────────────────────────────────────────────────────
  let app = null
  let ready = false
  const screenHost = document.getElementById('sp-screen')
  const statusEl = document.getElementById('sp-engine-status')

  SP.getApp = () => app
  SP.isEngineReady = () => ready

  function setStatus(msg, tone) {
    if (!statusEl) return
    statusEl.textContent = msg
    statusEl.style.color = tone === 'err' ? 'var(--sp-error)'
                        : tone === 'ok'  ? 'var(--sp-primary)'
                        : 'var(--sp-on-surface-variant)'
  }

  // ── Router ────────────────────────────────────────────────────────
  let currentTeardown = null

  const ROUTES = {
    'onboarding/1': () => SP.screens.onboarding.render(1),
    'onboarding/2': () => SP.screens.onboarding.render(2),
    'onboarding/3': () => SP.screens.onboarding.render(3),
    'home':         () => SP.screens.home.render(),
    'dictionary':   () => SP.screens.dictionary.render(),
    'progress':     () => SP.screens.progress.render(),
  }

  function parseHash() {
    const raw = (location.hash || '').replace(/^#/, '')
    if (!raw) return { name: null }
    const parts = raw.split('/').map(decodeURIComponent)
    return { name: parts[0], params: parts.slice(1), raw }
  }

  function route() {
    const p = parseHash()

    // First-run gate: route to onboarding if not yet done.
    if (!SP.isOnboarded()) {
      if (!p.name || !p.name.startsWith('onboarding')) {
        location.hash = '#onboarding/1'
        return
      }
    }

    // Empty hash → default home.
    if (!p.name) {
      location.hash = '#home'
      return
    }

    // Teardown previous.
    if (currentTeardown) {
      try { currentTeardown() } catch(e) { console.warn('[route] teardown error', e) }
      currentTeardown = null
    }

    screenHost.classList.remove('sp-screen-enter')
    void screenHost.offsetWidth  // force reflow to restart animation
    screenHost.classList.add('sp-screen-enter')
    screenHost.innerHTML = ''

    // Handle param-bearing routes
    let res = null
    if (p.name === 'lesson'   && p.params[0]) res = SP.screens.lesson.render(p.params[0])
    else if (p.name === 'practice' && p.params[0]) res = SP.screens.practice.render(p.params[0])
    else if (ROUTES[p.name + '/' + (p.params[0] || '')]) res = ROUTES[p.name + '/' + p.params[0]]()
    else if (ROUTES[p.name]) res = ROUTES[p.name]()
    else {
      screenHost.innerHTML = '<div style="padding:4rem;text-align:center;">' +
                             '<h2>Không tìm thấy trang</h2><p>Route: ' + SP.escapeHTML(p.raw) + '</p>' +
                             '<a class="sp-btn sp-btn-primary" href="#home">Về trang chủ</a></div>'
      return
    }

    currentTeardown = (res && typeof res.teardown === 'function') ? res.teardown : null

    // Sidebar highlight
    const topLevel = p.name
    const simple = { onboarding: null, lesson: 'home', practice: 'home', home: 'home',
                     dictionary: 'dictionary', progress: 'progress' }[topLevel]
    SP.setActiveRoute(simple)

    window.scrollTo(0, 0)
  }

  SP.route = route
  SP.navigate = (hash) => {
    if (location.hash === hash) { route() } else { location.hash = hash }
  }

  // ── Global event wiring (level up toast, lesson unlocked, etc.) ───
  function wireGlobalEvents() {
    app.on('ready', data => {
      ready = true
      setStatus('✓ ' + data.signs + ' dấu, ' + data.lessons + ' chương', 'ok')
      // Re-render current screen so it can use the now-available engine data.
      route()
    })
    app.on('error', data => {
      setStatus('✗ ' + data.message, 'err')
      console.error('[engine error]', data)
    })

    app.on('level:up', d => SP.toast(`Lên cấp ${d.newLevel}! Level up to ${d.newLevel}!`, 4000))
    app.on('lesson:unlocked', d => SP.toast(`Mở khóa chương mới: ${d.lessonId}`, 3500))
    app.on('lesson:completed', d => SP.toast(`Hoàn thành chương: ${d.lessonId}!`, 4000))
    app.on('streak:updated', d => {
      if (d.didExtendToday && d.currentStreak > 1) {
        SP.toast(`Chuỗi ${d.currentStreak} ngày! 🔥`, 2500)
      }
    })
  }

  // ── Boot ──────────────────────────────────────────────────────────
  async function boot() {
    setStatus('Đang tải video mẫu…')
    await SP.loadManifest()
    const withVideo = Object.keys(SP.manifest.signs || {}).length
    setStatus(`${withVideo} video mẫu sẵn sàng`)

    setStatus('Đang khởi động engine…')
    try {
      app = new SignPathApp()
      window._spApp = app
    } catch (e) {
      setStatus('✗ ' + e.message, 'err')
      console.error(e)
      return
    }

    wireGlobalEvents()

    // Route once now (may show onboarding or a loading version of home).
    route()

    // Listen for hash changes (back/forward, clicks on # links).
    window.addEventListener('hashchange', route)

    // Kick off the heavy init (camera + MediaPipe). This is async and takes
    // a few seconds. The 'ready' event re-triggers route() when complete.
    try {
      await app.init(document.getElementById('sp-engine-video'))
    } catch (e) {
      setStatus('✗ ' + e.message, 'err')
      console.error('[engine init failed]', e)
    }
  }

  document.addEventListener('DOMContentLoaded', boot)
})();
