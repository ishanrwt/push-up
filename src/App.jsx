import { useState } from 'react'
import PushupCounter from './components/PushupCounter.jsx'
import { unlockBeep } from './utils/beep.js'

function formatDuration(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export default function App() {
  const [screen, setScreen] = useState('start') // start | workout | summary
  const [count, setCount] = useState(0)
  const [startedAt, setStartedAt] = useState(null)
  const [elapsedMs, setElapsedMs] = useState(0)

  function handleStart() {
    unlockBeep()
    setCount(0)
    setElapsedMs(0)
    setStartedAt(Date.now())
    setScreen('workout')
  }

  function handleFinish() {
    setElapsedMs(Date.now() - (startedAt ?? Date.now()))
    setScreen('summary')
  }

  function handleReset() {
    setCount(0)
    setStartedAt(null)
    setElapsedMs(0)
    setScreen('start')
  }

  if (screen === 'start') {
    return (
      <div className="flex h-full flex-col justify-between bg-zinc-900 px-6 pb-10 pt-16">
        <div className="space-y-4">
          <h1 className="text-5xl font-bold tracking-tight text-white">Pushup</h1>
          <p className="text-lg leading-snug text-zinc-400">
            Get into a plank facing the phone (not standing). Hold arms straight
            until READY, then do pushups. Waving or standing won&apos;t count.
          </p>
        </div>
        <button
          type="button"
          onClick={handleStart}
          className="w-full rounded-2xl bg-white py-5 text-xl font-bold text-black active:scale-[0.98]"
        >
          Start
        </button>
      </div>
    )
  }

  if (screen === 'workout') {
    return (
      <div className="relative h-full bg-black">
        <PushupCounter onCountChange={setCount} />

        <div className="pointer-events-none absolute inset-x-0 top-12 flex justify-center">
          <p className="text-8xl font-bold tabular-nums text-white drop-shadow-[0_2px_8px_rgba(0,0,0,0.8)]">
            {count}
          </p>
        </div>

        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent px-6 pb-10 pt-16">
          <button
            type="button"
            onClick={handleFinish}
            className="w-full rounded-2xl bg-white py-5 text-xl font-bold text-black active:scale-[0.98]"
          >
            Finish
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col justify-between bg-zinc-900 px-6 pb-10 pt-16">
      <div className="space-y-8">
        <h1 className="text-3xl font-bold text-white">Set done</h1>
        <div>
          <p className="text-sm uppercase tracking-wide text-zinc-500">Reps</p>
          <p className="text-8xl font-bold tabular-nums text-white">{count}</p>
        </div>
        <div>
          <p className="text-sm uppercase tracking-wide text-zinc-500">Time</p>
          <p className="text-5xl font-bold tabular-nums text-white">
            {formatDuration(elapsedMs)}
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={handleReset}
        className="w-full rounded-2xl bg-white py-5 text-xl font-bold text-black active:scale-[0.98]"
      >
        Do another set
      </button>
    </div>
  )
}
