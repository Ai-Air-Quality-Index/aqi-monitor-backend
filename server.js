/*
 * ============================================================
 *  AQI Monitor — Backend Server
 *  Student: ANANTHARAJAN VEL MURUGAN | ID: 294FAVZE
 *  University of Hertfordshire
 *  Deploy FREE on Render.com
 * ============================================================
 */

const express    = require('express');
const cors       = require('cors');
const app        = express();
const PORT       = process.env.PORT || 3000;

// ── Middleware ──────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── In-memory storage (500 readings max) ───────────────────
let readings   = [];
let latestData = null;
const MAX_READINGS = 500;

// ── Root endpoint ──────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    project : "AI-Based IoT AQI Monitor",
    student : "Anantharajan Vel Murugan | 294FAVZE | UoH",
    status  : "online",
    records : readings.length,
    routes  : [
      "/api/data (POST)   — ESP32 sends data here",
      "/api/latest (GET)  — latest reading",
      "/api/history (GET) — last 500 readings",
      "/api/download (GET)— download CSV",
      "/healthz (GET)     — health check"
    ]
  });
});

// ── Health check ───────────────────────────────────────────
app.get('/healthz', (req, res) => {
  res.json({ status: "ok", records: readings.length });
});

// ── POST /api/data — ESP32 sends here ──────────────────────
app.post('/api/data', (req, res) => {
  const d = req.body;

  // Validate required fields
  if (d.aqi === undefined || d.pm25 === undefined) {
    return res.status(400).json({ error: "Missing required fields: aqi, pm25" });
  }

  const reading = {
    temperature : parseFloat(d.temperature) || 0,
    humidity    : parseFloat(d.humidity)    || 0,
    pm25        : parseFloat(d.pm25)        || 0,
    pm10        : parseFloat(d.pm10)        || 0,
    mq135       : parseInt(d.mq135)         || 0,
    mq7         : parseInt(d.mq7)           || 0,
    aqi         : parseInt(d.aqi)           || 0,
    aqi_label   : d.aqi_label              || "Unknown",
    timestamp   : Date.now()
  };

  // Store reading
  readings.push(reading);
  if (readings.length > MAX_READINGS) readings.shift(); // ring buffer
  latestData = reading;

  console.log(`[${new Date().toISOString()}] AQI=${reading.aqi} PM2.5=${reading.pm25} T=${reading.temperature}°C`);
  res.json({ status: "ok", received: reading });
});

// ── GET /api/latest — dashboard polls this ─────────────────
app.get('/api/latest', (req, res) => {
  if (!latestData) {
    return res.json({ status: "no_data", message: "Waiting for ESP32..." });
  }
  res.json({ status: "ok", data: latestData });
});

// ── GET /api/history — chart data ─────────────────────────
app.get('/api/history', (req, res) => {
  const limit = parseInt(req.query.limit) || 500;
  const data  = readings.slice(-limit);
  res.json({
    status  : "ok",
    count   : data.length,
    total   : readings.length,
    readings: data
  });
});

// ── GET /api/download — download CSV for ML training ───────
app.get('/api/download', (req, res) => {
  if (readings.length === 0) {
    return res.status(404).json({ error: "No data yet" });
  }
  const header = "timestamp,temperature_c,humidity_pct,pm25_ugm3,pm10_ugm3,mq135_raw,mq7_raw,aqi,aqi_label\n";
  const rows   = readings.map(r =>
    `${r.timestamp},${r.temperature},${r.humidity},${r.pm25},${r.pm10},${r.mq135},${r.mq7},${r.aqi},${r.aqi_label}`
  ).join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="aqi_sensor_data.csv"');
  res.send(header + rows);
});

// ── Start server ───────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`AQI Monitor backend running on port ${PORT}`);
  console.log(`POST data to /api/data`);
  console.log(`GET latest from /api/latest`);
});
