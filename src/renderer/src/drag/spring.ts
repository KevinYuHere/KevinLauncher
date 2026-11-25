/**
 * Tiny reusable spring + animation-loop primitives. Shared by every "jelly"
 * effect in the launcher (dragging, segmented highlight, …) so the motion feels
 * consistent and there is a single place to tune it.
 */

export interface Spring {
  v: number
  vel: number
  target: number
}

export const makeSpring = (v = 0): Spring => ({ v, vel: 0, target: v })

/** Advance a spring by `dt` seconds. */
export function stepSpring(s: Spring, dt: number, stiffness = 620, damping = 26): void {
  const a = -stiffness * (s.v - s.target) - damping * s.vel
  s.vel += a * dt
  s.v += s.vel * dt
}

export const springSettled = (s: Spring, eps = 0.002, velEps = 0.02): boolean =>
  Math.abs(s.v - s.target) < eps && Math.abs(s.vel) < velEps

/**
 * The active theme may replace the jelly motion (`motionJelly` is published on
 * <html> by applySpecialTheme). "frost-snap" is stiffer and less bouncy — a
 * crisp shield click instead of the elastic default.
 */
export const frostMotion = (): boolean =>
  document.documentElement.dataset.motionJelly === 'frost-snap'

/** A task returns `true` to keep running, `false` to stop. */
export type Task = (dt: number) => boolean

const tasks = new Set<Task>()
let frame = 0
let last = 0
let active = true

function loop(now: number): void {
  frame = 0
  const dt = Math.min(0.032, (now - last) / 1000)
  last = now
  for (const task of [...tasks]) if (!task(dt)) tasks.delete(task)
  if (active && tasks.size > 0) frame = requestAnimationFrame(loop)
}

function resumeLoop(): void {
  if (active && !frame && tasks.size > 0) {
    last = performance.now()
    frame = requestAnimationFrame(loop)
  }
}

export function setSpringsActive(next: boolean): void {
  active = next
  if (next) resumeLoop()
  else {
    cancelAnimationFrame(frame)
    frame = 0
  }
}

/** Register a per-frame task on the shared rAF loop (starts it if needed). */
export function addTask(task: Task): () => void {
  tasks.add(task)
  resumeLoop()
  return () => {
    tasks.delete(task)
    if (tasks.size === 0) {
      cancelAnimationFrame(frame)
      frame = 0
    }
  }
}
