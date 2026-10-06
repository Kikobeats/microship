'use strict'

const { parentPort, workerData } = require('worker_threads')
const http = require('http')

const { createState, statusFor } = require('./status')

const view = new Int32Array(workerData.sab)
const state = createState()

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0]
  const code = statusFor(view, state, url, Date.now())
  res.writeHead(code, { 'content-type': 'text/plain' })
  res.end()
})

server.on('error', error => {
  parentPort.postMessage({ error: error.message })
})

server.listen(workerData.port, '0.0.0.0', () => {
  parentPort.postMessage({ port: server.address().port })
})
