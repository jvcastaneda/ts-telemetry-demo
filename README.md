# ts-telemetry-demo

A minimal TypeScript + Express service, instrumented with
[`prom-client`](https://github.com/siimon/prom-client), built to be a lab for
practicing Prometheus scraping/alerting and Grafana dashboarding on top of an
existing `kube-prometheus-stack` install. It generates its own traffic so the
dashboards show real, moving data within a couple minutes of deploy — no load
generator required.

## How it works

- `app/src/index.ts` is an Express app with three routes:
  - `GET /healthz` — plain liveness/readiness check, unrelated to metrics.
  - `GET /work` — the "business" endpoint. Simulates `10-260ms` of latency and
    fails a configurable fraction of the time (`ERROR_RATE`, default `10%`).
    Override per-call with `?delayMs=` and `?fail=true`.
  - `GET /metrics` — Prometheus exposition format via `prom-client`'s
    `Registry`.
  - A background loop (`SELF_TRAFFIC=true` by default) calls its own `/work`
    every 200-800ms so there's always fluctuating traffic to graph.
  > `prom-client` currently prints a deprecation notice on install pointing to
  > a successor package, `@prometheus-io/client`. That package is very new
  > (v0.16, first published within the last month) with a different API, so
  > this project intentionally stays on `prom-client` for now — it's still
  > fully functional, just no longer the "blessed" name. Worth revisiting
  > once the successor matures.
- `app/src/metrics.ts` registers:
  - `http_requests_total{method,route,status_code}` — a `Counter`, incremented
    by an Express middleware wrapping every route except `/metrics` itself
    (scraping shouldn't inflate its own request counter).
  - `http_request_duration_seconds{method,route,status_code}` — a `Histogram`
    of the same requests, the basis for latency percentiles.
  - `simulated_work_total{outcome}` — an app-level `Counter` (`success` /
    `error`) independent of HTTP status codes, to show metrics don't have to
    live only at the transport layer.
  - `client.collectDefaultMetrics()` — prom-client's standard Node.js process
    metrics (`process_resident_memory_bytes`, `nodejs_eventloop_lag_seconds`,
    `nodejs_heap_size_used_bytes`, `nodejs_gc_duration_seconds`, ...), left
    unprefixed so they match their well-known upstream names.
- The container is built in two stages (`app/Dockerfile`): `npm ci && npm run
  build` in a `node:20-alpine` builder, then only `dist/` plus production
  `node_modules` copied into a clean `node:20-alpine` runtime image, running as
  the non-root `node` user.

## Build & publish (GitHub Container Registry)

`.github/workflows/build-push.yml` builds `app/` and pushes to
`ghcr.io/jvcastaneda/ts-telemetry-demo` on every push to `main` (tag `latest`)
and on version tags (`v1.2.3`), using the built-in `GITHUB_TOKEN` — no extra
CI secrets needed.

**This project uses a private GHCR package**, so the cluster needs an
`imagePullSecret` to pull the image (`k8s/base/deployment.yaml` already
references `ghcr-pull-secret`). Create it once per cluster with a GitHub PAT
that has `read:packages`:

```
kubectl create secret docker-registry ghcr-pull-secret \
  --docker-server=ghcr.io \
  --docker-username=<gh-username> \
  --docker-password=<PAT with read:packages> \
  -n ts-telemetry-demo
```

## Deploy with ArgoCD

1. Push this whole directory to `github.com/jvcastaneda/ts-telemetry-demo`
   (update `repoURL` in `argocd/application.yaml` if it differs).
2. Apply it: `kubectl apply -f argocd/application.yaml`.
3. ArgoCD syncs `k8s/base` (a Kustomize base) automatically: creates the
   `ts-telemetry-demo` namespace, `Deployment`, `Service`, `ServiceMonitor`,
   and `PrometheusRule`, and self-heals/prunes on drift from git.

If ArgoCD's `repo-server` isn't healthy in your cluster (check `kubectl get
pods -n argocd`), you can apply the same manifests directly at any time:
`kubectl apply -k k8s/base`. Once `repo-server` recovers and you've pushed to
git, ArgoCD's `selfHeal` will reconcile against the same state with no
conflict.

## Prometheus (kube-prometheus-stack)

`k8s/base/servicemonitor.yaml` and `k8s/base/prometheusrule.yaml` assume
Prometheus Operator (`kube-prometheus-stack`). Both carry a `release:
kube-prometheus-stack` label — Prometheus's `serviceMonitorSelector` /
`ruleSelector` usually only picks up objects with that label, so confirm it
matches your Helm release name:

```
kubectl get prometheus -A -o jsonpath='{.items[0].spec.serviceMonitorSelector}'
```

### The alerts, and what each teaches

| Alert | Query idea | What it demonstrates |
|---|---|---|
| `TsTelemetryDemoHighErrorRate` | `sum(rate(...5xx...)) / sum(rate(...))` | The **error ratio** pattern: two `rate()` counters divided, not a raw count. |
| `TsTelemetryDemoHighLatencyP95` | `histogram_quantile(0.95, sum(rate(..._bucket[5m])) by (le))` | The standard way to alert on **tail latency** from a `Histogram`. |
| `TsTelemetryDemoScrapeTargetDown` | `up{job="ts-telemetry-demo"} == 0` | The universal **"is Prometheus even scraping this"** meta-alert every service should have. |

## Grafana dashboard

Import `grafana/dashboard.json` (Dashboards → New → Import → Upload JSON),
pick your Prometheus datasource when prompted. Panels:

1. **Request rate by status code** — `rate(http_requests_total[1m])` by
   `status_code`, stacked. The "Rate" in RED.
2. **Error rate (%)** — 5xx rate over total rate, as a gauge with the same
   10%/20% thresholds as the error-rate alert.
3. **Requests in last 15m** — `increase()` as a single stat number.
4. **Latency percentiles (p50/p95/p99)** — three `histogram_quantile()`
   traces over the same `_bucket` series. The "Duration" in RED.
5. **Simulated work outcomes** — the app-level `simulated_work_total` counter,
   split by outcome, independent of the HTTP layer.
6. **Node.js heap usage** — `nodejs_heap_size_used_bytes` vs
   `nodejs_heap_size_total_bytes` from prom-client's default metrics.
7. **Event loop lag** — `nodejs_eventloop_lag_seconds`; watch it rise if you
   add CPU-bound work to `/work`.
8. **Scrape target up** — `up{job="ts-telemetry-demo"}` as a state timeline,
   the same signal the `ScrapeTargetDown` alert watches.

## Local test without Kubernetes

```
cd app
npm install
npm run build && npm start
# or: npm run dev
```

```
curl localhost:3000/work
curl localhost:3000/metrics | grep -E 'http_requests_total|simulated_work_total'
```
