# Pushup Counter — Locked Settings

**Status:** Validated working (front-facing phone camera)  
**Date locked:** 2026-08-06  
**Source file:** [`src/components/PushupCounter.jsx`](src/components/PushupCounter.jsx)

Do not change these values casually. If you tune later, update this file and note why.

---

## Camera / pose setup

| Setting | Value |
|---|---|
| Default camera | `user` (front) |
| Resolution ideal | 640 × 480 |
| Model | `pose_landmarker_lite` (MediaPipe Tasks Vision) |
| WASM | `@mediapipe/tasks-vision@1.0.1` |
| `minPoseDetectionConfidence` | `0.35` |
| `minPosePresenceConfidence` | `0.35` |
| `minTrackingConfidence` | `0.35` |
| Landmark visibility floor (`VIS_MIN`) | `0.15` (missing visibility treated as `1`) |

**Landmarks used**

- Left arm: shoulder `11`, elbow `13`, wrist `15`
- Right arm: shoulder `12`, elbow `14`, wrist `16`
- Hips (stance only): `23`, `24`

---

## Elbow angle thresholds

| Constant | Value | Meaning |
|---|---|---|
| `DOWN_ANGLE` | **125** | Bottom of pushup (elbow bent) |
| `UP_ANGLE` | **150** | Top / plank (arms straight) |

**Both-arms checks (arming only)**

- Up to arm: `left > UP_ANGLE - 5` **and** `right > UP_ANGLE - 5`
- While locked, counting uses smoothed **average** only (avoids missed reps when one arm reads differently on the way up)

**Smoothing**

```text
signal = prev * 0.6 + avg * 0.4
```

---

## Timing / hysteresis

| Constant | Value | Purpose |
|---|---|---|
| `FORM_HOLD_FRAMES` | **12** | Hold plank + straight arms before `form = 1` |
| `EXTREME_FRAMES` | **5** | Frames past threshold before a half-rep flip |
| `MIN_FLIP_MS` | **550** | Minimum ms between direction flips (anti-chatter) |
| `STANDING_UNLOCK_FRAMES` | **18** | Sustained upright frames before unlock while locked |

---

## Counting FSM (repo-style half-reps)

Based on [aryanvij02/PushUpCounter](https://github.com/aryanvij02/PushUpCounter):

1. `form = 0` until plank stance + straight arms held for `FORM_HOLD_FRAMES`
2. `direction = 0` → detect DOWN → `count += 0.5`, `direction = 1`
3. `direction = 1` → detect UP → `count += 0.5`, `direction = 0`
4. UI shows `Math.floor(count)` (full rep only on step 3)

If stance is lost mid-rep, disarm: `form = 0`, `direction = 0`, drop dangling half (`count = floor(count)`). Keep completed whole reps.

---

## Plank stance gate

### Arming only (`armingStance`) — while **Not locked**

| Check | Rule | Fail message |
|---|---|---|
| Wrists high | `wrist.y < shoulder.y - 0.06` | Plank only — wrists down |
| Elbows high | `elbow.y < shoulder.y - 0.1` | Plank only — not waving |
| Face-on | `shoulderWidth < 0.12` | Square up to camera |
| Standing | `isClearlyStanding` | Get into plank (not standing) |

### While **Pushup locked**

- Wrist/elbow height checks are **not** used (they false-fire during real pushup ROM / going up).
- Counting uses smoothed elbow **average** only (`↓≤125` / `↑>150`).
- Unlock only if `isClearlyStanding` for **`STANDING_UNLOCK_FRAMES = 18`** frames (`torsoH / shoulderW > 1.05`, hips visibility ≥ 0.35).

Image Y grows downward (MediaPipe normalized coords).

---

## How to use (validated)

1. Prop phone in front; face + both arms in frame  
2. Get into **plank** (not standing)  
3. Hold arms straight until badge shows **Pushup locked** (green)  
4. Do pushups — one full down→up = +1  
5. Standing up for ~0.5s+ unlocks (red); get back to plank to re-arm  

---

## Restore checklist

If counting regresses after edits, restore these in `PushupCounter.jsx`:

```js
const DOWN_ANGLE = 125
const UP_ANGLE = 150
const FORM_HOLD_FRAMES = 12
const EXTREME_FRAMES = 5
const MIN_FLIP_MS = 550
const STANDING_UNLOCK_FRAMES = 18
const VIS_MIN = 0.15
```

Plus:

- Arming stance wrist `0.06`, elbow `0.1`, shoulder width `0.12`
- Standing unlock ratio `> 1.05`, hip vis `≥ 0.35`, `STANDING_UNLOCK_FRAMES = 18`
- Smooth weights `0.6 / 0.4`
- Strict stance only before lock; avg-only counting while locked
- Half-rep FSM + disarm only on sustained standing
- Default `facingMode = 'user'`
- Lock badge: green “Pushup locked” / red “Not locked”