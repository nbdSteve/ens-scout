import { useEffect, useState } from 'react'

/**
 * The clock the page renders against.
 *
 * Countdowns and the scan age are the visitor's clock applied to the snapshot's
 * timestamps, so they need a value that advances. When a simulated time is given
 * it is returned unchanged and never advances, which is what makes the committed
 * fixtures demonstrable and the browser tests deterministic.
 *
 * The tick is deliberately not tied to reduced-motion. Reduced motion is about
 * animation, and a countdown that stopped counting would be missing information
 * rather than being calmer. What reduced motion changes is styling, handled in
 * CSS.
 */
export function useNow(frozen: Date | null, intervalMs = 1000): Date {
  const [tick, setTick] = useState<Date>(() => new Date())

  useEffect(() => {
    if (frozen !== null) {
      return
    }
    const timer = setInterval(() => {
      setTick(new Date())
    }, intervalMs)
    return () => {
      clearInterval(timer)
    }
  }, [frozen, intervalMs])

  // The simulated time wins on the render that introduces it, so unfreezing
  // resumes from the live clock on the next tick rather than showing a stale one.
  return frozen ?? tick
}
