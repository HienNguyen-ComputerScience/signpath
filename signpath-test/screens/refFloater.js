/**
 * Floating reference-video card for the gesture-nav layout (WIP).
 *
 * Absolutely positioned inside its parent camera container. Draggable
 * anywhere, snaps to the nearest of 4 corners on release. Minimize
 * button shrinks it to a ~52px chip. Corner + minimized state persist
 * via app.progression.setUIPreference.
 *
 * Call site: mounted from SP.practiceUI.buildAttemptUI when the caller
 * does NOT pass hideReferenceVideo:true — skiptest and placement
 * continue to pass hideReferenceVideo and therefore see no floater.
 */
;(function() {
  'use strict'

  const SP = window.SP = window.SP || {}

  const INSET = 8                // minimum pixel gap from the camera edge
  const MINI_SIZE = 52
  const EXPANDED_WIDTH = 260
  const EXPANDED_MAX_HEIGHT = 280
  // Legacy corner → {x,y} resolver used only to migrate users whose
  // persisted state is still shaped { refFloaterCorner } (no x/y).
  const LEGACY_CORNER_OFFSETS = {
    tl: { fromLeft: true,  fromTop: true  },
    tr: { fromLeft: false, fromTop: true  },
    bl: { fromLeft: true,  fromTop: false },
    br: { fromLeft: false, fromTop: false },
  }

  /**
   * Mount a floater on `container`. `container` must be position:relative
   * (the practice wrap already is). Returns { teardown }.
   *
   * opts:
   *   signKey      — reference video key
   *   getPosition  — () => { x:number, y:number } | null  (pixels from container)
   *   setPosition  — (x, y) => void                       (persist exact coords)
   *   getCorner    — () => 'tl'|'tr'|'bl'|'br' | null     (legacy migration only)
   *   getMinimized — () => boolean
   *   setMinimized — (bool) => void
   */
  function mount(container, opts) {
    opts = opts || {}
    const signKey = opts.signKey
    let minimized = !!(opts.getMinimized && opts.getMinimized())
    let dragging = false
    let dragOffsetX = 0, dragOffsetY = 0
    // Persisted position — may be null on first mount for new users or
    // users with only the legacy corner value; we resolve against the
    // container size after layout stabilises.
    let posX = null, posY = null
    const stored = (opts.getPosition && opts.getPosition()) || null
    if (stored && typeof stored.x === 'number' && typeof stored.y === 'number') {
      posX = stored.x; posY = stored.y
    }

    const root = document.createElement('div')
    root.className = 'sp-ref-floater'
    root.setAttribute('aria-label', 'Video mẫu · Reference')
    // CSS variables we need up-front; style is applied inline rather than
    // via a separate stylesheet so the WIP branch doesn't touch CSS files.
    Object.assign(root.style, {
      position: 'absolute',
      zIndex: '6',
      width: EXPANDED_WIDTH + 'px',
      maxHeight: EXPANDED_MAX_HEIGHT + 'px',
      background: 'rgba(28, 26, 22, 0.88)',
      color: '#fff',
      borderRadius: '.75rem',
      padding: '.5rem .625rem .625rem',
      boxShadow: '0 8px 22px rgba(0,0,0,.45)',
      display: 'flex',
      flexDirection: 'column',
      gap: '.375rem',
      cursor: 'move',
      userSelect: 'none',
      transition: 'width .2s ease, height .2s ease',
    })

    const minBtn = document.createElement('button')
    minBtn.setAttribute('aria-label', 'Thu nhỏ · Minimize')
    minBtn.dataset.role = 'minimize'
    minBtn.className = 'sp-ref-floater-minbtn'
    Object.assign(minBtn.style, {
      background: 'transparent', border: 'none',
      color: '#fff', cursor: 'pointer',
      padding: '.125rem .25rem', marginLeft: 'auto',
      display: 'inline-flex', alignItems: 'center',
      fontFamily: 'inherit', opacity: '.85',
    })
    minBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size:1.125rem">close_fullscreen</span>'
    minBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      setMinimized(!minimized)
    })

    const header = document.createElement('div')
    header.dataset.role = 'header'
    Object.assign(header.style, {
      display: 'flex', alignItems: 'center', gap: '.375rem',
      fontSize: '.625rem', fontWeight: '700', letterSpacing: '.5px',
      textTransform: 'uppercase', opacity: '.85',
      padding: '.125rem 0',
    })
    const headerText = document.createElement('span')
    headerText.textContent = 'Video mẫu · Reference'
    header.appendChild(headerText)
    header.appendChild(minBtn)
    root.appendChild(header)

    // Video body. Built on expand so the <video> isn't cluttering the
    // DOM while minimized. Speed chips overlay inside the video's own
    // wrapper, just under the "VIDEO MẪU" header, so the expanded card
    // is video-only with no speed row hanging off the bottom.
    const bodyWrap = document.createElement('div')
    bodyWrap.dataset.role = 'body'
    Object.assign(bodyWrap.style, { display: 'flex', flexDirection: 'column', gap: '.375rem' })
    const refVideoEl = SP.videoEl(signKey, { preload: 'auto' })
    refVideoEl.style.aspectRatio = '1/1'
    refVideoEl.style.borderRadius = '.5rem'
    refVideoEl.style.overflow = 'hidden'
    refVideoEl.style.position = 'relative'

    const speedRow = document.createElement('div')
    speedRow.dataset.role = 'speed'
    Object.assign(speedRow.style, {
      position: 'absolute', top: '.375rem', left: '50%',
      transform: 'translateX(-50%)',
      display: 'flex', gap: '.25rem', zIndex: '2',
      padding: '.1875rem .375rem',
      background: 'rgba(26, 8, 4, 0.65)',
      borderRadius: '9999px',
      backdropFilter: 'blur(4px)',
    })
    speedRow.appendChild(buildSpeedBtn(refVideoEl, 0.5, '0.5×'))
    speedRow.appendChild(buildSpeedBtn(refVideoEl, 0.75, '0.75×', true))
    speedRow.appendChild(buildSpeedBtn(refVideoEl, 1.0, '1×'))
    refVideoEl.appendChild(speedRow)

    bodyWrap.appendChild(refVideoEl)
    root.appendChild(bodyWrap)

    // Minimized chip icon lives in the header via the minBtn when expanded
    // and takes over the whole card when minimized (styled below).
    const miniIcon = document.createElement('span')
    miniIcon.className = 'material-symbols-outlined'
    miniIcon.style.cssText = 'font-size:1.5rem; display:none;'
    miniIcon.textContent = 'smart_display'
    root.appendChild(miniIcon)

    container.appendChild(root)
    applyMinimizedStyle()
    // Practice builds its tree detached and only attaches to the DOM
    // after mount returns, so getBoundingClientRect is 0×0 right now
    // and any clamp collapses to INSET. Defer the first positioning
    // one frame so layout has run and we clamp against real bounds.
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(initialisePosition)
    } else {
      setTimeout(initialisePosition, 0)
    }

    function initialisePosition() {
      if (posX == null || posY == null) {
        const parentRect = container.getBoundingClientRect()
        const w = currentWidth(), h = currentHeight()
        const legacyCorner = (opts.getCorner && opts.getCorner()) || 'br'
        const layout = LEGACY_CORNER_OFFSETS[legacyCorner] || LEGACY_CORNER_OFFSETS.br
        posX = layout.fromLeft ? INSET : Math.max(INSET, parentRect.width  - w - INSET)
        posY = layout.fromTop  ? INSET : Math.max(INSET, parentRect.height - h - INSET)
        savePosition()
      }
      applyPosition()
    }

    function currentWidth()  { return minimized ? MINI_SIZE : EXPANDED_WIDTH }
    function currentHeight() {
      if (minimized) return MINI_SIZE
      // getBoundingClientRect is the most accurate, but during initial
      // mount the element may not have been painted yet.
      return root.offsetHeight || EXPANDED_MAX_HEIGHT
    }

    function clampToContainer(x, y) {
      const parentRect = container.getBoundingClientRect()
      const w = currentWidth(), h = currentHeight()
      const maxX = Math.max(INSET, parentRect.width  - w - INSET)
      const maxY = Math.max(INSET, parentRect.height - h - INSET)
      return {
        x: Math.min(maxX, Math.max(INSET, x)),
        y: Math.min(maxY, Math.max(INSET, y)),
      }
    }

    function applyPosition() {
      // Render the clamped position but keep posX/posY as the user's
      // saved intent. If they saved on a wide screen and reload on a
      // narrow one, we display an in-bounds position without silently
      // rewriting storage — next time the container is wide enough,
      // the original position comes back.
      const c = clampToContainer(posX, posY)
      root.style.left = c.x + 'px'
      root.style.top  = c.y + 'px'
      root.style.right = ''
      root.style.bottom = ''
    }

    function savePosition() {
      if (opts.setPosition) opts.setPosition(posX, posY)
    }

    // ── Dragging ──────────────────────────────────────────────────────
    root.addEventListener('mousedown', onDragStart)
    root.addEventListener('touchstart', onDragStart, { passive: true })

    function onDragStart(e) {
      // Ignore when the user clicks a child interactive element — speed
      // chips and the minimize button must keep working.
      const target = e.target
      if (target && target.closest) {
        if (target.closest('.sp-speed-chip')) return
        if (target.closest('[data-role="minimize"]')) return
      }
      const p = pointFromEvent(e)
      if (!p) return
      dragging = true
      const rect = root.getBoundingClientRect()
      dragOffsetX = p.x - rect.left
      dragOffsetY = p.y - rect.top
      document.addEventListener('mousemove', onDragMove)
      document.addEventListener('mouseup', onDragEnd)
      document.addEventListener('touchmove', onDragMove, { passive: false })
      document.addEventListener('touchend', onDragEnd)
    }

    function onDragMove(e) {
      if (!dragging) return
      e.preventDefault && e.preventDefault()
      const p = pointFromEvent(e)
      if (!p) return
      const parentRect = container.getBoundingClientRect()
      const x = p.x - parentRect.left - dragOffsetX
      const y = p.y - parentRect.top  - dragOffsetY
      const c = clampToContainer(x, y)
      posX = c.x; posY = c.y
      root.style.left = posX + 'px'
      root.style.top  = posY + 'px'
    }

    function onDragEnd() {
      if (!dragging) return
      dragging = false
      document.removeEventListener('mousemove', onDragMove)
      document.removeEventListener('mouseup', onDragEnd)
      document.removeEventListener('touchmove', onDragMove)
      document.removeEventListener('touchend', onDragEnd)
      // Free positioning — stay wherever the cursor left us. Just clamp
      // and persist. No corner snap, no transition.
      applyPosition()
      savePosition()
    }

    function pointFromEvent(e) {
      if (e.touches && e.touches[0]) return { x: e.touches[0].clientX, y: e.touches[0].clientY }
      if (e.changedTouches && e.changedTouches[0]) return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY }
      if (typeof e.clientX === 'number') return { x: e.clientX, y: e.clientY }
      return null
    }

    // ── Minimize ──────────────────────────────────────────────────────
    function setMinimized(val) {
      minimized = !!val
      if (opts.setMinimized) opts.setMinimized(minimized)
      applyMinimizedStyle()
      // Size just changed — reclamp so the shrunken chip doesn't sit
      // outside the container bounds.
      applyPosition()
    }
    function applyMinimizedStyle() {
      if (minimized) {
        root.style.width = MINI_SIZE + 'px'
        root.style.maxHeight = MINI_SIZE + 'px'
        root.style.padding = '0'
        root.style.alignItems = 'center'
        root.style.justifyContent = 'center'
        root.style.borderRadius = '9999px'
        header.style.display = 'none'
        bodyWrap.style.display = 'none'
        miniIcon.style.display = 'inline-block'
        // Whole chip is tap-to-expand when minimized.
        root.onclick = onMiniClick
      } else {
        root.style.width = EXPANDED_WIDTH + 'px'
        root.style.maxHeight = EXPANDED_MAX_HEIGHT + 'px'
        root.style.padding = '.5rem .625rem .625rem'
        root.style.alignItems = ''
        root.style.justifyContent = ''
        root.style.borderRadius = '.75rem'
        header.style.display = 'flex'
        bodyWrap.style.display = 'flex'
        miniIcon.style.display = 'none'
        root.onclick = null
      }
    }
    function onMiniClick(e) {
      // Treat any click on the minimized chip (not a drag end) as expand.
      if (!dragging) setMinimized(false)
    }

    // Resize: clamp current position into the new bounds; never snap.
    const onResize = () => { applyPosition() }
    window.addEventListener('resize', onResize)

    return {
      teardown() {
        window.removeEventListener('resize', onResize)
        document.removeEventListener('mousemove', onDragMove)
        document.removeEventListener('mouseup', onDragEnd)
        document.removeEventListener('touchmove', onDragMove)
        document.removeEventListener('touchend', onDragEnd)
        if (root.parentNode) root.parentNode.removeChild(root)
      }
    }
  }

  function buildSpeedBtn(videoWrap, rate, label, selected) {
    const btn = document.createElement('button')
    btn.className = 'sp-speed-chip'
    btn.textContent = label
    Object.assign(btn.style, {
      background: selected ? 'rgba(246,138,47,.85)' : 'rgba(255,255,255,.12)',
      color: '#fff', border: 'none', cursor: 'pointer',
      fontFamily: 'inherit', fontSize: '.6875rem',
      padding: '.25rem .625rem', borderRadius: '9999px',
      fontWeight: '600',
    })
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const row = btn.parentElement
      if (row) Array.from(row.querySelectorAll('button')).forEach(b => {
        b.style.background = 'rgba(255,255,255,.12)'
      })
      btn.style.background = 'rgba(246,138,47,.85)'
      const v = videoWrap.querySelector('video')
      if (v) v.playbackRate = rate
    })
    if (selected) {
      setTimeout(() => {
        const v = videoWrap.querySelector('video')
        if (v) v.playbackRate = rate
      }, 100)
    }
    return btn
  }

  SP.refFloater = { mount }
})();
