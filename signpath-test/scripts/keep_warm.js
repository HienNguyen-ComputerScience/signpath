/**
 * keep_warm.js — pings the deployed coach proxy every 10 minutes to keep its
 * Render free-tier container from spinning down.
 *
 * This is a secondary keep-warm on top of UptimeRobot (configured separately).
 * Runs only in the user's browser while the app tab is open.
 *
 * To enable, define a global `COACH_PROXY_URL` BEFORE this script loads, e.g.
 * in app.html:
 *
 *   <script>
 *     window.COACH_PROXY_URL = 'https://signpath-coach.onrender.com'
 *   </script>
 *   <script src="scripts/keep_warm.js"></script>
 *
 * Safe to include unconditionally. If `COACH_PROXY_URL` is absent or points
 * to localhost, the script no-ops — local dev is never pinged.
 */
;(function() {
  'use strict'

  const url = (typeof window !== 'undefined' && window.COACH_PROXY_URL) || null
  if (!url) return
  // Don't bother pinging a local dev server — it doesn't spin down.
  if (!/^https:\/\//.test(url)) return

  const INTERVAL_MS = 10 * 60 * 1000   // 10 minutes
  const TIMEOUT_MS  = 8 * 1000         // 8-second hard cap on the probe
  const HEALTH_URL  = url.replace(/\/+$/, '') + '/health'

  function ping() {
    // AbortController gives us a timeout — otherwise a stalled fetch can
    // leave a request hanging for the full 30-50s cold-start window and
    // stack up if the interval fires again.
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
    const timer = ctrl ? setTimeout(() => ctrl.abort(), TIMEOUT_MS) : null
    fetch(HEALTH_URL, {
      method: 'GET',
      cache: 'no-store',
      mode: 'cors',
      signal: ctrl ? ctrl.signal : undefined,
    })
      .catch(() => { /* offline, slow cold-start, or CORS — all fine to ignore */ })
      .finally(() => { if (timer) clearTimeout(timer) })
  }

  // Kick one off immediately on page load — warms the service while the
  // user is still on the home/onboarding screens, so by the time they
  // reach practice the coach is already responsive.
  ping()

  // Then every 10 minutes.
  const intervalId = setInterval(ping, INTERVAL_MS)

  // Pause pinging while the tab is in the background. Chrome throttles
  // setInterval in background tabs anyway, but this avoids spurious pings
  // if the user leaves the tab open overnight on a mobile browser.
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') ping()
    })
  }

  // Expose a manual trigger for the console and for tests.
  if (typeof window !== 'undefined') {
    window.SP_keepWarmPing = ping
    window.SP_keepWarmStop = () => clearInterval(intervalId)
  }
})();
