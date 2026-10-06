# microship

Readiness, liveness, and graceful shutdown for a Node process on Kubernetes.

`/ready` and `/live` run on a [worker thread](https://nodejs.org/api/worker_threads.html). A busy event loop stays ready. `/live` returns 500 after the loop has not run for 15 seconds. Shutdown marks the process not ready, waits `shutdownDelay` so the kubelet observes it, runs the shutdown handler, then exits.

```js
const { createMicroship } = require('microship')

const ship = await createMicroship({
  port: 3001,
  shutdownDelay: 1000,
  shutdownHandlerTimeout: 90000,
  terminate: () => process.exit(0)
})

ship.registerShutdownHandler(async () => {
  // drain in-flight work
})

ship.signalReady()
```

`shutdownHandlerTimeout` forces `terminate` when the handler does not finish. Signals are `SIGTERM` and `SIGINT`.
