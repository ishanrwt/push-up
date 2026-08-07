/** Short rep beep via Web Audio API (no sound file needed). */

let audioCtx = null

function getCtx() {
  if (typeof window === 'undefined') return null
  const AC = window.AudioContext || window.webkitAudioContext
  if (!AC) return null
  if (!audioCtx) audioCtx = new AC()
  return audioCtx
}

/** Call from a user gesture (e.g. Start) so mobile browsers allow sound. */
export function unlockBeep() {
  const ctx = getCtx()
  if (!ctx) return
  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => {})
  }
}

/** Play a short beep when a full rep is counted. */
export function playRepBeep() {
  const ctx = getCtx()
  if (!ctx) return

  const go = () => {
    const t = ctx.currentTime
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()

    osc.type = 'sine'
    osc.frequency.setValueAtTime(880, t)

    gain.gain.setValueAtTime(0.0001, t)
    gain.gain.exponentialRampToValueAtTime(0.22, t + 0.015)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.14)

    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(t)
    osc.stop(t + 0.16)
  }

  if (ctx.state === 'suspended') {
    ctx.resume().then(go).catch(() => {})
  } else {
    go()
  }
}
