# SLOs, SLIs, and error budgets

Rules live in `k8s/base/prometheusrule-slo.yaml`. Scope is the `GET /work`
endpoint (the only user-facing "business" route); `/healthz` and `/metrics`
are excluded because they don't represent user experience.

## SLIs and SLOs

| | SLI (good events / valid events) | SLO | Window | Error budget |
|---|---|---|---|---|
| Availability | `/work` requests with status `< 500` / all `/work` requests | 99.9% | 30d rolling | 0.1% of requests (~43 min of total outage) |
| Latency | `/work` requests completing in `<= 250ms` / all `/work` requests | 95% | 30d rolling | 5% of requests |

Why these numbers:

- **Latency threshold 250ms** is an existing histogram bucket
  (`le="0.25"`), so the SLI is exact rather than interpolated. The simulated
  work is uniform 10-260ms, so a healthy service sits at ~96% under 250ms;
  95% leaves little slack, which is realistic for a latency SLO.
- **Client errors (4xx) count as good.** They're caller mistakes, not service
  failures. Only 5xx burns availability budget.
- The app's default `ERROR_RATE=0.1` means ~10% of `/work` calls return 500.
  Against a 99.9% target that's a **100x burn rate**, so the fast-burn alert
  will fire almost immediately after deploy. That's deliberate for a lab (you
  can watch it fire), but set `ERROR_RATE=0.0005` in `deployment.yaml` to see
  a healthy service with budget to spare.

## Recorded series

| Series | Meaning |
|---|---|
| `slo:availability_error_ratio:rate{5m,30m,1h,6h,3d,30d}` | Fraction of `/work` requests that were 5xx |
| `slo:latency_error_ratio:rate{5m,30m,1h,6h,3d,30d}` | Fraction of `/work` requests slower than 250ms |
| `slo:availability_error_budget_remaining:ratio` | `1 - error_ratio_30d / 0.001`. 1 = full, 0 = spent, < 0 = SLO breached |
| `slo:latency_error_budget_remaining:ratio` | `1 - error_ratio_30d / 0.05` |

Burn rate at any moment = `slo:*_error_ratio:rate1h / allowed_ratio`
(0.001 for availability, 0.05 for latency). A burn rate of 1 spends the budget
in exactly 30 days; 14.4 spends it in ~2 days.

## Alerts (multi-window, multi-burn-rate)

Each alert requires both a long window (sustained) and a short window (still
happening), so it resolves quickly after a fix. Same three tiers for both SLOs:

| Alert suffix | Burn | Windows | Budget consumed | Severity |
|---|---|---|---|---|
| `BurnFast` | 14.4x | 1h and 5m | 2% in 1h | critical (page) |
| `BurnSlow` | 6x | 6h and 30m | 5% in 6h | critical (page) |
| `BudgetTrend` | 1x | 3d and 6h | on pace to exhaust | warning (ticket) |

The older symptom alerts in `prometheusrule.yaml` (`HighErrorRate` >20%,
`HighLatencyP95` >300ms) still exist. They're now redundant with the burn
alerts and are candidates for removal once you trust the SLO alerts.

## Error budget policy (proposed)

| Budget remaining | Action |
|---|---|
| > 50% | Normal feature work and releases |
| 25-50% | Review recent incidents; prefer low-risk changes |
| 0-25% | Reliability work takes priority; releases need extra review |
| <= 0 | Freeze non-reliability releases until back above 0 |

Edit to fit your team; the point is that the budget drives a decision.

## Caveats

- **Retention:** the 30d rules need Prometheus retention >= 30d. `monitoring` repo `kube-prometheus-stack/base/values.yaml` sets `retention: 35d`. Prometheus stores its TSDB on a 20Gi `gp2` PVC (same values file), so history survives pod restarts.
- **Restarts and new deploys:** counters reset, but `rate()` handles that.
  There's no traffic-floor guard, so a very low-traffic window yields noisy
  ratios; irrelevant here because self-traffic gives ~2 req/s.
- **Rule validation:** `promtool check rules` passes (20 rules). Check the rules
  loaded with `kubectl get prometheusrule -n ts-telemetry-demo` and the
  Prometheus UI's Rules/Alerts pages after ArgoCD syncs.
