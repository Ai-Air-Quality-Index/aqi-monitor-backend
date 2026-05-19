/*
 * ============================================================
 *  AQI Monitor — Backend Server (Node.js / Express)
 *  Student : Anantharajan Vel Murugan | ID: 294FAVZE | UoH
 *
 *  Endpoints
 *  ---------
 *  POST /api/data      ← ESP32 sends every 10 s
 *  GET  /api/latest    ← dashboard polls for current reading
 *  GET  /api/history   ← dashboard polls for last 500 readings
 *  GET  /api/download  ← download full history as CSV
 *  GET  /healthz       ← Render.com health check
 * ============================================================
 */

"use strict";

const express  = require("express");
const cors     = require("cors");

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────
app.use(cors());                       // allow browser & ESP32 from any origin
app.use(express.json({ limit: "16kb" }));

// ── In-memory store ──────────────────────────────────────────
const MAX_HISTORY = 500;
let history = [];      // circular buffer of last 500 readings
let latest  = null;    // most recent reading

// ── Validation helper ────────────────────────────────────────
function isValidReading(d) {
  return (
    d &&
    typeof d.temperature === "number" &&
    typeof d.humidity    === "number" &&
    typeof d.pm25        === "number" &&
    typeof d.pm10        === "number" &&
    typeof d.mq135       === "number" &&
    typeof d.mq7         === "number" &&
    typeof d.aqi         === "number" &&
    typeof d.aqi_label   === "string"
  );
}

// ── POST /api/data ────────────────────────────────────────────
// Receives JSON from ESP32 and stores it.
app.post("/api/data", (req, res) => {
  const body = req.body;

  if (!isValidReading(body)) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  // Stamp server-side received_at so dashboard has a reliable time source
  const reading = {
    temperature : body.temperature,
    humidity    : body.humidity,
    pm25        : body.pm25,
    pm10        : body.pm10,
    mq135       : body.mq135,
    mq7         : body.mq7,
    aqi         : body.aqi,
    aqi_label   : body.aqi_label,
    timestamp   : body.timestamp || Math.floor(Date.now() / 1000),
    received_at : Date.now(),
  };

  latest = reading;
  history.push(reading);

  // Keep only the last MAX_HISTORY entries
  if (history.length > MAX_HISTORY) {
    history = history.slice(history.length - MAX_HISTORY);
  }

  console.log(
    `[${new Date().toISOString()}] AQI=${reading.aqi} (${reading.aqi_label}) ` +
    `PM2.5=${reading.pm25} Temp=${reading.temperature} Hum=${reading.humidity}`
  );

  return res.status(201).json({ status: "ok", count: history.length });
});

// ── GET /api/latest ───────────────────────────────────────────
app.get("/api/latest", (req, res) => {
  if (!latest) {
    return res.status(200).json({ status: "no_data" });
  }
  return res.status(200).json(latest);
});

// ── GET /api/history ──────────────────────────────────────────
// Optional query params: limit (default 500), offset (default 0)
app.get("/api/history", (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit  || "500", 10), 500);
  const offset = Math.max(parseInt(req.query.offset || "0",   10), 0);

  const slice = history.slice(
    Math.max(history.length - limit - offset, 0),
    history.length - offset || undefined
  );

  return res.status(200).json({
    count   : slice.length,
    total   : history.length,
    readings: slice,
  });
});

// ── GET /api/download ─────────────────────────────────────────
// Returns all stored readings as a CSV file download.
app.get("/api/download", (req, res) => {
  const header = "timestamp,received_at,temperature,humidity,pm25,pm10,mq135,mq7,aqi,aqi_label\r\n";
  const rows   = history.map(r =>
    [
      r.timestamp,
      r.received_at,
      r.temperature,
      r.humidity,
      r.pm25,
      r.pm10,
      r.mq135,
      r.mq7,
      r.aqi,
      `"${r.aqi_label}"`,
    ].join(",")
  ).join("\r\n");

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", 'attachment; filename="aqi_history.csv"');
  return res.send(header + rows);
});

// ── GET /healthz ──────────────────────────────────────────────
app.get("/healthz", (req, res) =>
  res.json({ status: "ok", records: history.length })
);

// ── Root ──────────────────────────────────────────────────────
app.get("/", (req, res) =>
  res.json({
    project : "AI-Based IoT AQI Monitor",
    student : "Anantharajan Vel Murugan | 294FAVZE | UoH",
    routes  : ["/api/data (POST)", "/api/latest (GET)", "/api/history (GET)", "/api/download (GET)"],
  })
);

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`AQI Backend running on port ${PORT}`);
});
