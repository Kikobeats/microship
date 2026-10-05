'use strict'

const { once } = require('node:events')
const { spawn } = require('node:child_process')
const http = require('node:http')
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')

const { createMicroship } = require('../src')

const get = port =>
  new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/ready`, res => {
      res.resume()
      resolve(res.statusCode)
    })
    req.on('error', reject)
  })

const create = overrides =>
  createMicroship({
    detectKubernetes: false,
    port: 0,
    shutdownDelay: 0,
    signals: [],
    terminate () {},
    ...overrides
  })

describe('microship', () => {
  it('reports ready only after signalReady', async () => {
    const ship = await create()
    try {
      assert.equal(await get(ship.port), 500)
      ship.signalReady()
      assert.equal(ship.isServerReady(), true)
      assert.equal(await get(ship.port), 200)
      ship.signalNotReady()
      assert.equal(await get(ship.port), 500)
    } finally {
      await ship.stop()
    }
  })

  it('runs the shutdown handler after the delay, then terminates', async () => {
    let ran = false
    let exited = false
    const ship = await create({
      shutdownDelay: 20,
      terminate () {
        exited = true
      }
    })
    ship.registerShutdownHandler(async () => {
      assert.equal(ship.isServerShuttingDown(), true)
      assert.equal(await get(ship.port), 500)
      ran = true
    })
    ship.signalReady()
    const pending = ship.shutdown()
    await pending
    assert.equal(ran, true)
    await new Promise(resolve => setTimeout(resolve, 1100))
    assert.equal(exited, true)
    await ship.stop()
  })

  it('terminates when the shutdown handler does not finish', async () => {
    let exited = false
    const ship = await create({
      shutdownHandlerTimeout: 30,
      terminate () {
        exited = true
      }
    })
    ship.registerShutdownHandler(() => new Promise(() => {}))
    ship.shutdown().catch(() => {})
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.equal(exited, true)
    await ship.stop()
  })

  it('answers /ready while the main thread is blocked', async () => {
    const ship = await create()
    ship.signalReady()
    const child = spawn(
      process.execPath,
      [
        '-e',
        `const http = require('http')
process.stdin.resume()
process.stdin.on('data', () => {
  http.get(process.env.PROBE_URL, res => {
    process.stdout.write(JSON.stringify({ code: res.statusCode, at: Date.now() }))
    res.resume()
  })
})
process.stdout.write('ready\\n')`
      ],
      { env: { ...process.env, PROBE_URL: `http://127.0.0.1:${ship.port}/ready` } }
    )
    try {
      let out = ''
      child.stdout.on('data', chunk => {
        out += chunk
      })
      const [code] = await once(child.stdout, 'data')
      assert.match(String(code), /ready/)
      const start = Date.now()
      child.stdin.write('go')
      let spin = 0
      while (Date.now() - start < 400) spin++
      const ended = Date.now()
      assert.ok(spin > 0)
      const deadline = Date.now() + 2000
      while (!out.includes('{') && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      const msg = JSON.parse(out.slice(out.indexOf('{')))
      assert.equal(msg.code, 200)
      assert.ok(msg.at < ended)
    } finally {
      child.kill()
      await ship.stop()
    }
  })
})
