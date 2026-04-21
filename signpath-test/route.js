/**
 * Tiny route-predicate helper.
 * ===========================
 * Used by modals.js to decide whether to render a practice-result modal
 * on the current screen. The attempt:end event can arrive AFTER the user
 * has navigated away (e.g. they hit record, then clicked 'Từ điển' while
 * the 4s attempt was still running); without a guard the result modal
 * would pop up on the dictionary.
 *
 * Exported both as a window.SP property (browser <script>) and via
 * CommonJS so tests can import it directly.
 */
;(function() {
  'use strict'

  function isPracticeRoute(hash) {
    if (typeof hash !== 'string') return false
    // Matches "#practice/<anything>" and the bare "#practice".
    return hash === '#practice' || hash.indexOf('#practice/') === 0
  }

  if (typeof window !== 'undefined') {
    window.SP = window.SP || {}
    window.SP.isPracticeRoute = isPracticeRoute
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { isPracticeRoute }
  }
})();
