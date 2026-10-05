'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')

const { STALE_MS, createState, statusFor } = require('../src/status')

const viewWith = (ready, shuttingDown, beat) => {
  const view = new Int32Array(new SharedArrayBuffer(12))
  Atomics.store(view, 0, ready)
  Atomics.store(view, 1, shuttingDown)
  Atomics.store(view, 2, beat)
  return view
}

describe('status', () => {
  it('fails liveness and keeps readiness when the heartbeat is stale', () => {
    const now = 1000000
    const view = viewWith(1, 0, 7)
    const state = createState()
    state.lastBeat = 7
    state.lastBeatAt = now - STALE_MS - 1
    assert.equal(statusFor(view, state, '/live', now), 500)
    assert.equal(statusFor(view, state, '/ready', now), 200)
  })

  it('fails both probes while shutting down', () => {
    const now = 1000000
    const view = viewWith(1, 1, 1)
    const state = createState()
    assert.equal(statusFor(view, state, '/ready', now), 500)
    assert.equal(statusFor(view, state, '/live', now), 500)
  })

  it('fails readiness until the process is ready', () => {
    const now = 1000000
    const view = viewWith(0, 0, 1)
    const state = createState()
    assert.equal(statusFor(view, state, '/ready', now), 500)
    assert.equal(statusFor(view, state, '/live', now), 200)
  })
})
