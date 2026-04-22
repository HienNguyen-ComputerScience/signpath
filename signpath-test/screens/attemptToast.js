/**
 * Attempt-result toast (top-right slide-in) — replaces the post-attempt
 * center modal with a lighter-weight notifier that doesn't block the
 * camera feed.
 *
 * SP.attemptToast.show(opts)
 *   opts.passed      — true | false | null (null / undefined = aborted)
 *   opts.score       — integer 0..100 (ignored when aborted)
 *   opts.coachText   — short advice line; truncated to ~120 chars
 *   opts.onRetry     — called when user clicks "Thử lại"
 *   opts.onNext      — called when user clicks "Học tiếp"
 *   opts.onTimeout   — called when the toast auto-dismisses. Optional:
 *                      falls back to opts.onNext for backward compat, or
 *                      to a no-op for aborted toasts. Callers that want
 *                      different click-vs-timeout behavior (e.g. stay on
 *                      a failed sign instead of advancing) pass this
 *                      explicitly.
 *   opts.durationMs  — override default (4000 ms pass / 5500 ms fail / 4000 aborted)
 *
 * Aborted state shows no score and only a "Thử lại" button; auto-dismiss
 * for aborted is a no-op (the user hasn't moved forward yet, so we stay
 * on the current sign).
 *
 * The toast mounts into #sp-toast-mount (outside #sp-screen) so screen
 * teardown doesn't kill it. A hashchange listener auto-closes on
 * navigation — matches the spec's "air-tap Next / ArrowRight still
 * advances; toast autocloses on advance".
 */
;(function() {
  'use strict'

  const SP = window.SP
  SP.attemptToast = SP.attemptToast || {}

  const SLIDE_MS = 220

  let active = null

  function close() {
    if (!active) return
    const { el, timer } = active
    active = null
    if (timer) clearTimeout(timer)
    if (el && el.parentElement) {
      el.style.transform = 'translateX(110%)'
      el.style.opacity = '0'
      setTimeout(() => { if (el.parentElement) el.remove() }, SLIDE_MS + 20)
    }
  }
  SP.attemptToast.close = close

  function show(opts) {
    close()
    opts = opts || {}
    const aborted = opts.passed === null || opts.passed === undefined
    const passed = !aborted && !!opts.passed
    const score = (typeof opts.score === 'number' && !aborted) ? Math.round(opts.score) : null
    const coachText = typeof opts.coachText === 'string' ? opts.coachText : ''
    const durationMs = typeof opts.durationMs === 'number'
      ? opts.durationMs
      : (aborted ? 4000 : (passed ? 4000 : 5500))

    const mount = document.getElementById('sp-toast-mount')
    if (!mount) return { close }

    const accent = aborted ? 'var(--sp-on-surface-variant)'
                 : passed  ? 'var(--sp-tertiary)'
                           : 'var(--sp-error)'
    const header = aborted ? 'Đã hủy'
                 : passed  ? 'Đúng!'
                           : 'Thử lại'

    const toast = SP.h('div', {
      class: 'sp-attempt-toast',
      role: 'status', 'aria-live': 'polite',
      style: {
        position: 'fixed', top: '5rem', right: '1.25rem', zIndex: 9999,
        minWidth: '17.5rem', maxWidth: '21rem',
        background: 'var(--sp-surface)',
        color: 'var(--sp-on-surface)',
        borderLeft: '4px solid ' + accent,
        borderRadius: '.75rem',
        boxShadow: '0 12px 32px rgba(0,0,0,.22)',
        padding: '.875rem 1rem 1rem',
        transform: 'translateX(110%)',
        opacity: '0',
        transition: 'transform ' + SLIDE_MS + 'ms ease-out, opacity ' + SLIDE_MS + 'ms ease-out',
      },
    })

    toast.appendChild(SP.h('div', {
      style: {
        fontSize: '.9375rem', fontWeight: 800, letterSpacing: '.25px',
        color: accent, marginBottom: score !== null ? '.25rem' : '.5rem',
      }
    }, header))

    if (score !== null) {
      toast.appendChild(SP.h('div', {
        style: {
          fontSize: '2rem', fontWeight: 800, textAlign: 'center',
          lineHeight: 1.05, margin: '.125rem 0 .5rem',
          color: 'var(--sp-primary)',
        }
      }, score + '/100'))
    }

    if (coachText) {
      const truncated = coachText.length > 120 ? coachText.slice(0, 117) + '…' : coachText
      toast.appendChild(SP.h('div', {
        style: {
          fontSize: '.8125rem', color: 'var(--sp-on-surface-variant)',
          lineHeight: 1.4, marginBottom: '.75rem',
          display: '-webkit-box', WebkitLineClamp: '2', WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }
      }, truncated))
    }

    const actions = SP.h('div', {
      style: { display: 'flex', gap: '.375rem', justifyContent: 'flex-end' }
    })

    const btnStyle = {
      fontSize: '.8125rem', padding: '.375rem .75rem', fontFamily: 'inherit',
    }

    const retryBtn = SP.h('button', {
      class: 'sp-btn',
      style: btnStyle,
      onclick: () => { close(); if (opts.onRetry) opts.onRetry() },
    }, 'Thử lại')
    actions.appendChild(retryBtn)

    if (!aborted) {
      const nextBtn = SP.h('button', {
        class: 'sp-btn sp-btn-primary',
        style: btnStyle,
        onclick: () => { close(); if (opts.onNext) opts.onNext() },
      }, 'Học tiếp')
      actions.appendChild(nextBtn)
    }
    toast.appendChild(actions)

    mount.appendChild(toast)

    requestAnimationFrame(() => {
      toast.style.transform = 'translateX(0)'
      toast.style.opacity = '1'
    })

    const timer = setTimeout(() => {
      // Prefer an explicit onTimeout when the caller supplied one. This is
      // how practice distinguishes "fail timeout stays" from "pass timeout
      // advances"; skiptest/placement pass their advance closure explicitly
      // so the timeout behavior doesn't rely on onNext aliasing. Fallback
      // keeps backward compat: pass/fail default to onNext (advance),
      // aborted defaults to a no-op (stay).
      const dismissTarget = (typeof opts.onTimeout === 'function')
        ? opts.onTimeout
        : (aborted ? null : opts.onNext)
      if (toast.parentElement) {
        toast.style.transform = 'translateX(110%)'
        toast.style.opacity = '0'
        setTimeout(() => { if (toast.parentElement) toast.remove() }, SLIDE_MS + 20)
      }
      active = null
      if (dismissTarget) dismissTarget()
    }, durationMs)

    active = { el: toast, timer }
    return { close }
  }

  SP.attemptToast.show = show

  // Close on any route change so air-tap/keyboard navigation that bypasses
  // the toast still leaves it in a clean state.
  if (typeof window !== 'undefined') {
    window.addEventListener('hashchange', close)
  }
})();
