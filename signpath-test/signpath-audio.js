/**
 * SignPath Audio v1.0 — TTS + procedural sound effects
 * =====================================================
 * Speaks Vietnamese words for the sign being taught, and plays short
 * procedurally generated tones for score tiers. Zero external assets:
 * tones are synthesised on the fly with the Web Audio API.
 *
 * TONES (frequencies chosen to be musically distinct but all in-key of C):
 *   success   — C-E-G major triad arpeggio (523, 659, 784 Hz) @ ~400ms
 *   good      — single E5 tone (659 Hz) @ 150ms
 *   fail      — glide A4 → E4 (440 → 330 Hz) @ 300ms
 *   star      — octave + fifth bell (880 + 1320 Hz) @ 200ms
 *
 * TTS VOICE FALLBACK CHAIN:
 *   User-set voice (from setVoice) → first voice with lang 'vi-VN' →
 *   first voice with lang starting 'vi' → default voice (English) + warning.
 *
 * BROWSER GESTURE POLICY:
 *   speak() may be rejected by the browser until the user has interacted
 *   with the page. playTone() is similarly restricted in Safari. That's a
 *   browser rule, not our bug — we surface the error but don't throw.
 *
 * NODE BEHAVIOUR:
 *   All methods are no-ops (return immediately) when Web Audio / Speech
 *   APIs are unavailable. Makes the module safe to load in test harnesses.
 */
;(function(global) {
'use strict'

const LS_KEY_ENABLED = 'sp_audio_enabled'
const LS_KEY_VOICE = 'sp_audio_voice'

// ─── Tone definitions ────────────────────────────────────────────────

const TONES = {
  success: {
    kind: 'arpeggio',
    notes: [523.25, 659.25, 783.99],  // C5, E5, G5
    noteMs: 100,
    gap: 40,
    gain: 0.25,
  },
  good: {
    kind: 'note',
    freq: 659.25,  // E5
    ms: 150,
    gain: 0.25,
  },
  fail: {
    kind: 'glide',
    from: 440,     // A4
    to: 329.63,    // E4
    ms: 280,
    gain: 0.22,
  },
  star: {
    kind: 'bell',
    fundamental: 880,    // A5
    harmonics: [1, 1.5], // A5 + E6 (fifth above)
    ms: 250,
    gain: 0.2,
  },
}

function memoryStorage() {
  const mem = {}
  return {
    getItem(k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null },
    setItem(k, v) { mem[k] = String(v) },
    removeItem(k) { delete mem[k] },
  }
}

class SignPathAudio {
  constructor(opts) {
    opts = opts || {}
    this._storage = opts.storage
      || (typeof localStorage !== 'undefined' ? localStorage : memoryStorage())
    this._ctx = null
    this._voiceName = null
    this._enabled = true

    this._hasWebAudio = typeof global.AudioContext !== 'undefined'
      || typeof global.webkitAudioContext !== 'undefined'
    this._hasSpeech = typeof global.speechSynthesis !== 'undefined'
      && typeof global.SpeechSynthesisUtterance !== 'undefined'

    this._restoreSettings()
  }

  // ─── Settings ────────────────────────────────────────────────────────

  _restoreSettings() {
    try {
      const e = this._storage.getItem(LS_KEY_ENABLED)
      if (e === 'false') this._enabled = false
      const v = this._storage.getItem(LS_KEY_VOICE)
      if (v) this._voiceName = v
    } catch(_) { /* ignore */ }
  }

  setEnabled(b) {
    this._enabled = !!b
    try { this._storage.setItem(LS_KEY_ENABLED, this._enabled ? 'true' : 'false') } catch(_) {}
  }

  isEnabled() { return this._enabled }

  // ─── Speech ──────────────────────────────────────────────────────────

  /**
   * Speak text using the browser's SpeechSynthesis.
   * Resolves when speech ends (or immediately if audio is disabled / unavailable).
   * Never rejects — we'd rather swallow TTS failures than break the UI flow.
   */
  speak(text, lang) {
    lang = lang || 'vi'
    if (!this._enabled || !this._hasSpeech || !text) return Promise.resolve()

    const self = this
    return new Promise(function(resolve) {
      try {
        const SpeechCtor = global.SpeechSynthesisUtterance
        const utt = new SpeechCtor(String(text))
        const voice = self._pickVoice(lang)
        if (voice) utt.voice = voice
        // Setting lang helps engines pick pronunciation when voice is absent
        utt.lang = self._langCode(lang, voice)
        utt.rate = 0.95
        utt.onend = function() { resolve() }
        utt.onerror = function(e) {
          console.warn('[audio] speech error:', e && e.error)
          resolve()
        }
        global.speechSynthesis.speak(utt)
      } catch(e) {
        console.warn('[audio] speak failed:', e && e.message)
        resolve()
      }
    })
  }

  /** Returns array of voices matching `lang` (or all if lang omitted). */
  getAvailableVoices(lang) {
    if (!this._hasSpeech) return []
    let voices = []
    try { voices = global.speechSynthesis.getVoices() || [] } catch(_) { return [] }
    if (!lang) return voices.map(v => ({ name: v.name, lang: v.lang, default: v.default }))
    const wanted = lang.toLowerCase()
    return voices
      .filter(v => v.lang && v.lang.toLowerCase().indexOf(wanted) === 0)
      .map(v => ({ name: v.name, lang: v.lang, default: v.default }))
  }

  setVoice(voiceName) {
    this._voiceName = voiceName || null
    try {
      if (voiceName) this._storage.setItem(LS_KEY_VOICE, voiceName)
      else this._storage.removeItem(LS_KEY_VOICE)
    } catch(_) {}
  }

  _pickVoice(lang) {
    if (!this._hasSpeech) return null
    let voices = []
    try { voices = global.speechSynthesis.getVoices() || [] } catch(_) { return null }
    if (!voices.length) return null

    // 1. user's saved choice
    if (this._voiceName) {
      const v = voices.find(v => v.name === this._voiceName)
      if (v) return v
    }
    const wantedShort = (lang || 'vi').slice(0, 2).toLowerCase()
    // 2. exact vi-VN
    let v = voices.find(v => v.lang && v.lang.toLowerCase() === 'vi-vn')
    if (v) return v
    // 3. any vi*
    v = voices.find(v => v.lang && v.lang.toLowerCase().indexOf(wantedShort) === 0)
    if (v) return v
    // 4. anything mentioning vi in lang tag
    v = voices.find(v => v.lang && v.lang.toLowerCase().indexOf(wantedShort) !== -1)
    if (v) return v
    console.warn(`[audio] no ${wantedShort} voice found — falling back to default`)
    return null  // let the engine pick
  }

  _langCode(lang, voice) {
    if (voice && voice.lang) return voice.lang
    if (lang === 'vi') return 'vi-VN'
    if (lang === 'en') return 'en-US'
    return lang
  }

  // ─── Tones ───────────────────────────────────────────────────────────

  /**
   * Play a short tone for a score tier. Fire-and-forget.
   *   tier ∈ 'success' | 'good' | 'fail' | 'star'
   */
  playTone(tier) {
    if (!this._enabled || !this._hasWebAudio) return
    const def = TONES[tier]
    if (!def) return
    try {
      this._ensureContext()
      if (!this._ctx) return
      const now = this._ctx.currentTime
      switch (def.kind) {
        case 'note': this._scheduleNote(def.freq, now, def.ms / 1000, def.gain); break
        case 'arpeggio':
          def.notes.forEach((f, i) => {
            const t = now + i * (def.noteMs + def.gap) / 1000
            this._scheduleNote(f, t, def.noteMs / 1000, def.gain)
          })
          break
        case 'glide': this._scheduleGlide(def.from, def.to, now, def.ms / 1000, def.gain); break
        case 'bell':
          def.harmonics.forEach((h, i) => {
            this._scheduleNote(def.fundamental * h, now, def.ms / 1000, def.gain / (i + 1))
          })
          break
      }
    } catch(e) {
      console.warn('[audio] playTone failed:', e && e.message)
    }
  }

  _ensureContext() {
    if (this._ctx) return
    const Ctor = global.AudioContext || global.webkitAudioContext
    if (!Ctor) return
    try { this._ctx = new Ctor() } catch(_) { this._ctx = null }
  }

  _scheduleNote(freq, startAt, durSec, gain) {
    const ctx = this._ctx
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = freq
    // Short attack, exponential decay so it sounds plucked not flat.
    g.gain.setValueAtTime(0.0001, startAt)
    g.gain.exponentialRampToValueAtTime(gain, startAt + 0.015)
    g.gain.exponentialRampToValueAtTime(0.0001, startAt + durSec)
    osc.connect(g).connect(ctx.destination)
    osc.start(startAt)
    osc.stop(startAt + durSec + 0.02)
  }

  _scheduleGlide(fromF, toF, startAt, durSec, gain) {
    const ctx = this._ctx
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(fromF, startAt)
    osc.frequency.exponentialRampToValueAtTime(toF, startAt + durSec)
    g.gain.setValueAtTime(0.0001, startAt)
    g.gain.exponentialRampToValueAtTime(gain, startAt + 0.02)
    g.gain.exponentialRampToValueAtTime(0.0001, startAt + durSec)
    osc.connect(g).connect(ctx.destination)
    osc.start(startAt)
    osc.stop(startAt + durSec + 0.02)
  }

  /** For tests / teardown — release the AudioContext if one was created. */
  destroy() {
    if (this._ctx && typeof this._ctx.close === 'function') {
      try { this._ctx.close() } catch(_) {}
    }
    this._ctx = null
  }
}

global.SignPathAudio = SignPathAudio
global.SignPathAudio._internals = { TONES }

})(typeof window !== 'undefined' ? window : this);
