'use strict'

const { Worker } = require('worker_threads')
const path = require('path')

const { STALE_MS } = require('./status')

const SIGNALS = ['SIGTERM', 'SIGHUP', 'SIGINT']
const EXIT_DELAY = 1000

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const inKubernetes = () => Boolean(process.env.KUBERNETES_SERVICE_HOST)

const createMicroship = async ({
  detectKubernetes = true,
  port = 3001,
  shutdownDelay,
  shutdownHandlerTimeout = 5000,
  signals = SIGNALS,
  staleMs = STALE_MS,
  terminate = () => process.exit(0)
} = {}) => {
  const local = detectKubernetes && !inKubernetes()
  const probePort = local ? 0 : port
  const delay = shutdownDelay === undefined ? (local ? 0 : 5000) : shutdownDelay

  let ready = false
  let shuttingDown = false
  const handlers = []
  const view = new Int32Array(new SharedArrayBuffer(12))

  const publish = () => {
    Atomics.store(view, 0, ready && !shuttingDown ? 1 : 0)
    Atomics.store(view, 1, shuttingDown ? 1 : 0)
  }

  const worker = new Worker(path.join(__dirname, 'worker.js'), {
    workerData: { port: probePort, sab: view.buffer, staleMs }
  })
  worker.unref()

  const bound = await new Promise((resolve, reject) => {
    worker.once('message', message => {
      if (message.error) reject(new Error(message.error))
      else resolve(message.port)
    })
    worker.once('error', reject)
  })

  const beat = setInterval(() => {
    publish()
    Atomics.add(view, 2, 1)
  }, 500)
  beat.unref()

  const signalReady = () => {
    if (shuttingDown) return
    ready = true
    publish()
  }

  const signalNotReady = () => {
    ready = false
    publish()
  }

  const shutdown = async () => {
    if (shuttingDown) return
    ready = false
    shuttingDown = true
    publish()
    if (delay) await sleep(delay)

    let forced = false
    const timer = setTimeout(() => {
      forced = true
      terminate()
    }, shutdownHandlerTimeout)
    timer.unref()

    try {
      for (const handler of handlers) await handler()
    } catch (_) {}

    clearTimeout(timer)
    if (!forced) setTimeout(terminate, EXIT_DELAY).unref()
  }

  const onSignal = () => {
    shutdown().catch(() => {})
  }
  for (const signal of signals) process.on(signal, onSignal)

  return {
    port: bound,
    isServerReady: () => ready && !shuttingDown,
    isServerShuttingDown: () => shuttingDown,
    registerShutdownHandler: handler => {
      handlers.push(handler)
    },
    shutdown,
    signalNotReady,
    signalReady,
    stop: async () => {
      clearInterval(beat)
      for (const signal of signals) process.off(signal, onSignal)
      await worker.terminate()
    }
  }
}

module.exports = { createMicroship, STALE_MS }
