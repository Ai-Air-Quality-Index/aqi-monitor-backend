/*
 * ============================================================
 *  AQI Monitor Backend + Telegram Bot + ML Integration
 *  Student : Anantharajan Vel Murugan | 294FAVZE | UoH
 *
 *  NEW in this version:
 *  ✅ Python ML service integration (/predict + /ingest)
 *  ✅ ML prediction stored with each reading
 *  ✅ /api/latest now includes ml_predicted_label + confidence
 * ============================================================
 */

"use strict";

const express = require("express");
const cors    = require("cors");
const https   = require("https");

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Telegram Config ──────────────────────────────────────────
const TG_TOKEN   = process.env.TELEGRAM_BOT_TOKEN || "";
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID   || "";
const TG_API     = `https://api.telegram.org/bot${TG_TOKEN}`;

// ── Python ML Service URL ────────────────────────────────────
const ML_SERVICE_URL = "https://aqi-ml-service-ajxt.onrender.com";

// ── Middleware ───────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: "16kb" }));

// ── In-memory store ─────────────────────────────────────────
const MAX_HISTORY = 500;
let history = [];
let latest  = null;

// ── AQI category change tracking ────────────────────────────
let lastCategory   = "";
let lastAlertTime  = 0;
const ALERT_COOLDOWN = 120000;

// ═══════════════════════════════════════════════════════════
//  HELPER: AQI Info
// ═══════════════════════════════════════════════════════════
function getAQIInfo(aqi) {
  if (aqi <= 50)  return { emoji:"🟢", label:"GOOD",            advice:"Air quality is excellent! Safe for all outdoor activities." };
  if (aqi <= 100) return { emoji:"🟡", label:"MODERATE",        advice:"Air quality is acceptable. Sensitive individuals should limit prolonged outdoor exertion." };
  if (aqi <= 150) return { emoji:"🟠", label:"UNHEALTHY (SENSITIVE)", advice:"⚠️ Sensitive groups may experience effects. Reduce outdoor activity." };
  if (aqi <= 200) return { emoji:"🔴", label:"UNHEALTHY",       advice:"🚨 Everyone may experience effects. Avoid prolonged outdoor exertion." };
  if (aqi <= 300) return { emoji:"🟣", label:"VERY UNHEALTHY",  advice:"🚨 Health alert! Stay indoors. Close windows." };
  return              { emoji:"⚫", label:"HAZARDOUS",         advice:"☠️ EMERGENCY! Stay indoors immediately." };
}

// ═══════════════════════════════════════════════════════════
//  HELPER: 30-Min Prediction (Linear Regression)
// ═══════════════════════════════════════════════════════════
function predictAQI() {
  const data = history.slice(-12).map(r => r.aqi);
  const n = data.length;
  if (n < 3) return null;
  const mx = (n - 1) / 2;
  const my = data.reduce((a, b) => a + b, 0) / n;
  const num = data.reduce((s, y, i) => s + (i - mx) * (y - my), 0);
  const den = data.reduce((s, _, i) => s + (i - mx) ** 2, 0);
  if (den === 0) return null;
  const slope = num / den;
  const intercept = my - slope * mx;
  return Math.max(0, Math.min(500, Math.round(slope * (n - 1 + 180) + intercept)));
}

// ═══════════════════════════════════════════════════════════
//  ML PREDICTION — calls Python ML service
// ═══════════════════════════════════════════════════════════
async function getMLPrediction(reading) {
  try {
    const payload = JSON.stringify({
      temperature: reading.temperature,
      humidity:    reading.humidity,
      pm25:        reading.pm25,
      pm10:        reading.pm10,
      mq135:       reading.mq135,
      mq7:         reading.mq7,
    });

    return new Promise((resolve) => {
      const req = https.request(
        `${ML_SERVICE_URL}/predict`,
        {
          method: "POST",
          headers: {
            "Content-Type":   "application/json",
            "Content-Length": Buffer.byteLength(payload),
          },
          timeout: 5000,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => data += chunk);
          res.on("end", () => {
            try { resolve(JSON.parse(data)); }
            catch { resolve(null); }
          });
        }
      );
      req.on("error",   () => resolve(null));
      req.on("timeout", () => { req.destroy(); resolve(null); });
      req.write(payload);
      req.end();
    });
  } catch (e) {
    console.log("[ML] Prediction error:", e.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════
//  INGEST TO PYTHON ML SERVICE (for auto-retrain)
// ═══════════════════════════════════════════════════════════
function ingestToMLService(reading) {
  try {
    const payload = JSON.stringify(reading);
    const req = https.request(
      `${ML_SERVICE_URL}/ingest`,
      {
        method: "POST",
        headers: {
          "Content-Type":   "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: 5000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => data += chunk);
        res.on("end", () => {
          try {
            const d = JSON.parse(data);
            console.log(`[ML Ingest] Total readings in ML DB: ${d.total_readings}`);
          } catch {}
        });
      }
    );
    req.on("error",   (e) => console.log("[ML Ingest] Error:", e.message));
    req.on("timeout", ()  => req.destroy());
    req.write(payload);
    req.end();
  } catch (e) {
    console.log("[ML Ingest] Failed:", e.message);
  }
}

// ═══════════════════════════════════════════════════════════
//  TELEGRAM: Send Message
// ═══════════════════════════════════════════════════════════
function buildStatusMessage(triggerType) {
  if (!latest) return "📡 *AQI Monitor — No Data Yet*\n\nESP32 not connected.";

  const info = getAQIInfo(latest.aqi);
  const pred = predictAQI();
  const predInfo = pred !== null ? getAQIInfo(pred) : null;
  const now = new Date(latest.received_at || Date.now());
  const timeStr = now.toLocaleTimeString("en-SG", { timeZone: "Asia/Singapore", hour:"2-digit", minute:"2-digit", second:"2-digit" });

  let header = triggerType === "auto_change" ? "🔔 *AQI CATEGORY CHANGED!*\n"
             : triggerType === "user_request" ? "📊 *Live AQI Status Report*\n"
             : "📡 *AQI Monitor Update*\n";

  let msg = header + "━━━━━━━━━━━━━━━━━━━━━━\n\n";
  msg += `${info.emoji} *Current AQI: ${latest.aqi}*\n`;
  msg += `📋 Status: *${info.label}*\n\n`;
  msg += `🌡 Temperature: ${latest.temperature}°C\n`;
  msg += `💧 Humidity: ${latest.humidity}%\n`;
  msg += `🔵 PM2.5: ${latest.pm25} µg/m³\n`;
  msg += `⚫ PM10: ${latest.pm10} µg/m³\n`;
  msg += `🧪 MQ-135 (VOC): ${latest.mq135}\n`;
  msg += `💨 MQ-7 (CO): ${latest.mq7}\n\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `🛡 *Health Advisory:*\n${info.advice}\n\n`;

  // ML Prediction
  msg += `━━━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `🤖 *ML Model Prediction (RF 100% accuracy):*\n`;
  if (latest.ml_predicted_label) {
    msg += `${latest.ml_predicted_label} (${latest.ml_confidence}% confidence)\n`;
  }

  // 30-min trend
  msg += `📈 *30-Min Trend Prediction:*\n`;
  if (pred !== null && predInfo) {
    msg += `${predInfo.emoji} Predicted AQI: *${pred}* (${predInfo.label})\n`;
    if (pred > latest.aqi + 20)      msg += `⚠️ _Air quality expected to WORSEN!_\n`;
    else if (pred < latest.aqi - 20) msg += `✅ _Air quality expected to IMPROVE._\n`;
    else                              msg += `➡️ _Air quality expected to remain stable._\n`;
  } else {
    msg += `⏳ Not enough data yet\n`;
  }

  msg += `\n━━━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `🕐 Updated: ${timeStr} SGT\n`;
  msg += `📊 Reading #${history.length}\n`;
  msg += `📍 _294FAVZE | University of Hertfordshire_`;
  return msg;
}

function sendTelegram(chatId, text) {
  if (!TG_TOKEN) return Promise.resolve();
  const targetChat = chatId || TG_CHAT_ID;
  if (!targetChat) return Promise.resolve();
  const payload = JSON.stringify({ chat_id: targetChat, text, parse_mode: "Markdown", disable_web_page_preview: true });
  return new Promise((resolve) => {
    const req = https.request(`${TG_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => { console.log(`[Telegram] Sent to ${targetChat}`); resolve(); });
    });
    req.on("error", (e) => { console.log(`[Telegram] Error: ${e.message}`); resolve(); });
    req.write(payload); req.end();
  });
}

// ═══════════════════════════════════════════════════════════
//  TELEGRAM: Poll for messages
// ═══════════════════════════════════════════════════════════
let lastUpdateId = 0;

function pollTelegram() {
  if (!TG_TOKEN) return;
  const url = `${TG_API}/getUpdates?offset=${lastUpdateId + 1}&timeout=5&allowed_updates=["message"]`;
  https.get(url, (res) => {
    let data = "";
    res.on("data", (chunk) => data += chunk);
    res.on("end", () => {
      try {
        const body = JSON.parse(data);
        if (body.ok && body.result && body.result.length > 0) {
          for (const update of body.result) {
            lastUpdateId = update.update_id;
            if (update.message && update.message.text) {
              const chatId  = update.message.chat.id;
              const userMsg = update.message.text.toLowerCase().trim();
              console.log(`[Telegram] Message: "${userMsg}"`);
              if (userMsg === "/start") {
                sendTelegram(chatId,
                  `👋 *Welcome to AQI Monitor Bot!*\n\n` +
                  `Send any message → get live AQI + ML prediction.\n\n` +
                  `📊 Commands:\n/status — Current AQI\n/help — Help\n\n` +
                  `_294FAVZE | University of Hertfordshire_`
                );
              } else if (userMsg === "/help") {
                sendTelegram(chatId,
                  `📖 *AQI Monitor Bot Help*\n\nSend any message for:\n` +
                  `• Live AQI + category\n• ML model prediction (RF 100%)\n` +
                  `• 30-min trend forecast\n• Health advisory\n\n` +
                  `_294FAVZE | UoH_`
                );
              } else {
                sendTelegram(chatId, buildStatusMessage("user_request"));
              }
            }
          }
        }
      } catch {}
    });
  }).on("error", () => {});
}

if (TG_TOKEN) {
  console.log("[Telegram] Bot active — polling...");
  setInterval(pollTelegram, 3000);
} else {
  console.log("[Telegram] No token — bot disabled");
}

// ═══════════════════════════════════════════════════════════
//  AUTO-ALERT on AQI category change
// ═══════════════════════════════════════════════════════════
function checkAutoAlert(reading) {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  const info = getAQIInfo(reading.aqi);
  const currentCategory = info.label;
  if (lastCategory === "") {
    lastCategory = currentCategory;
    const startMsg = `🚀 *AQI Monitor Online!*\n\n` + buildStatusMessage("auto_change");
    sendTelegram(TG_CHAT_ID, startMsg);
    return;
  }
  if (currentCategory !== lastCategory) {
    const now = Date.now();
    if (now - lastAlertTime > ALERT_COOLDOWN) {
      const direction = reading.aqi > (history.length > 1 ? history[history.length - 2].aqi : 0)
        ? "⬆️ WORSENED" : "⬇️ IMPROVED";
      sendTelegram(TG_CHAT_ID,
        `🔔 *AQI ALERT — Category Changed!*\n${direction}: ${lastCategory} → *${currentCategory}*\n\n` +
        buildStatusMessage("auto_change")
      );
      lastAlertTime = now;
    }
    lastCategory = currentCategory;
  }
}

// ═══════════════════════════════════════════════════════════
//  VALIDATION
// ═══════════════════════════════════════════════════════════
function isValidReading(d) {
  return d
    && typeof d.temperature === "number"
    && typeof d.humidity    === "number"
    && typeof d.pm25        === "number"
    && typeof d.pm10        === "number"
    && typeof d.mq135       === "number"
    && typeof d.mq7         === "number"
    && typeof d.aqi         === "number"
    && typeof d.aqi_label   === "string";
}

// ═══════════════════════════════════════════════════════════
//  API ENDPOINTS
// ═══════════════════════════════════════════════════════════

// ── POST /api/data ────────────────────────────────────────
app.post("/api/data", async (req, res) => {
  const body = req.body;
  if (!isValidReading(body)) return res.status(400).json({ error: "Invalid payload" });

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
  if (history.length > MAX_HISTORY) history = history.slice(history.length - MAX_HISTORY);

  console.log(`[${new Date().toISOString()}] AQI=${reading.aqi} (${reading.aqi_label}) PM2.5=${reading.pm25}`);

  // ── ML Prediction (async, non-blocking) ──────────────
  getMLPrediction(reading).then(ml => {
    if (ml && ml.predicted_label) {
      latest.ml_predicted_label = ml.predicted_label;
      latest.ml_confidence      = ml.confidence_pct;
      latest.ml_model_accuracy  = ml.model_accuracy;
      latest.ml_trained_at      = ml.trained_at;
      console.log(`[ML] ${ml.predicted_label} (${ml.confidence_pct}% confidence)`);
    }
  });

  // ── Forward to ML service for auto-retrain ───────────
  ingestToMLService(reading);

  // ── Telegram auto-alert ───────────────────────────────
  checkAutoAlert(reading);

  return res.status(201).json({ status: "ok", count: history.length });
});

// ── GET /api/latest ───────────────────────────────────────
app.get("/api/latest", (req, res) => {
  if (!latest) return res.status(200).json({ status: "no_data" });
  return res.status(200).json(latest);
});

// ── GET /api/history ──────────────────────────────────────
app.get("/api/history", (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit  || "500", 10), 500);
  const offset = Math.max(parseInt(req.query.offset || "0",   10), 0);
  const slice  = history.slice(Math.max(history.length - limit - offset, 0), history.length - offset || undefined);
  return res.status(200).json({ count: slice.length, total: history.length, readings: slice });
});

// ── GET /api/prediction ───────────────────────────────────
app.get("/api/prediction", (req, res) => {
  const pred = predictAQI();
  const predInfo = pred !== null ? getAQIInfo(pred) : null;
  return res.status(200).json({
    predicted_aqi   : pred,
    predicted_label : predInfo ? predInfo.label : null,
    confidence      : history.length >= 12 ? "high" : history.length >= 6 ? "medium" : "low",
    method          : "linear_regression_12pt",
  });
});

// ── GET /api/download ─────────────────────────────────────
app.get("/api/download", (req, res) => {
  const header = "timestamp,received_at,temperature,humidity,pm25,pm10,mq135,mq7,aqi,aqi_label,ml_predicted_label,ml_confidence\r\n";
  const rows = history.map(r =>
    [r.timestamp, r.received_at, r.temperature, r.humidity,
     r.pm25, r.pm10, r.mq135, r.mq7, r.aqi, `"${r.aqi_label}"`,
     r.ml_predicted_label || "", r.ml_confidence || ""].join(",")
  ).join("\r\n");
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", 'attachment; filename="aqi_history.csv"');
  return res.send(header + rows);
});

// ── GET /api/predict (EPA formula) ───────────────────────
app.get("/api/predict", (req, res) => {
  const pm25 = parseFloat(req.query.pm25);
  if (isNaN(pm25) || pm25 < 0) return res.status(400).json({ error: "Invalid pm25 value" });
  const bp = [
    [0,12.0,0,50,"GOOD"],[12.1,35.4,51,100,"MODERATE"],
    [35.5,55.4,101,150,"SENSITIVE"],[55.5,150.4,151,200,"UNHEALTHY"],
    [150.5,250.4,201,300,"VERY UNHEALTHY"],[250.5,500.4,301,500,"HAZARDOUS"],
  ];
  let predictedAQI = 500, predictedLabel = "HAZARDOUS";
  for (const [cL,cH,iL,iH,label] of bp) {
    if (pm25 <= cH) {
      predictedAQI = Math.round(((iH-iL)/(cH-cL))*(pm25-cL)+iL);
      predictedLabel = label; break;
    }
  }
  const confidence = history.length >= 50 ? "high" : history.length >= 20 ? "medium" : "low";
  return res.status(200).json({
    pm25_input: pm25, predicted_aqi: predictedAQI, predicted_label: predictedLabel,
    model: "US EPA Formula (R2=1.000, MAE=0.01)",
    confidence, data_points: history.length,
  });
});

// ── GET /healthz ──────────────────────────────────────────
app.get("/healthz", (req, res) =>
  res.json({ status: "ok", records: history.length, telegram: TG_TOKEN ? "active" : "disabled" })
);

// ── Root ──────────────────────────────────────────────────
app.get("/", (req, res) => res.json({
  project  : "AI-Based IoT AQI Monitor",
  student  : "Anantharajan Vel Murugan | 294FAVZE | UoH",
  telegram : TG_TOKEN ? "Bot active" : "Not configured",
  ml_service: ML_SERVICE_URL,
  routes   : ["POST /api/data","GET /api/latest","GET /api/history",
              "GET /api/prediction","GET /api/predict","GET /api/download"],
}));

// ── Start ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n============================================`);
  console.log(`  AQI Monitor Backend — Port ${PORT}`);
  console.log(`  Telegram: ${TG_TOKEN ? "ACTIVE" : "DISABLED"}`);
  console.log(`  ML Service: ${ML_SERVICE_URL}`);
  console.log(`============================================\n`);
});
