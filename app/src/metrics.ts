import client from "prom-client";

// One registry for everything this process exposes at /metrics.
export const register = new client.Registry();

// Standard Node.js process/runtime metrics: process_cpu_seconds_total,
// process_resident_memory_bytes, nodejs_eventloop_lag_seconds,
// nodejs_heap_size_used_bytes, nodejs_gc_duration_seconds, etc.
// Left unprefixed so they show up under their well-known, googleable names.
client.collectDefaultMetrics({ register });

// The three metrics behind almost every "RED method" (Rate/Errors/Duration)
// HTTP dashboard you'll ever build.
export const httpRequestsTotal = new client.Counter({
  name: "http_requests_total",
  help: "Total number of HTTP requests received",
  labelNames: ["method", "route", "status_code"] as const,
  registers: [register],
});

export const httpRequestDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status_code"] as const,
  // Buckets tuned for a demo endpoint with 10-260ms of simulated latency.
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [register],
});

// App-level counter of simulated work outcomes, independent of HTTP status
// codes, to show that you're not limited to instrumenting the transport layer.
export const simulatedWorkTotal = new client.Counter({
  name: "simulated_work_total",
  help: "Simulated units of work processed, by outcome",
  labelNames: ["outcome"] as const,
  registers: [register],
});
