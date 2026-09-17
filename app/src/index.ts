import express from "express";
import {
  register,
  httpRequestsTotal,
  httpRequestDuration,
  simulatedWorkTotal,
} from "./metrics";

const PORT = Number(process.env.PORT ?? 3000);
// Background loop that hits /work on its own, so the dashboards show live,
// fluctuating data right after deploy without any external load generator.
const SELF_TRAFFIC = (process.env.SELF_TRAFFIC ?? "true") === "true";
// Baseline chance any /work call fails, so the error-rate panels/alerts have
// something non-zero to show. Override per-request with ?fail=true.
const ERROR_RATE = Number(process.env.ERROR_RATE ?? 0.1);

const app = express();

// Records rate + duration for every request except scrapes of /metrics
// itself, which would otherwise pollute its own counters.
app.use((req, res, next) => {
  if (req.path === "/metrics") return next();
  const route = req.path;
  const stopTimer = httpRequestDuration.startTimer({ method: req.method, route });
  res.on("finish", () => {
    const labels = { method: req.method, route, status_code: String(res.statusCode) };
    httpRequestsTotal.inc(labels);
    stopTimer(labels);
  });
  next();
});

app.get("/healthz", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

// The one "business" endpoint: simulates variable latency and a configurable
// failure rate so there's something interesting to graph and alert on.
app.get("/work", (req, res) => {
  const requestedDelay = Number(req.query.delayMs);
  const delayMs = Number.isFinite(requestedDelay) ? requestedDelay : Math.random() * 250 + 10;
  const shouldFail = req.query.fail === "true" || Math.random() < ERROR_RATE;

  setTimeout(() => {
    if (shouldFail) {
      simulatedWorkTotal.inc({ outcome: "error" });
      res.status(500).json({ status: "error" });
    } else {
      simulatedWorkTotal.inc({ outcome: "success" });
      res.status(200).json({ status: "ok", delayMs });
    }
  }, delayMs);
});

app.get("/metrics", async (_req, res) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});

app.listen(PORT, () => {
  console.log(`ts-telemetry-demo listening on :${PORT}`);
});

if (SELF_TRAFFIC) {
  const generateTraffic = () => {
    fetch(`http://127.0.0.1:${PORT}/work`).catch(() => {
      // Ignore: transient failures here are just missing self-traffic, not
      // something this process needs to react to.
    });
    setTimeout(generateTraffic, 200 + Math.random() * 600);
  };
  setTimeout(generateTraffic, 2000);
}
