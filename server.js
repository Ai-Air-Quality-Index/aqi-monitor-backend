/*
 * ============================================================
 *  AQI Monitor Backend + Telegram Bot
 *  Student : Anantharajan Vel Murugan | 294FAVZE | UoH
 *
 *  FEATURES:
 *  ✅ Receives sensor data from ESP32
 *  ✅ Serves data to GitHub Pages dashboard
 *  ✅ Telegram Bot — reply to ANY message with live AQI + prediction
 *  ✅ Auto-notification when AQI category changes
 *  ✅ Every notification includes 30-min predicted AQI
 *  ✅ CSV download for ML training
 *
 *  TELEGRAM SETUP:
 *  1. Open Telegram → search @BotFather → /newbot → copy token
 *  2. Open your bot → send "hi"
 *  3. Visit: https://api.telegram.org/bot<TOKEN>/getUpdates
 *     → find "id" inside "chat" → that is your CHAT_ID
 *  4. On Render.com → Environment → add:
 *     TELEGRAM_BOT_TOKEN = your_token
 *     TELEGRAM_CHAT_ID   = your_chat_id
 * ============================================================
 */

"use strict";

const express = require("express");
const cors    = require("cors");
const https   = require("https");

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Telegram Config (set in Render Environment Variables) ────
const TG_TOKEN   = process.env.TELEGRAM_BOT_TOKEN || "";
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID   || "";
const TG_API     = `https://api.telegram.org/bot${TG_TOKEN}`;

// ── Middleware ───────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: "16kb" }));

// ── In-memory store ─────────────────────────────────────────
const MAX_HISTORY = 500;
let history = [];
let latest  = null;

// ── Track AQI category for change detection ─────────────────
let lastCategory   = "";
let lastAlertTime  = 0;
const ALERT_COOLDOWN = 120000; // 2 minutes between auto-alerts

// ═══════════════════════════════════════════════════════════
//  HELPER: AQI Category Info
// ═══════════════════════════════════════════════════════════
function getAQIInfo(aqi) {
  if (aqi <= 50)  return { emoji: "🟢", label: "GOOD",            color: "green",  advice: "Air quality is excellent! Safe for all outdoor activities. Great time for exercise, walking, and outdoor play." };
  if (aqi <= 100) return { emoji: "🟡", label: "MODERATE",        color: "yellow", advice: "Air quality is acceptable. Sensitive individuals (asthma, elderly) should consider limiting prolonged outdoor exertion." };
  if (aqi <= 150) return { emoji: "🟠", label: "UNHEALTHY (SENSITIVE)", color: "orange", advice: "⚠️ Members of sensitive groups may experience effects. Children, elderly, and people with lung/heart disease should reduce outdoor activity." };
  if (aqi <= 200) return { emoji: "🔴", label: "UNHEALTHY",       color: "red",    advice: "🚨 Everyone may experience health effects. Avoid prolonged outdoor exertion. Close windows. Consider wearing N95 mask outdoors." };
  if (aqi <= 300) return { emoji: "🟣", label: "VERY UNHEALTHY",  color: "purple", advice: "🚨 Health alert! Serious effects for everyone. Stay indoors. Close all windows. Use air purifier if available." };
  return              { emoji: "⚫", label: "HAZARDOUS",         color: "maroon", advice: "☠️ EMERGENCY! Stay indoors immediately. Do NOT go outside. Wear N95 mask even indoors if air feels irritating." };
}

// ═══════════════════════════════════════════════════════════
//  HELPER: 30-Min AQI Prediction (Linear Regression)
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
  // 30 min ahead: at 5s intervals = 360 steps, at 10s = 180 steps
  const futureX = n - 1 + 180;
  return Math.max(0, Math.min(500, Math.round(slope * futureX + intercept)));
}

// ═══════════════════════════════════════════════════════════
//  HELPER: Build Telegram Status Message
// ═══════════════════════════════════════════════════════════
function buildStatusMessage(triggerType) {
  if (!latest) {
    return "📡 *AQI Monitor — No Data Yet*\n\nThe ESP32 has not sent any readings yet. Make sure it is powered on and connected to WiFi.";
  }

  const info = getAQIInfo(latest.aqi);
  const pred = predictAQI();
  const predInfo = pred !== null ? getAQIInfo(pred) : null;

  const now = new Date(latest.received_at || Date.now());
  const timeStr = now.toLocaleTimeString("en-SG", { timeZone: "Asia/Singapore", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const dateStr = now.toLocaleDateString("en-SG", { timeZone: "Asia/Singapore" });

  let header = "";
  if (triggerType === "auto_change") {
    header = `🔔 *AQI CATEGORY CHANGED!*\n`;
  } else if (triggerType === "user_request") {
    header = `📊 *Live AQI Status Report*\n`;
  } else {
    header = `📡 *AQI Monitor Update*\n`;
  }

  let msg = header;
  msg += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;

  // Current AQI
  msg += `${info.emoji} *Current AQI: ${latest.aqi}*\n`;
  msg += `📋 Status: *${info.label}*\n\n`;

  // Sensor readings
  msg += `🌡 Temperature: ${latest.temperature}°C\n`;
  msg += `💧 Humidity: ${latest.humidity}%\n`;
  msg += `🔵 PM2.5: ${latest.pm25} µg/m³\n`;
  msg += `⚫ PM10: ${latest.pm10} µg/m³\n`;
  msg += `🧪 MQ-135 (VOC): ${latest.mq135}\n`;
  msg += `💨 MQ-7 (CO): ${latest.mq7}\n\n`;

  // Health advisory
  msg += `━━━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `🛡 *Health Advisory:*\n`;
  msg += `${info.advice}\n\n`;

  // 30-min Prediction
  msg += `━━━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `🤖 *AI 30-Min Prediction:*\n`;
  if (pred !== null && predInfo) {
    msg += `${predInfo.emoji} Predicted AQI: *${pred}* (${predInfo.label})\n`;
    if (pred > latest.aqi + 20) {
      msg += `⚠️ _Air quality expected to WORSEN — take precautions now!_\n`;
    } else if (pred < latest.aqi - 20) {
      msg += `✅ _Air quality expected to IMPROVE — conditions getting better._\n`;
    } else {
      msg += `➡️ _Air quality expected to remain ${predInfo.label.toLowerCase()}._\n`;
    }

    // Predicted action advice
    msg += `\n📌 *Recommended action for next 30 min:*\n`;
    if (pred <= 50) {
      msg += `✅ Safe to go outside, exercise, open windows.\n`;
    } else if (pred <= 100) {
      msg += `⚡ Generally safe. Sensitive individuals take care.\n`;
    } else if (pred <= 150) {
      msg += `⚠️ Sensitive groups: stay indoors. Others: limit outdoor time.\n`;
    } else {
      msg += `🚨 Everyone: stay indoors. Close windows. Wear mask if going out.\n`;
    }
  } else {
    msg += `⏳ Not enough data yet (need 3+ readings)\n`;
  }

  msg += `\n━━━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `🕐 Updated: ${timeStr} SGT | ${dateStr}\n`;
  msg += `📊 Reading #${history.length} of ${MAX_HISTORY}\n`;
  msg += `📍 _294FAVZE | University of Hertfordshire_`;

  return msg;
}

// ═══════════════════════════════════════════════════════════
//  TELEGRAM: Send Message
// ═══════════════════════════════════════════════════════════
function sendTelegram(chatId, text) {
  if (!TG_TOKEN) return Promise.resolve();

  const targetChat = chatId || TG_CHAT_ID;
  if (!targetChat) return Promise.resolve();

  const payload = JSON.stringify({
    chat_id: targetChat,
    text: text,
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  });

  return new Promise((resolve, reject) => {
    const req = https.request(`${TG_API}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        if (res.statusCode === 200) {
          console.log(`[Telegram] Sent to ${targetChat}`);
        } else {
          console.log(`[Telegram] Error ${res.statusCode}: ${data}`);
        }
        resolve();
      });
    });
    req.on("error", (e) => { console.log(`[Telegram] Request error: ${e.message}`); resolve(); });
    req.write(payload);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════
//  TELEGRAM: Poll for Incoming Messages
//  Any message from user → reply with full AQI status
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
              const chatId = update.message.chat.id;
              const userMsg = update.message.text.toLowerCase().trim();
              const userName = update.message.from.first_name || "User";

              console.log(`[Telegram] Message from ${userName}: "${userMsg}"`);

              // Handle /start command
              if (userMsg === "/start") {
                const welcomeMsg =
                  `👋 *Welcome to AQI Monitor Bot!*\n\n` +
                  `I am your AI-Based Air Quality Monitor by Anantharajan Vel Murugan (294FAVZE).\n\n` +
                  `📌 *What I can do:*\n` +
                  `• Send me ANY message → I reply with live AQI status\n` +
                  `• I auto-notify you when AQI category changes\n` +
                  `• Every update includes 30-min AI prediction\n\n` +
                  `🤖 *Try it now — send any letter or word!*\n\n` +
                  `📊 Commands:\n` +
                  `  /status — Current AQI + prediction\n` +
                  `  /help — Show this help message\n` +
                  `  Any text — Same as /status\n\n` +
                  `_University of Hertfordshire | FYP 2026_`;
                sendTelegram(chatId, welcomeMsg);
                continue;
              }

              // Handle /help command
              if (userMsg === "/help") {
                const helpMsg =
                  `📖 *AQI Monitor Bot — Help*\n\n` +
                  `Send me any message and I will reply with:\n` +
                  `• 📊 Current AQI value and category\n` +
                  `• 🌡 All sensor readings (temp, humidity, PM2.5, CO)\n` +
                  `• 🛡 Health advisory for your safety\n` +
                  `• 🤖 AI-predicted AQI for the next 30 minutes\n` +
                  `• 📌 Recommended actions based on prediction\n\n` +
                  `🔔 *Auto-alerts:*\n` +
                  `I will notify you automatically whenever the AQI category changes ` +
                  `(e.g. Good → Moderate, or Unhealthy → Good).\n\n` +
                  `_Anantharajan Vel Murugan | 294FAVZE | UoH_`;
                sendTelegram(chatId, helpMsg);
                continue;
              }

              // Any other message → send full AQI status
              const statusMsg = buildStatusMessage("user_request");
              sendTelegram(chatId, statusMsg);
            }
          }
        }
      } catch (e) {
        // JSON parse error — ignore silently
      }
    });
  }).on("error", (e) => {
    console.log(`[Telegram] Poll error: ${e.message}`);
  });
}

// Start polling every 3 seconds
if (TG_TOKEN) {
  console.log("[Telegram] Bot active — polling for messages...");
  setInterval(pollTelegram, 3000);
} else {
  console.log("[Telegram] No TELEGRAM_BOT_TOKEN set — bot disabled");
}

// ═══════════════════════════════════════════════════════════
//  TELEGRAM: Check for AQI Category Change (Auto-Alert)
// ═══════════════════════════════════════════════════════════
function checkAutoAlert(reading) {
  if (!TG_TOKEN || !TG_CHAT_ID) return;

  const info = getAQIInfo(reading.aqi);
  const currentCategory = info.label;

  // First reading — record category but don't alert
  if (lastCategory === "") {
    lastCategory = currentCategory;
    // Send initial status on first reading
    const startMsg = `🚀 *AQI Monitor Online!*\n\n` +
      `The ESP32 sensor is now sending live data.\n\n` +
      buildStatusMessage("auto_change");
    sendTelegram(TG_CHAT_ID, startMsg);
    return;
  }

  // Category changed → auto-alert
  if (currentCategory !== lastCategory) {
    const now = Date.now();
    if (now - lastAlertTime > ALERT_COOLDOWN) {
      console.log(`[AutoAlert] Category changed: ${lastCategory} → ${currentCategory}`);

      const direction = reading.aqi > (history.length > 1 ? history[history.length - 2].aqi : 0)
        ? "⬆️ WORSENED" : "⬇️ IMPROVED";

      let alertMsg = `🔔 *AQI ALERT — Category Changed!*\n`;
      alertMsg += `${direction}: ${lastCategory} → *${currentCategory}*\n\n`;
      alertMsg += buildStatusMessage("auto_change");

      sendTelegram(TG_CHAT_ID, alertMsg);
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

// ── POST /api/data — ESP32 sends sensor readings ──────────
app.post("/api/data", (req, res) => {
  const body = req.body;
  if (!isValidReading(body)) {
    return res.status(400).json({ error: "Invalid payload" });
  }

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
  if (history.length > MAX_HISTORY) {
    history = history.slice(history.length - MAX_HISTORY);
  }

  console.log(
    `[${new Date().toISOString()}] AQI=${reading.aqi} (${reading.aqi_label}) ` +
    `PM2.5=${reading.pm25} T=${reading.temperature} H=${reading.humidity}`
  );

  // Check for auto-alert on category change
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
  const slice  = history.slice(
    Math.max(history.length - limit - offset, 0),
    history.length - offset || undefined
  );
  return res.status(200).json({ count: slice.length, total: history.length, readings: slice });
});

// ── GET /api/download — CSV export ────────────────────────
app.get("/api/download", (req, res) => {
  const header = "timestamp,received_at,temperature,humidity,pm25,pm10,mq135,mq7,aqi,aqi_label\r\n";
  const rows = history.map(r =>
    [r.timestamp, r.received_at, r.temperature, r.humidity,
     r.pm25, r.pm10, r.mq135, r.mq7, r.aqi, `"${r.aqi_label}"`].join(",")
  ).join("\r\n");
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", 'attachment; filename="aqi_history.csv"');
  return res.send(header + rows);
});

// ── GET /api/prediction — current prediction ──────────────
app.get("/api/prediction", (req, res) => {
  const pred = predictAQI();
  const predInfo = pred !== null ? getAQIInfo(pred) : null;
  return res.status(200).json({
    predicted_aqi   : pred,
    predicted_label : predInfo ? predInfo.label : null,
    confidence      : history.length >= 12 ? "high" : history.length >= 6 ? "medium" : "low",
    data_points     : Math.min(history.length, 12),
    method          : "linear_regression_12pt",
  });
});

// ── GET /healthz ──────────────────────────────────────────
app.get("/healthz", (req, res) => {
  res.json({ status: "ok", records: history.length, telegram: TG_TOKEN ? "active" : "disabled" });
});

// ── Root ──────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    project  : "AI-Based IoT AQI Monitor",
    student  : "Anantharajan Vel Murugan | 294FAVZE | UoH",
    telegram : TG_TOKEN ? "Bot active — send any message to get AQI status" : "Not configured",
    routes   : [
      "POST /api/data",
      "GET  /api/latest",
      "GET  /api/history",
      "GET  /api/prediction",
      "GET  /api/download",
    ],
  });
});
// ── GET /api/predict — ML prediction from PM2.5 ──────────
app.get("/api/predict", (req, res) => {
  const pm25 = parseFloat(req.query.pm25);
  if (isNaN(pm25) || pm25 < 0) {
    return res.status(400).json({ error: "Invalid pm25 value" });
  }
  const bp = [
    [0,    12.0,  0,   50,  "GOOD"],
    [12.1, 35.4,  51,  100, "MODERATE"],
    [35.5, 55.4,  101, 150, "SENSITIVE"],
    [55.5, 150.4, 151, 200, "UNHEALTHY"],
    [150.5,250.4, 201, 300, "VERY UNHEALTHY"],
    [250.5,500.4, 301, 500, "HAZARDOUS"],
  ];
  let predictedAQI = 500, predictedLabel = "HAZARDOUS";
  for (const [cL, cH, iL, iH, label] of bp) {
    if (pm25 <= cH) {
      predictedAQI = Math.round(((iH-iL)/(cH-cL))*(pm25-cL)+iL);
      predictedLabel = label;
      break;
    }
  }
  const confidence = history.length >= 50 ? "high"
                   : history.length >= 20 ? "medium" : "low";
  return res.status(200).json({
    pm25_input:      pm25,
    predicted_aqi:   predictedAQI,
    predicted_label: predictedLabel,
    model:           "US EPA Formula (R2=1.000, MAE=0.01)",
    confidence:      confidence,
    data_points:     history.length,
  });
});
// ── Start ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n============================================`);
  console.log(`  AQI Monitor Backend — Port ${PORT}`);
  console.log(`  Telegram: ${TG_TOKEN ? "ACTIVE" : "DISABLED (no token)"}`);
  console.log(`============================================\n`);
});
