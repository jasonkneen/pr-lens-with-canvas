import { useCallback, useEffect, useRef, useState } from "react"
import type { Camera } from "./geometry"

const DURATION = 480
const ease = (t: number) => 1 - Math.pow(1 - t, 3)

/** A camera that can jump, or glide to a target over half a second. */
export const useTween = (initial: Camera) => {
  const [camera, setState] = useState(initial)
  const now = useRef(initial)
  const frame = useRef<number | undefined>(undefined)

  const stop = () => {
    if (frame.current !== undefined) cancelAnimationFrame(frame.current)
    frame.current = undefined
  }

  const setCamera = useCallback((next: Camera) => {
    stop()
    now.current = next
    setState(next)
  }, [])

  const glide = useCallback((target: Camera) => {
    stop()
    const from = now.current
    const start = performance.now()
    const tick = (time: number) => {
      const t = ease(Math.min(1, (time - start) / DURATION))
      // Scale moves in log space so a big zoom does not rush its last half.
      const scale = Math.exp(Math.log(from.scale) + (Math.log(target.scale) - Math.log(from.scale)) * t)
      const next = { scale, x: from.x + (target.x - from.x) * t, y: from.y + (target.y - from.y) * t }
      now.current = next
      setState(next)
      frame.current = t < 1 ? requestAnimationFrame(tick) : undefined
    }
    frame.current = requestAnimationFrame(tick)
  }, [])

  useEffect(() => stop, [])

  return { camera, setCamera, glide }
}
