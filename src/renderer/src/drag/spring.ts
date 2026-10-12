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

/** A task returns `true` to keep running, `false` to stop. */
export type Task = (dt: number) => boolean

const tasks = new Set<Task>()
let running = false
let last = 0

function loop(now: number): void {
  const dt = Math.min(0.032, (now - last) / 1000)
  last = now
  for (const task of [...tasks]) if (!task(dt)) tasks.delete(task)
  if (tasks.size > 0) requestAnimationFrame(loop)
  else running = false
}

/** Register a per-frame task on the shared rAF loop (starts it if needed). */
export function addTask(task: Task): void {
  tasks.add(task)
  if (!running) {
    running = true
    last = performance.now()
    requestAnimationFrame(loop)
  }
}
