'use strict'

const STALE_MS = 15000

const createState = () => ({ lastBeat: 0, lastBeatAt: 0 })

const beatAge = (view, state, now) => {
  const beat = Atomics.load(view, 2)
  if (state.lastBeatAt === 0 || beat !== state.lastBeat) {
    state.lastBeat = beat
    state.lastBeatAt = now
  }
  return now - state.lastBeatAt
}

const statusFor = (view, state, url, now) => {
  const shuttingDown = Atomics.load(view, 1) === 1
  const ready = Atomics.load(view, 0) === 1 && !shuttingDown
  const live = !shuttingDown && beatAge(view, state, now) < STALE_MS
  if (url === '/live') return live ? 200 : 500
  if (url === '/ready') return ready ? 200 : 500
  return 404
}

module.exports = { STALE_MS, createState, statusFor }
