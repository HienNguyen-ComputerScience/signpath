/**
 * Disqus comments embed — one thread per lesson chapter.
 *
 * Public API (attached to SP.disqus):
 *   mount(container, { threadId, threadTitle, threadUrl }) → teardown()
 *
 * Disqus's embed.js is loaded exactly once (lazy, on first visible mount)
 * and reused. Re-mounts with a different threadId call DISQUS.reset(),
 * which is Disqus's documented SPA-navigation pattern.
 *
 * Rendering is gated by IntersectionObserver so the iframe doesn't load
 * until the user scrolls the comments into view.
 *
 * Graceful degradation:
 *   - Empty / placeholder shortname → Vietnamese "being set up" notice.
 *   - embed.js failure or 10s timeout → Vietnamese "could not load" notice.
 */
;(function() {
  'use strict'

  const SP = window.SP = window.SP || {}

  // ── Config ────────────────────────────────────────────────────────
  const DISQUS_SHORTNAME = 'sign-4'

  const EMBED_TIMEOUT_MS = 10000
  const PLACEHOLDER_SHORTNAMES = new Set(['', 'YOUR_SHORTNAME_HERE', 'example'])

  // ── Module-level singleton state ──────────────────────────────────
  // The Disqus embed script is global (window.DISQUS), so we must track
  // it at module scope, not per-mount.
  const state = {
    scriptStatus: 'idle',    // 'idle' | 'loading' | 'loaded' | 'failed'
    scriptEl: null,
    currentThreadId: null,
    pendingConfig: null,     // latest { threadId, threadTitle, threadUrl }
    activeContainer: null,   // the DOM node currently hosting #disqus_thread
  }

  // window.disqus_config is a function Disqus calls before each reset /
  // first embed. It must read from module state because Disqus captures
  // a *reference* to it, not a snapshot.
  function installDisqusConfig() {
    window.disqus_config = function() {
      const cfg = state.pendingConfig
      if (!cfg) return
      this.page.identifier = cfg.threadId
      this.page.title = cfg.threadTitle
      this.page.url = cfg.threadUrl
    }
  }

  function isShortnameUsable() {
    return !!DISQUS_SHORTNAME && !PLACEHOLDER_SHORTNAMES.has(DISQUS_SHORTNAME)
  }

  function renderPlaceholder(container, message) {
    container.innerHTML = ''
    const note = SP.h('div', { style:{
      padding:'2rem 1.5rem', textAlign:'center',
      color:'var(--sp-on-surface-variant)',
      background:'var(--sp-surface-container-low)',
      borderRadius:'var(--sp-r-md)',
      fontSize:'.9375rem',
    }}, message)
    container.appendChild(note)
  }

  // ── Embed.js loader (once per page) ───────────────────────────────
  function loadEmbedScript() {
    return new Promise((resolve, reject) => {
      if (state.scriptStatus === 'loaded') { resolve(); return }
      if (state.scriptStatus === 'failed') { reject(new Error('embed.js previously failed')); return }
      if (state.scriptStatus === 'loading') {
        // Attach listeners to the in-flight script.
        state.scriptEl.addEventListener('load', () => resolve(), { once:true })
        state.scriptEl.addEventListener('error', () => reject(new Error('embed.js error')), { once:true })
        return
      }

      state.scriptStatus = 'loading'
      const s = document.createElement('script')
      s.src = 'https://' + DISQUS_SHORTNAME + '.disqus.com/embed.js'
      s.setAttribute('data-timestamp', String(Date.now()))
      s.async = true

      const timeoutId = setTimeout(() => {
        if (state.scriptStatus !== 'loading') return
        state.scriptStatus = 'failed'
        reject(new Error('embed.js timeout'))
      }, EMBED_TIMEOUT_MS)

      s.onload = () => {
        clearTimeout(timeoutId)
        state.scriptStatus = 'loaded'
        resolve()
      }
      s.onerror = () => {
        clearTimeout(timeoutId)
        state.scriptStatus = 'failed'
        reject(new Error('embed.js onerror'))
      }

      state.scriptEl = s
      ;(document.head || document.body).appendChild(s)
    })
  }

  // ── Ensure a #disqus_thread div exists inside the container ──────
  function prepareThreadDiv(container) {
    container.innerHTML = ''
    const div = document.createElement('div')
    div.id = 'disqus_thread'
    container.appendChild(div)
    state.activeContainer = container
    return div
  }

  // ── Mount / remount ──────────────────────────────────────────────
  function mount(container, opts) {
    if (!container) return function teardown() {}
    opts = opts || {}
    const threadId    = String(opts.threadId || '')
    const threadTitle = String(opts.threadTitle || '')
    const threadUrl   = String(opts.threadUrl || '')

    // Graceful degradation path 1: shortname unset.
    if (!isShortnameUsable()) {
      renderPlaceholder(container, 'Bình luận đang được thiết lập')
      return function teardown() { container.innerHTML = '' }
    }

    let observer = null
    let torn = false

    // Loading stub while we wait for IntersectionObserver to fire. Kept
    // deliberately light — just a spinner-less notice.
    container.innerHTML = ''
    const stub = SP.h('div', { style:{
      padding:'1.5rem', textAlign:'center',
      color:'var(--sp-on-surface-variant)', fontSize:'.875rem',
    }}, 'Đang tải bình luận…')
    container.appendChild(stub)

    function doEmbed() {
      if (torn) return
      state.pendingConfig = { threadId, threadTitle, threadUrl }
      installDisqusConfig()

      // Same thread already rendered in this container → nothing to do.
      // (Lesson re-renders on every mode toggle; idempotency prevents
      // the quiz/flashcard flip from dropping the existing thread.)
      if (state.scriptStatus === 'loaded'
          && state.currentThreadId === threadId
          && state.activeContainer === container
          && container.querySelector('#disqus_thread')) {
        return
      }

      prepareThreadDiv(container)

      if (state.scriptStatus === 'loaded' && window.DISQUS && typeof window.DISQUS.reset === 'function') {
        // SPA-navigation reset path (documented by Disqus).
        try {
          window.DISQUS.reset({
            reload: true,
            config: function() {
              const cfg = state.pendingConfig
              if (!cfg) return
              this.page.identifier = cfg.threadId
              this.page.title = cfg.threadTitle
              this.page.url = cfg.threadUrl
            },
          })
          state.currentThreadId = threadId
        } catch (_) {
          renderPlaceholder(container, 'Không thể tải bình luận — vui lòng thử lại sau')
        }
        return
      }

      // First load — inject embed.js.
      loadEmbedScript().then(() => {
        if (torn) return
        state.currentThreadId = threadId
        // embed.js auto-initialises using the #disqus_thread div + window.disqus_config.
      }).catch(() => {
        if (torn) return
        renderPlaceholder(container, 'Không thể tải bình luận — vui lòng thử lại sau')
      })
    }

    // Lazy gate. If IntersectionObserver is unavailable (very old
    // browsers / JSDOM), fall back to immediate embed.
    if (typeof IntersectionObserver === 'function') {
      observer = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            if (observer) { observer.disconnect(); observer = null }
            doEmbed()
            break
          }
        }
      }, { rootMargin: '200px' })
      observer.observe(container)
    } else {
      doEmbed()
    }

    return function teardown() {
      torn = true
      if (observer) { try { observer.disconnect() } catch(_) {} observer = null }
      // Only wipe our own container — never attempt to unload Disqus
      // globally (it doesn't support that, and other embeds elsewhere on
      // the page might still be active in future).
      if (state.activeContainer === container) state.activeContainer = null
      try { container.innerHTML = '' } catch(_) {}
    }
  }

  SP.disqus = {
    mount: mount,
    SHORTNAME: DISQUS_SHORTNAME,
  }
})();
