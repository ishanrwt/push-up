import { useEffect, useRef, useState } from 'react'
import {
  FilesetResolver,
  PoseLandmarker,
  DrawingUtils,
} from '@mediapipe/tasks-vision'

/**
 * Counting model from aryanvij02/PushUpCounter:
 *   form lock → direction half-reps (+0.5 down, +0.5 up) → display floor(count)
 * Plus plank-stance gate so standing waves / getting up don't count.
 */
const DOWN_ANGLE = 125
const UP_ANGLE = 150
const FORM_HOLD_FRAMES = 12
const EXTREME_FRAMES = 5
const MIN_FLIP_MS = 550 // min time between half-rep flips (kills chatter)
const VIS_MIN = 0.15

const L = { shoulder: 11, elbow: 13, wrist: 15 }
const R = { shoulder: 12, elbow: 14, wrist: 16 }
const HIP_L = 23
const HIP_R = 24

function angleAt(a, b, c) {
  if (!a || !b || !c) return null
  const radians =
    Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(a.y - b.y, a.x - b.x)
  let deg = Math.abs((radians * 180) / Math.PI)
  if (deg > 180) deg = 360 - deg
  return deg
}

function vis(lm, i) {
  const v = lm[i]?.visibility
  return v == null ? 1 : v
}

function armsUsable(lm) {
  return [L.shoulder, L.elbow, L.wrist, R.shoulder, R.elbow, R.wrist].every(
    (i) => lm[i] && vis(lm, i) >= VIS_MIN,
  )
}

function elbowAvg(lm) {
  const left = angleAt(lm[L.shoulder], lm[L.elbow], lm[L.wrist])
  const right = angleAt(lm[R.shoulder], lm[R.elbow], lm[R.wrist])
  if (left == null || right == null) return null
  return { left, right, avg: (left + right) / 2 }
}

/**
 * Reject standing / waving / getting into position.
 * Pushup plank (front cam): wrists near floor level (at/below shoulders),
 * torso not upright.
 */
function pushupStance(lm) {
  const ls = lm[L.shoulder]
  const rs = lm[R.shoulder]
  const le = lm[L.elbow]
  const re = lm[R.elbow]
  const lw = lm[L.wrist]
  const rw = lm[R.wrist]

  // Y increases downward — waving arms overhead => wrist.y << shoulder.y
  if (lw.y < ls.y - 0.06 || rw.y < rs.y - 0.06) {
    return { ok: false, reason: 'Plank only — wrists down' }
  }
  if (le.y < ls.y - 0.1 || re.y < rs.y - 0.1) {
    return { ok: false, reason: 'Plank only — not waving' }
  }

  const shoulderY = (ls.y + rs.y) / 2
  const shoulderW = Math.abs(ls.x - rs.x)
  if (shoulderW < 0.12) {
    return { ok: false, reason: 'Square up to camera' }
  }

  // Standing: hips far below shoulders (tall vertical torso)
  if (vis(lm, HIP_L) >= 0.25 && vis(lm, HIP_R) >= 0.25) {
    const hipY = (lm[HIP_L].y + lm[HIP_R].y) / 2
    const torsoH = hipY - shoulderY
    if (torsoH > 0 && torsoH / shoulderW > 0.8) {
      return { ok: false, reason: 'Get into plank (not standing)' }
    }
  }

  return { ok: true, reason: '' }
}

async function openCamera(facingMode) {
  const baseVideo = { width: { ideal: 640 }, height: { ideal: 480 } }
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { ...baseVideo, facingMode: { exact: facingMode } },
    })
  } catch {
    return await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { ...baseVideo, facingMode: { ideal: facingMode } },
    })
  }
}

export default function PushupCounter({ onCountChange }) {
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const [status, setStatus] = useState('Loading pose model…')
  const [debug, setDebug] = useState({
    avg: '—',
    left: '—',
    right: '—',
    dir: '—',
    form: 0,
  })
  const [facingMode, setFacingMode] = useState('user')
  const [switching, setSwitching] = useState(false)

  // Repo state
  const formRef = useRef(0) // 0 until plank locked
  const directionRef = useRef(0) // 0 = next is down, 1 = next is up
  const halfCountRef = useRef(0) // increases by 0.5; display = floor
  const formHoldRef = useRef(0)
  const atDownFramesRef = useRef(0)
  const atUpFramesRef = useRef(0)
  const smoothRef = useRef(null)
  const lastFlipAtRef = useRef(0)

  const statusRef = useRef('Loading pose model…')
  const onCountChangeRef = useRef(onCountChange)
  const landmarkerRef = useRef(null)
  const streamRef = useRef(null)
  const rafIdRef = useRef(0)
  const lastVideoTimeRef = useRef(-1)
  const readyRef = useRef(false)
  const countingPausedRef = useRef(false)
  const debugTickRef = useRef(0)
  const lastEmittedRef = useRef(0)

  onCountChangeRef.current = onCountChange

  function updateStatus(next) {
    if (statusRef.current === next) return
    statusRef.current = next
    setStatus(next)
  }

  function emitCount() {
    const whole = Math.floor(halfCountRef.current)
    if (whole !== lastEmittedRef.current) {
      lastEmittedRef.current = whole
      onCountChangeRef.current?.(whole)
    }
  }

  function resetRepState() {
    formRef.current = 0
    directionRef.current = 0
    halfCountRef.current = 0
    formHoldRef.current = 0
    atDownFramesRef.current = 0
    atUpFramesRef.current = 0
    smoothRef.current = null
    lastFlipAtRef.current = 0
    lastEmittedRef.current = 0
  }

  /** Leave plank → disarm counting, keep existing rep total. */
  function disarmForm() {
    formRef.current = 0
    directionRef.current = 0
    formHoldRef.current = 0
    atDownFramesRef.current = 0
    atUpFramesRef.current = 0
    // If we were halfway through a rep (dir=1), drop the dangling 0.5
    halfCountRef.current = Math.floor(halfCountRef.current)
  }

  useEffect(() => {
    let cancelled = false

    async function setupModel() {
      try {
        const vision = await FilesetResolver.forVisionTasks(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm',
        )

        const landmarker = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath:
              'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
            delegate: 'GPU',
          },
          runningMode: 'VIDEO',
          numPoses: 1,
          minPoseDetectionConfidence: 0.35,
          minPosePresenceConfidence: 0.35,
          minTrackingConfidence: 0.35,
        })

        if (cancelled) {
          landmarker.close()
          return
        }

        landmarkerRef.current = landmarker
        readyRef.current = true
        updateStatus('Straighten arms (plank) to arm')

        const canvas = canvasRef.current
        const video = videoRef.current
        const ctx = canvas.getContext('2d')
        const drawingUtils = new DrawingUtils(ctx)

        const loop = () => {
          if (cancelled) return
          rafIdRef.current = requestAnimationFrame(loop)

          const detector = landmarkerRef.current
          if (!detector || video.readyState < 2) return

          const w = video.videoWidth
          const h = video.videoHeight
          if (!w || !h) return

          if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w
            canvas.height = h
          }

          if (video.currentTime === lastVideoTimeRef.current) return
          lastVideoTimeRef.current = video.currentTime

          let result
          try {
            result = detector.detectForVideo(video, performance.now())
          } catch {
            return
          }

          ctx.save()
          ctx.clearRect(0, 0, w, h)
          ctx.drawImage(video, 0, 0, w, h)

          const landmarks = result.landmarks?.[0]
          if (!landmarks) {
            updateStatus('No pose — face camera')
            ctx.restore()
            return
          }

          drawingUtils.drawLandmarks(landmarks, {
            color: '#22c55e',
            fillColor: '#86efac',
            lineWidth: 2,
            radius: 4,
          })
          drawingUtils.drawConnectors(landmarks, PoseLandmarker.POSE_CONNECTIONS, {
            color: '#4ade80',
            lineWidth: 2,
          })

          if (countingPausedRef.current || !armsUsable(landmarks)) {
            if (!countingPausedRef.current) updateStatus('Need both arms in frame')
            ctx.restore()
            return
          }

          const stance = pushupStance(landmarks)
          if (!stance.ok) {
            if (formRef.current === 1) disarmForm()
            formHoldRef.current = 0
            updateStatus(stance.reason)
            ctx.restore()
            return
          }

          const elbows = elbowAvg(landmarks)
          if (!elbows) {
            ctx.restore()
            return
          }

          const elbow =
            smoothRef.current == null
              ? elbows.avg
              : smoothRef.current * 0.6 + elbows.avg * 0.4
          smoothRef.current = elbow

          debugTickRef.current += 1
          if (debugTickRef.current % 4 === 0) {
            setDebug({
              avg: elbow.toFixed(0),
              left: elbows.left.toFixed(0),
              right: elbows.right.toFixed(0),
              dir: directionRef.current,
              form: formRef.current,
            })
          }

          const now = performance.now()
          const bothDown =
            elbows.left <= DOWN_ANGLE + 8 && elbows.right <= DOWN_ANGLE + 8
          const bothUp =
            elbows.left > UP_ANGLE - 5 && elbows.right > UP_ANGLE - 5
          const canFlip = now - lastFlipAtRef.current >= MIN_FLIP_MS

          // --- Form lock: plank stance + straight arms ---
          if (formRef.current === 0) {
            if (elbow > UP_ANGLE && bothUp) {
              formHoldRef.current += 1
              updateStatus(
                `Arming ${Math.min(99, Math.round((formHoldRef.current / FORM_HOLD_FRAMES) * 100))}%`,
              )
              if (formHoldRef.current >= FORM_HOLD_FRAMES) {
                formRef.current = 1
                directionRef.current = 0
                atDownFramesRef.current = 0
                atUpFramesRef.current = 0
                lastFlipAtRef.current = now
                updateStatus('READY — go down')
              }
            } else {
              formHoldRef.current = 0
              updateStatus('Hold plank, arms straight')
            }
            ctx.restore()
            return
          }

          // --- Half-rep direction machine ---
          // dir 0 → need DOWN → +0.5, dir=1
          // dir 1 → need UP   → +0.5, dir=0 (full rep)
          if (elbow <= DOWN_ANGLE && bothDown) {
            atDownFramesRef.current += 1
            atUpFramesRef.current = 0
            updateStatus('DOWN')

            if (
              directionRef.current === 0 &&
              atDownFramesRef.current >= EXTREME_FRAMES &&
              canFlip
            ) {
              halfCountRef.current += 0.5
              directionRef.current = 1
              atDownFramesRef.current = 0
              lastFlipAtRef.current = now
              emitCount()
            }
          } else if (elbow > UP_ANGLE && bothUp) {
            atUpFramesRef.current += 1
            atDownFramesRef.current = 0
            updateStatus(directionRef.current === 1 ? 'UP — almost' : 'UP')

            if (
              directionRef.current === 1 &&
              atUpFramesRef.current >= EXTREME_FRAMES &&
              canFlip
            ) {
              halfCountRef.current += 0.5
              directionRef.current = 0
              atUpFramesRef.current = 0
              lastFlipAtRef.current = now
              emitCount()
              updateStatus('UP +1')
            }
          } else {
            atDownFramesRef.current = 0
            atUpFramesRef.current = 0
            updateStatus(directionRef.current === 1 ? 'Push up' : 'Go down')
          }

          ctx.restore()
        }

        rafIdRef.current = requestAnimationFrame(loop)
      } catch (err) {
        console.error(err)
        if (!cancelled) updateStatus('Pose model failed — check console')
      }
    }

    setupModel()

    return () => {
      cancelled = true
      readyRef.current = false
      cancelAnimationFrame(rafIdRef.current)
      if (landmarkerRef.current) {
        landmarkerRef.current.close()
        landmarkerRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    async function startCamera() {
      setSwitching(true)
      countingPausedRef.current = true
      resetRepState()
      onCountChangeRef.current?.(0)
      updateStatus('Switching camera…')

      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop())
        streamRef.current = null
      }

      const video = videoRef.current
      if (video) video.srcObject = null

      try {
        const stream = await openCamera(facingMode)
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }

        streamRef.current = stream
        lastVideoTimeRef.current = -1
        video.srcObject = stream
        await video.play()

        if (!cancelled) {
          resetRepState()
          updateStatus(
            readyRef.current
              ? 'Straighten arms (plank) to arm'
              : 'Loading pose model…',
          )
        }
      } catch (err) {
        console.error(err)
        if (!cancelled) {
          updateStatus(
            err?.name === 'NotAllowedError'
              ? 'Camera permission denied'
              : 'Could not open camera',
          )
        }
      } finally {
        if (!cancelled) {
          countingPausedRef.current = false
          setSwitching(false)
        }
      }
    }

    startCamera()

    return () => {
      cancelled = true
      countingPausedRef.current = true
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop())
        streamRef.current = null
      }
      const video = videoRef.current
      if (video) video.srcObject = null
    }
  }, [facingMode])

  function flipCamera() {
    if (switching) return
    setFacingMode((prev) => (prev === 'environment' ? 'user' : 'environment'))
  }

  const cameraLabel = facingMode === 'environment' ? 'Back' : 'Front'

  return (
    <div className="absolute inset-0 bg-black">
      <video ref={videoRef} className="hidden" playsInline muted />
      <canvas ref={canvasRef} className="h-full w-full object-cover" />

      <p className="pointer-events-none absolute left-0 right-0 top-3 px-24 text-center text-sm font-medium uppercase tracking-wide text-white/80">
        {status}
      </p>

      <div className="pointer-events-none absolute left-3 top-14 rounded-lg bg-black/70 px-3 py-2 font-mono text-xs text-white">
        <div>avg {debug.avg}°</div>
        <div>
          L {debug.left}° · R {debug.right}°
        </div>
        <div className="text-zinc-400">
          form {debug.form} · dir {debug.dir}
        </div>
        <div className="text-zinc-500">
          ↓≤{DOWN_ANGLE} ↑&gt;{UP_ANGLE}
        </div>
      </div>

      <button
        type="button"
        onClick={flipCamera}
        disabled={switching}
        aria-label={`Switch camera (currently ${cameraLabel})`}
        className="absolute right-4 top-3 z-10 rounded-full bg-white/90 px-4 py-2 text-sm font-bold text-black shadow-lg active:scale-95 disabled:opacity-50"
      >
        {switching ? '…' : `Flip · ${cameraLabel}`}
      </button>
    </div>
  )
}
