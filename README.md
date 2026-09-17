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
2. **This repo is private** (unlike the public `memory-hog` repo this project
   was modeled on), so ArgoCD needs its own git credentials — a cluster-wide
   ArgoCD instance with no stored repo credentials otherwise gets
   `authentication required: Repository not found`. Create one repository
   credential secret per private repo:
   ```
   kubectl create secret generic repo-ts-telemetry-demo \
     --namespace argocd \
     --from-literal=type=git \
     --from-literal=url=https://github.com/jvcastaneda/ts-telemetry-demo.git \
     --from-literal=username=<gh-username> \
     --from-literal=password=<PAT with repo scope>
   kubectl label secret repo-ts-telemetry-demo -n argocd \
     argocd.argoproj.io/secret-type=repository
   ```
3. Apply the Application: `kubectl apply -f argocd/application.yaml`.
4. ArgoCD syncs `k8s/base` (a Kustomize base) automatically: creates the
   `ts-telemetry-demo` namespace, `Deployment`, `Service`, `ServiceMonitor`,
   `PrometheusRule`, and the Grafana dashboard `ConfigMap`, and
   self-heals/prunes on drift from git.

If ArgoCD's `repo-server` isn't healthy in your cluster (check `kubectl get
pods -n argocd`), you can apply the same manifests directly at any time:
`kubectl apply -k k8s/base`. Once `repo-server` recovers and you've pushed to
git, ArgoCD's `selfHeal` will reconcile against the same state with no
conflict.

## A note on cluster capacity

Deploying this ran into the cluster being at its **pod-count limit**, not a
CPU/memory limit: two `t3.small` nodes each cap out at 11 pods (an
ENI/IP-per-instance-type limit set by `nodeadm` at boot, independent of the
VPC CNI's prefix-delegation setting), and always-on infra (ArgoCD,
kube-prometheus-stack, CNI/CSI daemons, coredns, kube-proxy) already filled
both. Symptom: `FailedScheduling ... Too many pods` in `kubectl describe pod`.
Fixed by scaling one managed node group from 1 to 2 desired nodes (plain
ASG scale-out, no disruption to already-running pods):

```
aws eks update-nodegroup-config \
  --cluster-name codebee-lab-4d1yUc8d \
  --nodegroup-name node-group-2-20260826130618915800000018 \
  --scaling-config minSize=1,maxSize=2,desiredSize=2 \
  --region us-west-1
```

Raising max-pods-per-node on the *existing* two nodes instead would require
editing the managed node group's launch template to set an explicit kubelet
`maxPods` and rolling the node group onto it — and since both node groups
here are `min=1/max=1`, that rollover has no surge capacity, so it terminates
a node before its replacement is ready (a brief real outage for whatever was
running there). Adding a node was the non-disruptive path; revisit prefix
delegation + a proper rollover only if you also bump a node group's max size
to allow a surge node first.

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

`k8s/base/grafana-dashboard-configmap.yaml` wraps `grafana/dashboard.json` in
a ConfigMap labeled `grafana_dashboard: "1"`. kube-prometheus-stack's Grafana
runs a sidecar (`grafana-sc-dashboard`) that watches all namespaces for that
label and loads matching ConfigMaps automatically — the dashboard just shows
up under the "General" folder within a minute of `kubectl apply -k`, no
manual import, no admin credentials needed. The panels hardcode the
Prometheus datasource `uid: prometheus`, matching kube-prometheus-stack's
default datasource — check yours with:

```
kubectl get configmap -n monitoring kube-prometheus-stack-grafana-datasource -o jsonpath='{.data.datasource\.yaml}'
```

If you'd rather import it by hand elsewhere, `grafana/dashboard.json` is the
same content on its own (Dashboards → New → Import → Upload JSON). Panels:

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
