/**
 * SignPath Coach — AI-powered signing advice
 * ============================================
 * Takes structured deviation data from the engine and produces natural coaching advice.
 *
 * TWO MODES:
 *   1. LOCAL (always available, no config): rule-based translation of deviations → sentences.
 *      Call coach.getLocalAdvice(...) — instant, offline, free.
 *   2. REMOTE (optional, requires configuration): sends structured deviations to an LLM for
 *      more natural phrasing. Call coach.getAdvice(...) — throttled, cached.
 *
 * REMOTE PROVIDERS:
 *   Configure a provider via coach.setProvider({ endpoint, buildRequest, parseResponse }).
 *   Without a provider set, getAdvice() just returns null. (Browser can't call Anthropic
 *   directly due to CORS + header requirements — you need a proxy endpoint you control,
 *   or use Gemini/Groq via their browser-friendly endpoints with a key stashed somewhere.)
 *
 * Usage:
 *   const coach = new SignPathCoach()
 *
 *   // Optional — configure a remote provider (proxy to Gemini, Groq, Claude, etc.)
 *   coach.setProvider({
 *     endpoint: '/api/coach',         // your proxy
 *     buildRequest: (prompt, lang) => ({ body: { prompt, lang } }),
 *     parseResponse: (data) => data.text,
 *   })
 *
 *   engine.on('score', async (data) => {
 *     if (data.score < 70 && data.deviations) {
 *       const local = coach.getLocalAdvice(data.deviations, data.score, lang)
 *       showAdvice(local)  // instant
 *       const remote = await coach.getAdvice(data.deviations, data.score, lang, data.bufferFrames)
 *       if (remote) showAdvice(remote)  // upgrade when ready
 *     }
 *   })
 */
;(function(global) {
'use strict'

const COACH_COOLDOWN_MS = 4000  // minimum time between remote API calls
const COACH_SCORE_THRESHOLD = 75  // only coach when score is below this
const COACH_MIN_BUFFER = 25  // need this many frames before coaching makes sense

class SignPathCoach {
  constructor() {
    this._lastCallTime = 0
    this._lastAdvice = null
    this._lastSignKey = null
    this._pending = false
    this._cache = {}  // signKey+issueHash → advice (avoid redundant calls)
    this._provider = null  // { endpoint, buildRequest, parseResponse, headers? }
  }

  /**
   * Configure a remote coaching provider. Without this, getAdvice() returns null
   * and callers fall back to getLocalAdvice().
   *
   * @param {Object} provider
   * @param {string} provider.endpoint - URL to POST to
   * @param {Function} provider.buildRequest - (prompt, lang) => { headers?, body }
   * @param {Function} provider.parseResponse - (json) => string|null
   */
  setProvider(provider) {
    if (!provider || !provider.endpoint || typeof provider.buildRequest !== 'function' || typeof provider.parseResponse !== 'function') {
      console.warn('[coach] setProvider called with incomplete config — remote coaching disabled')
      this._provider = null
      return
    }
    this._provider = provider
  }

  /**
   * Get coaching advice for current deviations.
   * Returns null if no provider configured, on cooldown, score too high, or API unavailable.
   */
  async getAdvice(deviations, score, lang = 'vi', bufferFrames = 30) {
    if (!this._provider) return null  // [M-4] no remote calls unless explicitly configured
    if (!deviations) return null
    if (score >= COACH_SCORE_THRESHOLD) return null
    if (bufferFrames < COACH_MIN_BUFFER) return null
    if (this._pending) return null

    const now = performance.now()
    if (now - this._lastCallTime < COACH_COOLDOWN_MS) return this._lastAdvice

    // Build issue fingerprint for caching
    const issueKey = this._buildIssueKey(deviations)
    const cacheKey = `${deviations.signKey}:${issueKey}:${lang}`
    if (this._cache[cacheKey]) {
      this._lastAdvice = this._cache[cacheKey]
      return this._lastAdvice
    }

    const prompt = this._buildPrompt(deviations, score, lang)

    this._pending = true
    this._lastSignKey = deviations.signKey

    try {
      const req = this._provider.buildRequest(prompt, lang)
      const response = await fetch(this._provider.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(req.headers || {}) },
        body: JSON.stringify(req.body),
      })

      // [Y-1] Cooldown clock starts from call *completion*, not call *start*.
      // On slow networks this keeps actual request spacing >= COACH_COOLDOWN_MS.
      this._lastCallTime = performance.now()

      if (!response.ok) {
        console.warn('[coach] API error:', response.status)
        this._pending = false
        return null
      }

      const data = await response.json()
      const text = this._provider.parseResponse(data)
      if (text) {
        this._lastAdvice = text
        this._cache[cacheKey] = text
        // Keep cache small
        const keys = Object.keys(this._cache)
        if (keys.length > 50) delete this._cache[keys[0]]
      }
      this._pending = false
      return text
    } catch (e) {
      this._lastCallTime = performance.now()  // [Y-1] also on error, to avoid hammering
      console.warn('[coach] Request failed:', e.message)
      this._pending = false
      return null
    }
  }

  /**
   * Get instant local advice without API call.
   * Uses the deviation data to generate simple rule-based feedback.
   * Always available, no latency, no cost. Use as fallback or primary.
   */
  getLocalAdvice(deviations, score, lang = 'vi') {
    if (!deviations || score >= COACH_SCORE_THRESHOLD) return null

    const tips = []
    const vi = lang === 'vi'

    // Position issues
    for (const issue of (deviations.positionIssues || [])) {
      switch (issue) {
        case 'hand_too_low':
          tips.push(vi ? 'Đưa tay lên cao hơn.' : 'Raise your hand higher.'); break
        case 'hand_too_high':
          tips.push(vi ? 'Hạ tay xuống thấp hơn.' : 'Lower your hand.'); break
        case 'hand_too_right':
          tips.push(vi ? 'Dịch tay sang trái.' : 'Move your hand to the left.'); break
        case 'hand_too_left':
          tips.push(vi ? 'Dịch tay sang phải.' : 'Move your hand to the right.'); break
        case 'hand_too_far':
          tips.push(vi ? 'Đưa tay lại gần người hơn.' : 'Bring your hand closer to your body.'); break
        case 'hand_too_close':
          tips.push(vi ? 'Đưa tay ra xa người hơn.' : 'Move your hand further from your body.'); break
      }
    }

    // Finger issues (top 2 worst)
    for (const f of (deviations.worstFingers || [])) {
      const fname = vi ? f.nameVi : f.name
      if (f.issue === 'too_curled') {
        tips.push(vi ? `Duỗi ngón ${fname} thêm.` : `Extend your ${fname} finger more.`)
      } else if (f.issue === 'too_extended') {
        tips.push(vi ? `Cong ngón ${fname} vào.` : `Curl your ${fname} finger in.`)
      }
    }

    // Two-handed sign
    if (deviations.twoHanded?.issue === 'missing_second_hand') {
      tips.push(vi ? 'Ký hiệu này cần cả hai tay.' : 'This sign needs both hands.')
    }

    // Motion
    if (deviations.motion?.issue === 'too_still') {
      tips.push(vi ? 'Cần thêm chuyển động — đừng giữ yên tay.' : 'Add more movement — don\'t hold your hand still.')
    } else if (deviations.motion?.issue === 'too_much_motion') {
      tips.push(vi ? 'Bớt chuyển động — giữ tay ổn định hơn.' : 'Less movement — hold your hand more steady.')
    }

    // Face proximity
    if (deviations.faceProximity?.issue === 'hand_not_near_face') {
      tips.push(vi ? 'Đưa tay lại gần mặt hơn.' : 'Bring your hand closer to your face.')
    }

    if (tips.length === 0) {
      tips.push(vi ? 'Tiếp tục luyện tập — bạn đang tiến bộ!' : 'Keep practicing — you\'re improving!')
    }

    return tips.slice(0, 3).join(' ')
  }

  // ─── INTERNAL ──────────────────────────────────────────────────────

  _buildIssueKey(dev) {
    // Create a stable fingerprint of the current issues for caching
    const parts = []
    parts.push(...(dev.positionIssues || []))
    for (const f of (dev.worstFingers || [])) { if (f.issue) parts.push(`${f.name}:${f.issue}`) }
    if (dev.twoHanded?.issue) parts.push(dev.twoHanded.issue)
    if (dev.motion?.issue) parts.push(dev.motion.issue)
    if (dev.faceProximity?.issue) parts.push(dev.faceProximity.issue)
    return parts.sort().join('|') || 'none'
  }

  _buildPrompt(dev, score, lang) {
    const signName = dev.signKey
    const signEn = dev.signEn || dev.signKey

    // Structured deviation summary for the LLM
    const issues = []

    if (dev.positionIssues?.length) {
      const posMap = {
        'hand_too_low': 'hand is too low',
        'hand_too_high': 'hand is too high',
        'hand_too_right': 'hand is too far right',
        'hand_too_left': 'hand is too far left',
        'hand_too_far': 'hand is too far from body',
        'hand_too_close': 'hand is too close to body',
      }
      issues.push('Position: ' + dev.positionIssues.map(i => posMap[i] || i).join(', '))
    }

    if (dev.worstFingers?.length) {
      const fingerIssues = dev.worstFingers.map(f => {
        const dir = f.issue === 'too_curled' ? 'too curled (needs more extension)' : 'too extended (needs to curl in)'
        return `${f.name}: ${dir} (diff: ${f.extensionDiff})`
      })
      issues.push('Fingers: ' + fingerIssues.join('; '))
    }

    if (dev.twoHanded?.issue) {
      issues.push('Two-handed: sign requires both hands but only one hand detected')
    }

    if (dev.motion?.issue === 'too_still') {
      issues.push(`Motion: user is too still (user: ${dev.motion.userMotion}, reference: ${dev.motion.templateMotion})`)
    } else if (dev.motion?.issue === 'too_much_motion') {
      issues.push(`Motion: user is moving too much (user: ${dev.motion.userMotion}, reference: ${dev.motion.templateMotion})`)
    }

    if (dev.faceProximity?.issue) {
      issues.push(`Face proximity: hand should be near face (user distance: ${dev.faceProximity.userDist}, reference: ${dev.faceProximity.tmplDist})`)
    }

    const issueBlock = issues.length ? issues.join('\n') : 'Minor inaccuracies across multiple areas'

    const langInstruction = lang === 'vi'
      ? 'Respond in Vietnamese. Use casual, friendly tone (like a patient tutor). Address the student as "bạn".'
      : 'Respond in English. Use casual, friendly tone (like a patient tutor).'

    return `You are a Vietnamese Sign Language (VSL) coach helping a student practice the sign "${signName}" (${signEn}). Their current accuracy score is ${score}/100.

Here are the specific issues detected by comparing their hand positions to the reference:

${issueBlock}

${langInstruction}

Give exactly 1-2 short sentences of specific, actionable advice. Focus on the most impactful correction first. Be encouraging but precise. Do not explain what the sign means — just tell them how to fix their form. Do not use markdown formatting.`
  }

  clearCache() {
    this._cache = {}
    this._lastAdvice = null
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PROVIDER FACTORIES
// ═══════════════════════════════════════════════════════════════════════════
// Preconfigured providers you can pass to coach.setProvider().
//
// SECURITY: The Gemini factory accepts an API key directly. Only use it for
// local development or prototypes — in production, put the key behind a proxy
// so it doesn't ship in your bundle. Use createProxyProvider() for that.

/**
 * Gemini provider — calls Google AI Studio directly from the browser.
 * Gemini Flash has a browser-friendly endpoint that accepts the API key as a header.
 * Free tier as of 2026: ~1,500 req/day on 2.5 Flash.
 *
 * @param {string} apiKey - your Gemini API key
 * @param {string} [model='gemini-2.5-flash'] - model ID
 */
const createGeminiProvider = (apiKey, model = 'gemini-2.5-flash') => ({
  endpoint: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
  buildRequest: (prompt, lang) => ({
    headers: { 'x-goog-api-key': apiKey },
    body: {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 200 },
    },
  }),
  parseResponse: (data) => data?.candidates?.[0]?.content?.parts?.[0]?.text || null,
})

/**
 * Proxy provider — calls your own backend that holds the real API key.
 * Use this for anything public-facing. The proxy decides which LLM to use.
 *
 * Your proxy should accept POST with { prompt, lang } and return { text }.
 *
 * @param {string} endpoint - URL of your proxy
 */
const createProxyProvider = (endpoint) => ({
  endpoint,
  buildRequest: (prompt, lang) => ({ body: { prompt, lang } }),
  parseResponse: (data) => data?.text || null,
})

global.SignPathCoach = SignPathCoach
global.SignPathCoach.createGeminiProvider = createGeminiProvider
global.SignPathCoach.createProxyProvider = createProxyProvider

})(typeof window !== 'undefined' ? window : this);
