# microship

![Last version](https://img.shields.io/github/tag/Kikobeats/microship.svg?style=flat-square)
[![Coverage Status](https://img.shields.io/coveralls/Kikobeats/microship.svg?style=flat-square)](https://coveralls.io/github/Kikobeats/microship)
[![NPM Version](https://img.shields.io/npm/v/microship.svg?style=flat-square)](https://www.npmjs.org/package/microship)

> Readiness, liveness, and graceful shutdown for a Node.js process on Kubernetes.

- Probes are served from a [worker thread](https://nodejs.org/api/worker_threads.html), so a busy event loop does not fail them.
- Liveness fails only when the event loop has been stalled for 15 seconds.
- Shutdown takes the pod out of rotation first, then drains, then exits.
- Zero dependencies.

## Install

```bash
npm install microship
```

## Usage

```js
const { createMicroship } = require('microship')
const http = require('http')

const main = async () => {
  const server = http.createServer((req, res) => res.end('hello'))
  const ship = await createMicroship()

  ship.registerShutdownHandler(
    () => new Promise(resolve => server.close(resolve))
  )

  server.listen(3000, () => ship.signalReady())
}

main()
```

The probe server is listening as soon as `createMicroship` resolves. The process reports not ready until you call `signalReady()`.

## Probes

It creates an HTTP service used to check [container probes](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#container-probes). Refer to the Kubernetes documentation for information about the readiness and liveness checks:

- [Pod Lifecycle](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/)
- [Configure Liveness, Readiness and Startup Probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/)

Both endpoints answer with a status code and an empty body. Any other path returns `404`.

| Endpoint | `200`                                       | `500`                                                           |
| -------- | ------------------------------------------- | --------------------------------------------------------------- |
| `/ready` | After `signalReady()`.                      | Before `signalReady()`, during shutdown.                        |
| `/live`  | The event loop ran within the last 15 seconds. | The event loop has been stalled for 15 seconds, or during shutdown. |

`/ready` is used to configure the readiness probe: it tells Kubernetes whether to send traffic to the pod. `/live` is used to configure the liveness probe: it tells Kubernetes whether to restart the container.

The endpoints are separate because they answer different questions: a process that is booting or draining is not ready, and it should not be restarted for it.

### Why a worker thread

A probe served from the main thread shares the event loop with your workload. When the process performs [event loop blocking tasks](https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop) the probes fail intermittently:

```
Warning  Unhealthy  4m17s (x3 over 4m27s)   kubelet  Liveness probe failed: Get http://10.24.7.155:3001/live: net/http: request canceled (Client.Timeout exceeded while awaiting headers)
Warning  Unhealthy  3m28s (x15 over 4m38s)  kubelet  Readiness probe failed: Get http://10.24.7.155:3001/ready: net/http: request canceled (Client.Timeout exceeded while awaiting headers)
```

Kubernetes marks a healthy pod as unready, and the remaining pods take more load.

**microship** serves the probes from a worker thread. The main thread writes its state and a heartbeat every 500ms into a `SharedArrayBuffer`, and the worker reads it. A busy main thread keeps answering `/ready` with `200`. `/live` fails only when the heartbeat has not moved for 15 seconds, which is a stalled process and not a busy one.

## Graceful shutdown

On `SIGTERM` or `SIGINT`, or when you call `ship.shutdown()`:

1. `/ready` and `/live` start returning `500`.
2. It waits `shutdownDelay` (1 second by default), so Kubernetes stops routing new requests to the pod.
3. It runs the shutdown handlers one at a time, in registration order.
4. The process exits on its own once nothing keeps the event loop active. If it has not exited one second after the last handler finishes, `terminate` is called.

If the handlers take longer than `shutdownHandlerTimeout`, `terminate` is called right away. If a handler throws, the remaining handlers are skipped and `terminate` is still called.

Do not call `process.exit()` in a shutdown handler. **microship** ends the process after all registered shutdown handlers have run to completion.

### Add a delay before you stop handling incoming requests

It is important that you do not cease to handle new incoming requests immediately after receiving the shutdown signal. There is a high probability of the `SIGTERM` signal being sent well before the iptables rules are updated on all nodes. The result is that the pod may still receive client requests after it has received the termination signal. If the app stops accepting connections immediately, clients receive "connection refused" errors.

Properly shutting down an application includes these steps:

1. Wait for a few seconds, then stop accepting new connections.
2. Close all keep-alive connections that are not in the middle of a request.
3. Wait for all active requests to finish.
4. Shut down completely.

`shutdownDelay` is step 1. Its value should match `readinessProbe.periodSeconds`. See [Handling Client Requests Properly with Kubernetes](https://web.archive.org/web/20200807161820/https://freecontent.manning.com/handling-client-requests-properly-with-kubernetes/) for more information.

### Timeouts

The default `shutdownHandlerTimeout` is 5 seconds. Raise it when draining takes longer, and keep the pod's [`terminationGracePeriodSeconds`](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#pod-termination) (30 seconds by default) above `shutdownDelay + shutdownHandlerTimeout + 1s`. Otherwise the kubelet sends `SIGKILL` before the handlers finish. The same sum has to fit in the liveness window. See [Kubernetes configuration](#kubernetes-configuration).

## Kubernetes configuration

This is a reasonable `Deployment` to pair with the **microship** defaults. The [container probes](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#container-probes) point at the endpoints **microship** exposes.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
spec:
  replicas: 2
  selector:
    matchLabels:
      app: app
  template:
    metadata:
      labels:
        app: app
    spec:
      # Must be above shutdownDelay + shutdownHandlerTimeout + 1s (7 seconds with the defaults).
      terminationGracePeriodSeconds: 30
      containers:
        - name: app
          image: app:1.0.0
          ports:
            - name: http
              containerPort: 3000
            # The `port` option. It must be different from your main service port.
            - name: probes
              containerPort: 3001
          # Holds the other two probes until the process is up.
          # Allows up to 30 seconds (periodSeconds * failureThreshold) to boot.
          # As per Kubernetes documentation (https://kubernetes.io/docs/concepts/workloads/pods/probes/#when-should-you-use-a-startup-probe),
          # startup probe should point to the same endpoint as the liveness probe.
          startupProbe:
            httpGet:
              path: /live
              port: probes
            periodSeconds: 1
            failureThreshold: 30
          readinessProbe:
            httpGet:
              path: /ready
              port: probes
            # Must match the `shutdownDelay` option (1000 milliseconds).
            periodSeconds: 1
            failureThreshold: 1
            successThreshold: 1
          livenessProbe:
            httpGet:
              path: /live
              port: probes
            # Allow sufficient amount of time (30 seconds = periodSeconds * failureThreshold)
            # for the registered shutdown handlers to run to completion.
            periodSeconds: 10
            failureThreshold: 3
            timeoutSeconds: 5
```

Each value is tied to a **microship** option. When you change one side, change the other:

| Kubernetes                                           | microship                                              | Rule                                                                                         |
| ---------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `containerPort` of the probes                        | `port`                                                 | Equal. Do not use your main service port, and do not expose it through a `Service`.          |
| `readinessProbe.periodSeconds`                       | `shutdownDelay`                                        | Equal, so the pod is observed as not ready before the shutdown handlers run.                 |
| `terminationGracePeriodSeconds`                      | `shutdownDelay + shutdownHandlerTimeout + 1s`          | Greater. Otherwise the kubelet sends `SIGKILL` before the handlers finish.                   |
| `livenessProbe.periodSeconds * failureThreshold`     | `shutdownDelay + shutdownHandlerTimeout + 1s`          | Greater, because `/live` returns `500` from the moment the shutdown starts.                  |
| `livenessProbe.periodSeconds * failureThreshold`     | The 15 seconds of stalled event loop before `/live` fails | A stalled event loop is restarted within the sum of both: 45 seconds with these values.      |

**microship** always binds `port`, inside and outside Kubernetes. Two processes on the same machine need different ports, or `port: 0` to take any available one. The bound port is available as `ship.port`.

## API

### createMicroship([options])

Returns a `Promise` that resolves to a `ship` once the probe server is listening. It rejects when the port cannot be bound.

#### options

| Name                     | Type       | Default                 | Description                                                                                                              |
| ------------------------ | ---------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `port`                   | `number`   | `3001`                  | Probe server port. It must be different from your main service port. `0` binds any available port.                       |
| `shutdownDelay`          | `number`   | `1000`                  | Milliseconds between failing the probes and running the shutdown handlers. It should match `readinessProbe.periodSeconds`. |
| `shutdownHandlerTimeout` | `number`   | `5000`                  | Milliseconds the shutdown handlers get before `terminate` is forced.                                                     |
| `terminate`              | `function` | `() => process.exit(0)` | Called to end the process.                                                                                               |

### ship

#### .signalReady()

Makes `/ready` return `200`. It does nothing once the shutdown has started.

#### .registerShutdownHandler(fn)

Adds a function to run during shutdown. It can return a `Promise`.

#### .shutdown()

Starts the shutdown sequence without waiting for a signal. Returns a `Promise` that resolves when the handlers have run. Calling it again does nothing.

#### .port

The port the probe server is bound to.

#### .stop()

Stops the heartbeat, removes the signal listeners, and terminates the worker. Returns a `Promise`. Meant for tests.

## License

The API and the Kubernetes guidance come from [lightship](https://github.com/gajus/lightship) by Gajus Kuizinas.

**microship** © [Kiko Beats](https://kikobeats.com), released under the MIT License.<br>
Authored and maintained by [Kiko Beats](https://kikobeats.com) with help from [contributors](https://github.com/Kikobeats/microship/contributors).

> [kikobeats.com](https://kikobeats.com) · GitHub [Kiko Beats](https://github.com/Kikobeats) · X [@Kikobeats](https://x.com/Kikobeats)
