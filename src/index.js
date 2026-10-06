'use strict'

const { Worker } = require('worker_threads')
const path = require('path')

const SIGNALS = ['SIGTERM', 'SIGINT']
const EXIT_DELAY = 1000

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const createMicroship = async ({
  port = 3001,
  shutdownDelay = 1000,
  shutdownHandlerTimeout = 5000,
  terminate = () => process.exit(0)
} = {}) => {
  let ready = false
  let shuttingDown = false
  const handlers = []
  const view = new Int32Array(new SharedArrayBuffer(12))

  const publish = () => {
    Atomics.store(view, 0, ready && !shuttingDown ? 1 : 0)
    Atomics.store(view, 1, shuttingDown ? 1 : 0)
  }

  const worker = new Worker(path.join(__dirname, 'worker.js'), {
    workerData: { port, sab: view.buffer }
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

  const shutdown = async () => {
    if (shuttingDown) return
    ready = false
    shuttingDown = true
    publish()
    if (shutdownDelay) await sleep(shutdownDelay)

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
  for (const signal of SIGNALS) process.on(signal, onSignal)

  return {
    port: bound,
    registerShutdownHandler: handler => {
      handlers.push(handler)
    },
    shutdown,
    signalReady,
    stop: async () => {
      clearInterval(beat)
      for (const signal of SIGNALS) process.off(signal, onSignal)
      await worker.terminate()
    }
  }
}

module.exports = { createMicroship }
