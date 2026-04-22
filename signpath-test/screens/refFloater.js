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

  const CORNERS = ['tl', 'tr', 'bl', 'br']
  const INSET = 16               // pixels from the nearest camera edge
  const SNAP_MS = 300            // release → snap transition
  const MINI_SIZE = 52
  const EXPANDED_WIDTH = 260
  const EXPANDED_MAX_HEIGHT = 280

  /**
   * Mount a floater on `container`. `container` must be position:relative
   * (the practice wrap already is). Returns { teardown, setVisible }.
   *
   * opts:
   *   signKey     — reference video key
   *   getCorner   — () => 'tl'|'tr'|'bl'|'br'
   *   setCorner   — (corner) => void
   *   getMinimized— () => boolean
   *   setMinimized— (bool) => void
   */
  function mount(container, opts) {
    opts = opts || {}
    const signKey = opts.signKey
    let corner = (opts.getCorner && opts.getCorner()) || 'br'
    let minimized = !!(opts.getMinimized && opts.getMinimized())
    let dragging = false
    let dragStartX = 0, dragStartY = 0
    let dragOffsetX = 0, dragOffsetY = 0
    let snapHints = null

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
      transition: 'left ' + SNAP_MS + 'ms ease, top ' + SNAP_MS + 'ms ease, right ' + SNAP_MS + 'ms ease, bottom ' + SNAP_MS + 'ms ease, width .2s ease, height .2s ease',
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
    // DOM while minimized.
    const bodyWrap = document.createElement('div')
    bodyWrap.dataset.role = 'body'
    Object.assign(bodyWrap.style, { display: 'flex', flexDirection: 'column', gap: '.375rem' })
    const refVideoEl = SP.videoEl(signKey, { preload: 'auto' })
    refVideoEl.style.aspectRatio = '1/1'
    refVideoEl.style.borderRadius = '.5rem'
    refVideoEl.style.overflow = 'hidden'
    bodyWrap.appendChild(refVideoEl)

    const speedRow = document.createElement('div')
    speedRow.dataset.role = 'speed'
    Object.assign(speedRow.style, {
      display: 'flex', gap: '.25rem', justifyContent: 'center', marginTop: '.125rem',
    })
    speedRow.appendChild(buildSpeedBtn(refVideoEl, 0.5, '0.5×'))
    speedRow.appendChild(buildSpeedBtn(refVideoEl, 0.75, '0.75×', true))
    speedRow.appendChild(buildSpeedBtn(refVideoEl, 1.0, '1×'))
    bodyWrap.appendChild(speedRow)

    root.appendChild(bodyWrap)

    // Minimized chip icon lives in the header via the minBtn when expanded
    // and takes over the whole card when minimized (styled below).
    const miniIcon = document.createElement('span')
    miniIcon.className = 'material-symbols-outlined'
    miniIcon.style.cssText = 'font-size:1.5rem; display:none;'
    miniIcon.textContent = 'smart_display'
    root.appendChild(miniIcon)

    container.appendChild(root)
    applyCornerPosition()
    applyMinimizedStyle()

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
      root.style.transition = 'none'
      const rect = root.getBoundingClientRect()
      const parentRect = container.getBoundingClientRect()
      dragOffsetX = p.x - rect.left
      dragOffsetY = p.y - rect.top
      dragStartX = rect.left - parentRect.left
      dragStartY = rect.top - parentRect.top
      // Switch to left/top placement so the float point is explicit.
      root.style.left = dragStartX + 'px'
      root.style.top = dragStartY + 'px'
      root.style.right = ''
      root.style.bottom = ''
      document.addEventListener('mousemove', onDragMove)
      document.addEventListener('mouseup', onDragEnd)
      document.addEventListener('touchmove', onDragMove, { passive: false })
      document.addEventListener('touchend', onDragEnd)
      showSnapHints(true)
    }

    function onDragMove(e) {
      if (!dragging) return
      e.preventDefault && e.preventDefault()
      const p = pointFromEvent(e)
      if (!p) return
      const parentRect = container.getBoundingClientRect()
      let x = p.x - parentRect.left - dragOffsetX
      let y = p.y - parentRect.top - dragOffsetY
      // Keep the floater inside the container.
      const w = root.offsetWidth, h = root.offsetHeight
      x = Math.max(0, Math.min(x, parentRect.width - w))
      y = Math.max(0, Math.min(y, parentRect.height - h))
      root.style.left = x + 'px'
      root.style.top = y + 'px'
      updateSnapHighlight(x, y, w, h, parentRect.width, parentRect.height)
    }

    function onDragEnd() {
      if (!dragging) return
      dragging = false
      document.removeEventListener('mousemove', onDragMove)
      document.removeEventListener('mouseup', onDragEnd)
      document.removeEventListener('touchmove', onDragMove)
      document.removeEventListener('touchend', onDragEnd)
      const rect = root.getBoundingClientRect()
      const parentRect = container.getBoundingClientRect()
      const x = rect.left - parentRect.left
      const y = rect.top - parentRect.top
      corner = nearestCorner(x, y, rect.width, rect.height, parentRect.width, parentRect.height)
      if (opts.setCorner) opts.setCorner(corner)
      showSnapHints(false)
      root.style.transition = 'left ' + SNAP_MS + 'ms ease, top ' + SNAP_MS + 'ms ease, right ' + SNAP_MS + 'ms ease, bottom ' + SNAP_MS + 'ms ease, width .2s ease, height .2s ease'
      applyCornerPosition()
    }

    function pointFromEvent(e) {
      if (e.touches && e.touches[0]) return { x: e.touches[0].clientX, y: e.touches[0].clientY }
      if (e.changedTouches && e.changedTouches[0]) return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY }
      if (typeof e.clientX === 'number') return { x: e.clientX, y: e.clientY }
      return null
    }

    function nearestCorner(x, y, w, h, pw, ph) {
      const cx = x + w / 2, cy = y + h / 2
      const top = cy < ph / 2
      const left = cx < pw / 2
      return (top ? 't' : 'b') + (left ? 'l' : 'r')
    }

    function applyCornerPosition() {
      root.style.left = ''; root.style.top = ''; root.style.right = ''; root.style.bottom = ''
      if (corner === 'tl') { root.style.left = INSET + 'px'; root.style.top = INSET + 'px' }
      else if (corner === 'tr') { root.style.right = INSET + 'px'; root.style.top = INSET + 'px' }
      else if (corner === 'bl') { root.style.left = INSET + 'px'; root.style.bottom = INSET + 'px' }
      else                       { root.style.right = INSET + 'px'; root.style.bottom = INSET + 'px' }
    }

    // ── Snap hints (corner outlines) ──────────────────────────────────
    function showSnapHints(on) {
      if (on) {
        if (snapHints) return
        snapHints = CORNERS.map(c => {
          const hint = document.createElement('div')
          hint.dataset.corner = c
          const s = hint.style
          s.position = 'absolute'
          s.width = EXPANDED_WIDTH + 'px'
          s.height = '100px'
          s.pointerEvents = 'none'
          s.border = '2px dashed rgba(255,255,255,.35)'
          s.borderRadius = '.75rem'
          s.transition = 'border-color .15s'
          s.zIndex = '5'
          if (c === 'tl') { s.left = INSET + 'px'; s.top = INSET + 'px' }
          else if (c === 'tr') { s.right = INSET + 'px'; s.top = INSET + 'px' }
          else if (c === 'bl') { s.left = INSET + 'px'; s.bottom = INSET + 'px' }
          else                 { s.right = INSET + 'px'; s.bottom = INSET + 'px' }
          container.appendChild(hint)
          return hint
        })
      } else {
        if (snapHints) {
          snapHints.forEach(h => h.remove())
          snapHints = null
        }
      }
    }
    function updateSnapHighlight(x, y, w, h, pw, ph) {
      if (!snapHints) return
      const nearest = nearestCorner(x, y, w, h, pw, ph)
      snapHints.forEach(hint => {
        if (hint.dataset.corner === nearest) {
          hint.style.borderColor = 'rgba(246, 138, 47, 0.85)'
          hint.style.background = 'rgba(246, 138, 47, 0.08)'
        } else {
          hint.style.borderColor = 'rgba(255,255,255,.35)'
          hint.style.background = 'transparent'
        }
      })
    }

    // ── Minimize ──────────────────────────────────────────────────────
    function setMinimized(val) {
      minimized = !!val
      if (opts.setMinimized) opts.setMinimized(minimized)
      applyMinimizedStyle()
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

    // ── Resize → keep corner, recompute coordinates ───────────────────
    const onResize = () => { applyCornerPosition() }
    window.addEventListener('resize', onResize)

    return {
      teardown() {
        window.removeEventListener('resize', onResize)
        document.removeEventListener('mousemove', onDragMove)
        document.removeEventListener('mouseup', onDragEnd)
        document.removeEventListener('touchmove', onDragMove)
        document.removeEventListener('touchend', onDragEnd)
        showSnapHints(false)
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
