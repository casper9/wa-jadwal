/**
 * app.js — WA Scheduler (multi account) + per-target message + auto recent + stop on reply
 * + FIX interval start respected (interval_seconds/minutes/hours/days)
 * + Persist interval next run via nextRunISO (survive reboot)
 * + Auto bootstrap accounts from disk on start
 * + LOGGING: file logs per account + endpoint /accounts/:accountId/logs + tampilkan di index.html
 */

process.env.TZ = process.env.TZ || "Asia/Jakarta"; // ganti ke "Asia/Jakarta" jika perlu

const express = require("express");
const fs = require("fs");
const path = require("path");
const schedule = require("node-schedule");
const qrcode = require("qrcode");
const { Client, LocalAuth } = require("whatsapp-web.js");

const app = express();
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- LOGGING ----------
const LOG_DIR = path.join(__dirname, "logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function logFile(accountId) {
  return path.join(LOG_DIR, `wa-${accountId}.log`);
}
function ts() {
  return new Date().toISOString();
}
function log(accountId, level, msg, extra) {
  const line =
    `[${ts()}] [${accountId}] [${level}] ${msg}` + (extra ? ` | ${extra}` : "");
  console.log(line);
  try {
    fs.appendFileSync(logFile(accountId), line + "\n", "utf8");
  } catch {}
}
function errToStr(e) {
  if (!e) return "";
  return e.stack || e.message || String(e);
}

// ---------- file helpers ----------
function atomicWriteJson(filePath, data) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function loadJsonArraySafe(filePath) {
  const arr = readJsonSafe(filePath, []);
  if (!Array.isArray(arr)) return [];
  return arr;
}

function isValidDateString(s) {
  const d = new Date(s);
  return !isNaN(d.getTime());
}

function pickChromePath() {
  const cands = ["/usr/bin/chromium", "/usr/bin/chromium-browser"];
  for (const p of cands) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}
const chromePath = pickChromePath();

// ✅ rm -rf replacement
function removeDirSafe(dirPath) {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {}
}

// ---------- WA helpers ----------
function normalizeTarget(input) {
  let p = String(input || "").trim();
  p = p.replace(/[\s-]/g, "");

  if (p.endsWith("@g.us")) return p;

  if (p.startsWith("+62")) return p.slice(1);
  if (p.startsWith("62")) return p;
  if (p.startsWith("0")) return "62" + p.slice(1);
  if (p.startsWith("+")) return p.slice(1);

  return p;
}

function toChatId(target) {
  return target.endsWith("@g.us") ? target : `${target}@c.us`;
}

function accountSessionDir(accountId) {
  // folder session WA (LocalAuth dataPath)
  return path.join(__dirname, ".wwebjs_auth", `session-wa_${accountId}`);
}

// ---------- keyword match ----------
function containsKeyword(text, keyword) {
  const t = String(text || "").toLowerCase();
  const k = String(keyword || "").trim().toLowerCase();
  if (!k) return false;
  return t.includes(k);
}

// ---------- parsing per-target message ----------
function parseTargetsWithMessages(text, defaultMessage) {
  const lines = String(text || "")
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const items = [];
  for (const line of lines) {
    const parts = line.split("|");
    const left = (parts[0] || "").trim();
    const right = parts.slice(1).join("|").trim(); // allow '|' in message
    if (!left) continue;

    const targets = left.split(/[;,]+/).map((s) => s.trim()).filter(Boolean);

    for (const t of targets) {
      const target = normalizeTarget(t);
      const msg = right ? right : String(defaultMessage || "");
      if (!msg) continue;
      items.push({ target, message: msg });
    }
  }

  // dedupe target+message (keep order)
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key = it.target + "||" + it.message;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

// ---------- repeat ----------
function buildScheduleSpec(datetimeISO, repeatType, intervalValue) {
  const dt = new Date(datetimeISO);

  const sec = dt.getSeconds();
  const minute = dt.getMinutes();
  const hour = dt.getHours();
  const dom = dt.getDate();
  const dow = dt.getDay(); // 0..6

  if (repeatType === "once") return { kind: "date", value: dt };

  if (repeatType === "daily") return { kind: "cron", value: `${sec} ${minute} ${hour} * * *` };
  if (repeatType === "weekly") return { kind: "cron", value: `${sec} ${minute} ${hour} * * ${dow}` };
  if (repeatType === "monthly") return { kind: "cron", value: `${sec} ${minute} ${hour} ${dom} * *` };

  // ✅ interval_* jangan pakai cron star-slash, karena start akan diabaikan
  if (String(repeatType || "").startsWith("interval_")) {
    const nRaw = Number(intervalValue);
    const n = Number.isFinite(nRaw) && nRaw >= 1 ? Math.floor(nRaw) : 1;
    return { kind: "interval", value: n }; // value = N
  }

  return { kind: "date", value: dt };
}

function intervalMsFromRepeat(repeatType, n) {
  const v = Math.max(1, Math.floor(Number(n) || 1));
  if (repeatType === "interval_seconds") return v * 1000;
  if (repeatType === "interval_minutes") return v * 60 * 1000;
  if (repeatType === "interval_hours") return v * 60 * 60 * 1000;
  if (repeatType === "interval_days") return v * 24 * 60 * 60 * 1000;
  // interval_months: tetap pakai cron monthly, tapi kamu punya interval_months di UI.
  // supaya fitur tetap ada: kita treat months sebagai "cron monthly" berdasarkan start date.
  if (repeatType === "interval_months") return null;
  return null;
}

function computeNextRunFromStart(startISO, everyMs, nowMs = Date.now()) {
  const start = new Date(startISO).getTime();
  if (!Number.isFinite(start)) return new Date(nowMs + everyMs);
  if (start > nowMs) return new Date(start);

  const diff = nowMs - start;
  const k = Math.floor(diff / everyMs) + 1;
  return new Date(start + k * everyMs);
}

// ---------- window + delay ----------
function parseHHMM(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

function isNowInWindow(now, windowStartHHMM, windowEndHHMM) {
  const s = parseHHMM(windowStartHHMM);
  const e = parseHHMM(windowEndHHMM);
  if (s === null || e === null) return true;

  const minutes = now.getHours() * 60 + now.getMinutes();
  if (s <= e) return minutes >= s && minutes <= e; // normal
  return minutes >= s || minutes <= e; // overnight
}

function msUntilWindowStart(now, windowStartHHMM, windowEndHHMM) {
  const s = parseHHMM(windowStartHHMM);
  const e = parseHHMM(windowEndHHMM);
  if (s === null || e === null) return 0;
  if (isNowInWindow(now, windowStartHHMM, windowEndHHMM)) return 0;

  const minutesNow = now.getHours() * 60 + now.getMinutes();
  const start = s;

  let deltaMin;
  if (start >= minutesNow) deltaMin = start - minutesNow;
  else deltaMin = 24 * 60 - minutesNow + start;

  return deltaMin * 60 * 1000;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randInt(min, max) {
  const a = Number(min);
  const b = Number(max);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  if (b <= a) return Math.max(0, Math.floor(a));
  return Math.floor(Math.random() * (b - a + 1)) + a;
}

// ---------- READY/RETRY FIX ----------
async function waitUntilReady(accountId, timeoutMs = 90_000) {
  const acc = ensureAccount(accountId);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (acc.ready && acc.client) return true;
    await sleep(1000);
  }
  return false;
}

async function safeSendMessage(accountId, chatId, text, maxRetry = 3) {
  const acc = ensureAccount(accountId);

  for (let attempt = 1; attempt <= maxRetry; attempt++) {
    try {
      if (!acc.ready) {
        log(accountId, "WARN", `Not ready. waitUntilReady... (attempt ${attempt})`);
        const ok = await waitUntilReady(accountId, 60_000);
        if (!ok) throw new Error("Client not ready (timeout)");
      }

      log(accountId, "INFO", `Sending attempt ${attempt} -> ${chatId}`, `len=${String(text || "").length}`);
      await acc.client.sendMessage(chatId, String(text || ""));
      log(accountId, "INFO", `SEND OK -> ${chatId}`);
      return true;
    } catch (e) {
      log(accountId, "ERROR", `SEND FAIL attempt ${attempt} -> ${chatId}`, errToStr(e));
      if (attempt < maxRetry) await sleep(3000 * attempt);
    }
  }

  log(accountId, "ERROR", `GIVE UP sending -> ${chatId}`);
  return false;
}

// ---------- RECENT (per account) ----------
function recentFile(accountId) {
  return path.join(DATA_DIR, `recent.${accountId}.json`);
}
function loadRecent(accountId) {
  const obj = readJsonSafe(recentFile(accountId), { targets: [], messages: [] });
  return {
    targets: Array.isArray(obj.targets) ? obj.targets : [],
    messages: Array.isArray(obj.messages) ? obj.messages : [],
  };
}
function saveRecent(accountId, recentObj) {
  atomicWriteJson(recentFile(accountId), recentObj);
}

function updateRecent(accountId, targetsText, defaultMessage) {
  const rec = loadRecent(accountId);

  const lines = String(targetsText || "")
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const line of lines) {
    const key = line;
    rec.targets = [key, ...rec.targets.filter((x) => x !== key)];
  }

  const msg = String(defaultMessage || "").trim();
  if (msg) {
    rec.messages = [msg, ...rec.messages.filter((x) => x !== msg)];
  }

  rec.targets = rec.targets.slice(0, 30);
  rec.messages = rec.messages.slice(0, 20);

  saveRecent(accountId, rec);
}

// ---------- multi account manager ----------
const accounts = {};

function listAccountIdsFromDisk() {
  try {
    if (!fs.existsSync(DATA_DIR)) return [];
    const files = fs.readdirSync(DATA_DIR);
    const ids = [];
    for (const f of files) {
      const m = f.match(/^scheduledMessages\.(.+)\.json$/);
      if (m && m[1]) ids.push(m[1]);
    }
    return Array.from(new Set(ids));
  } catch {
    return [];
  }
}

function bootstrapAccountsOnStart() {
  const ids = listAccountIdsFromDisk();
  if (ids.length === 0) {
    console.log("[BOOT] No accounts from disk yet.");
    return;
  }
  console.log("[BOOT] Bootstrapping accounts:", ids.join(", "));
  for (const id of ids) {
    try {
      ensureAccount(id);
    } catch (e) {
      console.log("[BOOT] ensureAccount failed for", id, errToStr(e));
    }
  }
}

function ensureAccount(accountId) {
  if (!accountId) throw new Error("accountId required");
  if (accounts[accountId]) return accounts[accountId];

  const filePath = path.join(DATA_DIR, `scheduledMessages.${accountId}.json`);
  const messages = loadJsonArraySafe(filePath);

  const acc = {
    accountId,
    filePath,
    messages,
    jobs: {},
    ready: false,
    qrDataUrl: "",
    client: null,

    sendQueue: [],
    queueRunning: false,
  };

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: `wa_${accountId}`,
      // ✅ stabil: session selalu di folder project (nggak tergantung cwd PM2)
      dataPath: path.join(__dirname, ".wwebjs_auth"),
    }),
    puppeteer: {
      headless: true,
      executablePath: chromePath || undefined,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-first-run",
        "--no-zygote",
      ],
    },
  });

  client.on("qr", async (qr) => {
    acc.qrDataUrl = await qrcode.toDataURL(qr);
    acc.ready = false;
    log(accountId, "INFO", "QR generated (need scan)");
  });

  client.on("authenticated", () => log(accountId, "INFO", "Authenticated"));

  client.on("auth_failure", (m) => {
    acc.ready = false;
    log(accountId, "ERROR", "Auth failure", String(m || ""));
  });

  client.on("disconnected", (reason) => {
    acc.ready = false;
    log(accountId, "WARN", "Disconnected", String(reason || ""));
  });

  client.on("ready", () => {
    acc.ready = true;
    log(accountId, "INFO", "READY");
    rescheduleAll(accountId);
  });

  // ✅ STOP repeat jika ada balasan masuk mengandung keyword
  client.on("message", async (msg) => {
    try {
      if (!msg) return;
      if (msg.fromMe) return;

      const fromChatId = String(msg.from || "");
      const body = String(msg.body || "");

      for (const item of acc.messages.slice()) {
        const keyword = item.stopOnReplyKeyword;
        if (!keyword) continue;

        const targets = Array.isArray(item.targets) ? item.targets : [];
        const hit = targets.some((t) => toChatId(t.target) === fromChatId);
        if (!hit) continue;

        if (!containsKeyword(body, keyword)) continue;

        log(accountId, "WARN", `STOP repeat id=${item.id} (reply contains "${keyword}")`, `from=${fromChatId}`);

        try {
          acc.jobs[item.id]?.cancel();
        } catch {}
        delete acc.jobs[item.id];

        const idx = acc.messages.findIndex((m) => m.id === item.id);
        if (idx !== -1) {
          acc.messages.splice(idx, 1);
          saveMessages(accountId);
        }
      }
    } catch (e) {
      log(accountId, "ERROR", "message handler error", errToStr(e));
    }
  });

  client.initialize();
  acc.client = client;

  accounts[accountId] = acc;
  log(accountId, "INFO", "Account initialized (Client.initialize called)");
  return acc;
}

function saveMessages(accountId) {
  const acc = ensureAccount(accountId);
  atomicWriteJson(acc.filePath, acc.messages);
}

function cancelAllJobs(acc) {
  for (const id of Object.keys(acc.jobs)) {
    try {
      acc.jobs[id].cancel();
    } catch {}
    delete acc.jobs[id];
  }
}

// ---------- queue ----------
function enqueueSend(accountId, task) {
  const acc = ensureAccount(accountId);
  acc.sendQueue.push(task);
  runQueue(accountId);
}

async function runQueue(accountId) {
  const acc = ensureAccount(accountId);
  if (acc.queueRunning) return;
  acc.queueRunning = true;

  while (acc.sendQueue.length > 0) {
    const task = acc.sendQueue.shift();
    try {
      await task();
    } catch (e) {
      log(accountId, "ERROR", "Queue task failed", errToStr(e));
    }
  }
  acc.queueRunning = false;
}

async function sendTargetsPerItem(accountId, item) {
  const acc = ensureAccount(accountId);

  const list = Array.isArray(item.targets) ? item.targets : [];
  const gapSec = Number.isFinite(Number(item.gapSeconds))
    ? Math.max(0, Math.floor(Number(item.gapSeconds)))
    : 2;
  const rMin = Number.isFinite(Number(item.randomDelayMinSeconds))
    ? Math.max(0, Math.floor(Number(item.randomDelayMinSeconds)))
    : 0;
  const rMax = Number.isFinite(Number(item.randomDelayMaxSeconds))
    ? Math.max(0, Math.floor(Number(item.randomDelayMaxSeconds)))
    : 0;

  if (!acc.ready) {
    const ok = await waitUntilReady(accountId, 90_000);
    if (!ok) {
      log(accountId, "WARN", `Not ready, skip sending for item id=${item.id}`);
      return;
    }
  }

  log(accountId, "INFO", `Start sending item id=${item.id}`, `targets=${list.length}`);

  for (const t of list) {
    const jitter = rMax > 0 || rMin > 0 ? randInt(rMin, rMax) : 0;
    if (jitter > 0) await sleep(jitter * 1000);

    const chatId = toChatId(t.target);
    const ok = await safeSendMessage(accountId, chatId, String(t.message || ""), 3);
    if (!ok) log(accountId, "ERROR", `Give up for target`, chatId);

    if (gapSec > 0) await sleep(gapSec * 1000);
  }

  log(accountId, "INFO", `Done sending item id=${item.id}`);
}

// ---------- scheduling ----------
function afterSendUpdate(accountId, id) {
  const acc = ensureAccount(accountId);
  const idx = acc.messages.findIndex((m) => m.id === id);
  if (idx === -1) return;

  const cur = acc.messages[idx];

  if ((cur.repeatType || "once") === "once") {
    acc.messages.splice(idx, 1);
    saveMessages(accountId);
    try {
      acc.jobs[id]?.cancel();
    } catch {}
    delete acc.jobs[id];

    log(accountId, "INFO", `Once schedule done -> removed`, `id=${id}`);
    return;
  }

  if (typeof cur.remainingCount === "number") {
    cur.remainingCount -= 1;
    if (cur.remainingCount <= 0) {
      acc.messages.splice(idx, 1);
      saveMessages(accountId);
      try {
        acc.jobs[id]?.cancel();
      } catch {}
      delete acc.jobs[id];

      log(accountId, "INFO", `Repeat count ended -> removed`, `id=${id}`);
      return;
    }
    saveMessages(accountId);
    log(accountId, "DEBUG", `RemainingCount updated`, `id=${id} remaining=${cur.remainingCount}`);
  }
}

function scheduleOne(accountId, item) {
  const acc = ensureAccount(accountId);
  const { id, datetimeISO, repeatType = "once", intervalMinutes } = item;
  if (!isValidDateString(datetimeISO)) return;

  // cancel job lama
  if (acc.jobs[id]) {
    try { acc.jobs[id].cancel(); } catch {}
    delete acc.jobs[id];
  }

  const spec = buildScheduleSpec(datetimeISO, repeatType, intervalMinutes);

  // ============================
  // ✅ INTERVAL MODE (start respected + persist nextRunISO)
  // ============================
  if (spec.kind === "interval") {
    // special: interval_months -> fallback pakai cron monthly (biar fitur tetap ada)
    if (repeatType === "interval_months") {
      const dt = new Date(datetimeISO);
      const sec = dt.getSeconds();
      const minute = dt.getMinutes();
      const hour = dt.getHours();
      const dom = dt.getDate();
      // tiap bulan di tanggal dom jam:menit:detik
      const cron = `${sec} ${minute} ${hour} ${dom} */${Math.max(1, Math.floor(Number(spec.value) || 1))} *`;
      const job = schedule.scheduleJob(cron, () => runTick(accountId, id));
      acc.jobs[id] = job;
      log(accountId, "INFO", `Scheduled INTERVAL_MONTHS via cron`, `id=${id} cron=${cron}`);
      return;
    }

    const everyMs = intervalMsFromRepeat(repeatType, spec.value);
    if (!everyMs) {
      log(accountId, "ERROR", "Interval type unsupported", String(repeatType));
      return;
    }

    const next =
      item.nextRunISO && isValidDateString(item.nextRunISO)
        ? new Date(item.nextRunISO)
        : computeNextRunFromStart(datetimeISO, everyMs);

    item.nextRunISO = next.toISOString();
    saveMessages(accountId);

    const job = schedule.scheduleJob(next, async () => {
      await runTickInterval(accountId, id, everyMs);
    });

    acc.jobs[id] = job;
    log(accountId, "INFO", `Scheduled INTERVAL job`, `id=${id} next=${item.nextRunISO}`);
    return;
  }

  // ============================
  // CRON/ONCE
  // ============================
  const job = schedule.scheduleJob(spec.value, async () => {
    await runTick(accountId, id);
  });

  acc.jobs[id] = job;
  log(accountId, "INFO", `Scheduled job`, `id=${id} type=${repeatType}`);
}

async function runTick(accountId, id) {
  const acc = ensureAccount(accountId);
  try {
    log(accountId, "DEBUG", `Tick job id=${id}`);

    const idx = acc.messages.findIndex((m) => m.id === id);
    if (idx === -1) {
      delete acc.jobs[id];
      log(accountId, "WARN", `Job tick but item missing -> cancel`, `id=${id}`);
      return;
    }
    const current = acc.messages[idx];

    // reboot safety
    if (!acc.ready) {
      log(accountId, "WARN", `Tick id=${id} but NOT READY -> skip (will retry next tick)`);
      return;
    }

    // until
    if (current.repeatUntilISO && isValidDateString(current.repeatUntilISO)) {
      if (Date.now() > new Date(current.repeatUntilISO).getTime()) {
        try { acc.jobs[id]?.cancel(); } catch {}
        delete acc.jobs[id];
        acc.messages.splice(idx, 1);
        saveMessages(accountId);
        log(accountId, "INFO", `RepeatUntil passed -> removed`, `id=${id}`);
        return;
      }
    }

    // count
    if (typeof current.remainingCount === "number" && current.remainingCount <= 0) {
      try { acc.jobs[id]?.cancel(); } catch {}
      delete acc.jobs[id];
      acc.messages.splice(idx, 1);
      saveMessages(accountId);
      log(accountId, "INFO", `RemainingCount <=0 -> removed`, `id=${id}`);
      return;
    }

    // window check
    const now = new Date();
    if (!isNowInWindow(now, current.windowStart, current.windowEnd)) {
      const waitMs = msUntilWindowStart(now, current.windowStart, current.windowEnd);
      log(accountId, "DEBUG", `Outside window -> delay`, `id=${id} waitMs=${waitMs}`);

      enqueueSend(accountId, async () => {
        const idx2 = acc.messages.findIndex((m) => m.id === id);
        if (idx2 === -1) return;
        const cur2 = acc.messages[idx2];

        if (cur2.repeatUntilISO && isValidDateString(cur2.repeatUntilISO)) {
          if (Date.now() > new Date(cur2.repeatUntilISO).getTime()) return;
        }
        if (typeof cur2.remainingCount === "number" && cur2.remainingCount <= 0) return;

        if (waitMs > 0) await sleep(waitMs);

        const ok = await waitUntilReady(accountId, 60_000);
        if (!ok) {
          log(accountId, "WARN", `After window wait, still not ready -> skip`, `id=${id}`);
          return;
        }

        const now2 = new Date();
        if (!isNowInWindow(now2, cur2.windowStart, cur2.windowEnd)) return;

        await sendTargetsPerItem(accountId, cur2);
        afterSendUpdate(accountId, id);
      });
      return;
    }

    enqueueSend(accountId, async () => {
      const idx2 = acc.messages.findIndex((m) => m.id === id);
      if (idx2 === -1) return;
      const cur2 = acc.messages[idx2];

      const ok = await waitUntilReady(accountId, 60_000);
      if (!ok) {
        log(accountId, "WARN", `Wait ready timeout before send -> skip`, `id=${id}`);
        return;
      }

      await sendTargetsPerItem(accountId, cur2);
      afterSendUpdate(accountId, id);
    });
  } catch (e) {
    log(accountId, "ERROR", `Job error id=${id}`, errToStr(e));
  }
}

async function runTickInterval(accountId, id, everyMs) {
  const acc = ensureAccount(accountId);

  try {
    log(accountId, "DEBUG", `Tick INTERVAL job id=${id}`);

    const idx = acc.messages.findIndex((m) => m.id === id);
    if (idx === -1) {
      delete acc.jobs[id];
      log(accountId, "WARN", `Interval tick but item missing -> cancel`, `id=${id}`);
      return;
    }
    const current = acc.messages[idx];

    // until
    if (current.repeatUntilISO && isValidDateString(current.repeatUntilISO)) {
      if (Date.now() > new Date(current.repeatUntilISO).getTime()) {
        try { acc.jobs[id]?.cancel(); } catch {}
        delete acc.jobs[id];
        acc.messages.splice(idx, 1);
        saveMessages(accountId);
        log(accountId, "INFO", `RepeatUntil passed -> removed`, `id=${id}`);
        return;
      }
    }

    // count
    if (typeof current.remainingCount === "number" && current.remainingCount <= 0) {
      try { acc.jobs[id]?.cancel(); } catch {}
      delete acc.jobs[id];
      acc.messages.splice(idx, 1);
      saveMessages(accountId);
      log(accountId, "INFO", `RemainingCount <=0 -> removed`, `id=${id}`);
      return;
    }

    // kalau belum ready, geser nextRun agar tidak ngebut
    if (!acc.ready) {
      log(accountId, "WARN", `INTERVAL tick but NOT READY -> postpone`, `id=${id}`);
      current.nextRunISO = new Date(Date.now() + everyMs).toISOString();
      saveMessages(accountId);
      scheduleOne(accountId, current);
      return;
    }

    // window check
    const now = new Date();
    if (!isNowInWindow(now, current.windowStart, current.windowEnd)) {
      const waitMs = msUntilWindowStart(now, current.windowStart, current.windowEnd);
      log(accountId, "DEBUG", `Outside window -> delay send`, `id=${id} waitMs=${waitMs}`);

      enqueueSend(accountId, async () => {
        const idx2 = acc.messages.findIndex((m) => m.id === id);
        if (idx2 === -1) return;
        const cur2 = acc.messages[idx2];

        if (waitMs > 0) await sleep(waitMs);
        const ok = await waitUntilReady(accountId, 60_000);
        if (!ok) return;

        const now2 = new Date();
        if (!isNowInWindow(now2, cur2.windowStart, cur2.windowEnd)) return;

        await sendTargetsPerItem(accountId, cur2);
        afterSendUpdate(accountId, id);
      });
    } else {
      enqueueSend(accountId, async () => {
        const idx2 = acc.messages.findIndex((m) => m.id === id);
        if (idx2 === -1) return;
        const cur2 = acc.messages[idx2];

        const ok = await waitUntilReady(accountId, 60_000);
        if (!ok) return;

        await sendTargetsPerItem(accountId, cur2);
        afterSendUpdate(accountId, id);
      });
    }

    // schedule NEXT RUN (persist)
    const stillThere = acc.messages.find((m) => m.id === id);
    if (!stillThere) return;

    stillThere.nextRunISO = new Date(Date.now() + everyMs).toISOString();
    saveMessages(accountId);
    scheduleOne(accountId, stillThere);
  } catch (e) {
    log(accountId, "ERROR", `INTERVAL job error id=${id}`, errToStr(e));
    const idx3 = acc.messages.findIndex((m) => m.id === id);
    if (idx3 !== -1) {
      acc.messages[idx3].nextRunISO = new Date(Date.now() + everyMs).toISOString();
      saveMessages(accountId);
      scheduleOne(accountId, acc.messages[idx3]);
    }
  }
}

function rescheduleAll(accountId) {
  const acc = ensureAccount(accountId);
  cancelAllJobs(acc);

  // migrate super old schemas if exist
  for (const m of acc.messages) {
    if (m && m.target && !m.targets) {
      m.targets = [{ target: normalizeTarget(m.target), message: String(m.message || "") }];
      m.targetsText = String(m.target);
      m.defaultMessage = String(m.message || "");
      delete m.target;
      delete m.message;
    }
    if (m && Array.isArray(m.targets) && !m.targetsText) {
      m.targetsText = m.targets.map((x) => `${x.target} | ${x.message}`).join("\n");
    }
    // pastikan field nextRunISO kalau interval
    if (m && String(m.repeatType || "").startsWith("interval_") && !m.nextRunISO) {
      // akan dihitung saat scheduleOne dipanggil
      m.nextRunISO = undefined;
    }
  }

  for (const m of acc.messages) {
    if (!m?.id || !Array.isArray(m.targets) || !m?.datetimeISO) continue;
    if (!isValidDateString(m.datetimeISO)) continue;
    scheduleOne(accountId, m);
  }

  saveMessages(accountId);
  log(accountId, "INFO", `Rescheduled all`, `count=${acc.messages.length}`);
}

// ---------- Routes ----------
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.post("/accounts/:accountId/init", (req, res) => {
  const { accountId } = req.params;
  ensureAccount(accountId);
  res.json({ ok: true, accountId });
});

app.get("/accounts", (req, res) => {
  const mem = Object.keys(accounts);
  const disk = listAccountIdsFromDisk();
  const all = Array.from(new Set([...disk, ...mem]));
  res.json(all);
});

app.get("/accounts/:accountId/status", (req, res) => {
  const acc = ensureAccount(req.params.accountId);
  res.json({
    accountId: acc.accountId,
    ready: acc.ready,
    scheduledCount: acc.messages.length,
    queueLength: acc.sendQueue.length,
  });
});

app.get("/accounts/:accountId/qr", (req, res) => {
  const acc = ensureAccount(req.params.accountId);
  if (!acc.qrDataUrl) {
    return res.send(
      acc.ready
        ? `Account ${acc.accountId} sudah login. Kalau mau QR lagi, klik Logout di UI.`
        : "QR belum siap. Refresh beberapa detik lagi."
    );
  }
  res.send(`
    <h2>Scan QR - Account: ${acc.accountId}</h2>
    <p>Refresh jika QR belum muncul.</p>
    <img src="${acc.qrDataUrl}" style="width:320px;height:320px;" />
  `);
});

app.get("/accounts/:accountId/groups", async (req, res) => {
  const acc = ensureAccount(req.params.accountId);
  if (!acc.ready) return res.status(400).json({ error: "Account not ready / not logged in" });

  try {
    const chats = await acc.client.getChats();
    const groups = chats
      .filter((c) => c && c.isGroup)
      .map((g) => ({ id: g.id?._serialized || "", name: g.name || "Unnamed Group" }))
      .filter((g) => g.id.endsWith("@g.us"));

    groups.sort((a, b) => a.name.localeCompare(b.name));
    res.json(groups);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ----- LOG endpoints -----
app.get("/accounts/:accountId/logs", (req, res) => {
  const accountId = req.params.accountId;
  ensureAccount(accountId);

  const file = logFile(accountId);
  const linesParam = Number(req.query.lines || 300);
  const maxLines = Number.isFinite(linesParam) ? Math.min(Math.max(linesParam, 50), 2000) : 300;

  try {
    if (!fs.existsSync(file)) return res.type("text").send("No logs yet.");
    const data = fs.readFileSync(file, "utf8");
    const lines = data.split("\n").filter(Boolean);
    const tail = lines.slice(-maxLines).join("\n");
    res.type("text").send(tail);
  } catch (e) {
    res.status(500).type("text").send(errToStr(e));
  }
});

app.delete("/accounts/:accountId/logs", (req, res) => {
  const accountId = req.params.accountId;
  ensureAccount(accountId);
  try {
    fs.writeFileSync(logFile(accountId), "", "utf8");
  } catch {}
  res.json({ ok: true });
});

// ----- RECENT endpoints -----
app.get("/accounts/:accountId/recent", (req, res) => {
  ensureAccount(req.params.accountId);
  res.json(loadRecent(req.params.accountId));
});

app.delete("/accounts/:accountId/recent", (req, res) => {
  ensureAccount(req.params.accountId);
  saveRecent(req.params.accountId, { targets: [], messages: [] });
  res.json({ ok: true });
});

// ----- messages -----
app.get("/accounts/:accountId/messages", (req, res) => {
  const acc = ensureAccount(req.params.accountId);
  res.json(acc.messages);
});

app.post("/accounts/:accountId/messages", (req, res) => {
  const accountId = req.params.accountId;
  const acc = ensureAccount(accountId);

  const {
    targetsText,
    defaultMessage,
    datetimeISO,
    repeatType,
    intervalMinutes,
    repeatUntilISO,
    repeatCount,
    windowStart,
    windowEnd,
    gapSeconds,
    randomDelayMinSeconds,
    randomDelayMaxSeconds,
    stopOnReplyKeyword,
  } = req.body;

  if (!targetsText || !datetimeISO) {
    return res.status(400).json({ error: "targetsText and datetimeISO required" });
  }
  if (!isValidDateString(datetimeISO)) {
    return res.status(400).json({ error: "datetimeISO invalid. Example: 2026-01-07T12:30:00" });
  }

  const defMsg = String(defaultMessage || "").trim();
  const targets = parseTargetsWithMessages(targetsText, defMsg);
  if (targets.length === 0) return res.status(400).json({ error: "No valid targets or messages" });

  const rt = String(repeatType || "once").toLowerCase();
  const allowed = new Set([
    "once",
    "daily",
    "weekly",
    "monthly",
    "interval_seconds",
    "interval_minutes",
    "interval_hours",
    "interval_days",
    "interval_months",
  ]);
  if (!allowed.has(rt)) return res.status(400).json({ error: "repeatType invalid" });

  let until = undefined;
  if (repeatUntilISO) {
    if (!isValidDateString(repeatUntilISO)) return res.status(400).json({ error: "repeatUntilISO invalid" });
    until = String(repeatUntilISO);
  }

  let remainingCount = undefined;
  if (repeatCount !== undefined && repeatCount !== null && repeatCount !== "") {
    const n = Number(repeatCount);
    if (!Number.isFinite(n) || n < 1) return res.status(400).json({ error: "repeatCount must be >= 1" });
    remainingCount = Math.floor(n);
  }

  let interval = undefined;
  if (rt.startsWith("interval_")) {
    const n = Number(intervalMinutes);
    if (!Number.isFinite(n) || n < 1) return res.status(400).json({ error: "interval value must be >= 1" });
    interval = Math.floor(n);
  }

  const gap = gapSeconds !== undefined && gapSeconds !== "" ? Math.max(0, Math.floor(Number(gapSeconds))) : 2;
  const rMin =
    randomDelayMinSeconds !== undefined && randomDelayMinSeconds !== ""
      ? Math.max(0, Math.floor(Number(randomDelayMinSeconds)))
      : 0;
  const rMax =
    randomDelayMaxSeconds !== undefined && randomDelayMaxSeconds !== ""
      ? Math.max(0, Math.floor(Number(randomDelayMaxSeconds)))
      : 0;

  const keyword = String(stopOnReplyKeyword || "").trim();
  const item = {
    id: Date.now(),
    targets,
    targetsText: String(targetsText),
    defaultMessage: defMsg,
    datetimeISO: String(datetimeISO),
    repeatType: rt,
    intervalMinutes: interval,
    repeatUntilISO: until,
    remainingCount,
    stopOnReplyKeyword: keyword ? keyword : undefined,
    windowStart: windowStart || undefined,
    windowEnd: windowEnd || undefined,
    gapSeconds: gap,
    randomDelayMinSeconds: rMin,
    randomDelayMaxSeconds: rMax,
    // ✅ interval persistence
    nextRunISO: undefined,
  };

  acc.messages.push(item);
  saveMessages(accountId);
  // schedule walaupun belum ready -> interval nextRun bisa tersimpan
  scheduleOne(accountId, item);

  updateRecent(accountId, item.targetsText, item.defaultMessage);

  log(accountId, "INFO", "Schedule created", `id=${item.id} repeat=${item.repeatType}`);
  res.json({ ok: true, item });
});

app.put("/accounts/:accountId/messages/:id", (req, res) => {
  const accountId = req.params.accountId;
  const id = parseInt(req.params.id, 10);
  const acc = ensureAccount(accountId);

  const idx = acc.messages.findIndex((m) => m.id === id);
  if (idx === -1) return res.status(404).json({ error: "not found" });

  const patch = req.body || {};
  const cur = acc.messages[idx];

  if (patch.targetsText !== undefined) {
    const defMsg = String(patch.defaultMessage ?? cur.defaultMessage ?? "").trim();
    const targets = parseTargetsWithMessages(patch.targetsText, defMsg);
    if (targets.length === 0) return res.status(400).json({ error: "No valid targets or messages" });
    cur.targets = targets;
    cur.targetsText = String(patch.targetsText);
    cur.defaultMessage = defMsg;
  }

  if (patch.defaultMessage !== undefined) cur.defaultMessage = String(patch.defaultMessage || "").trim();

  if (patch.datetimeISO !== undefined) {
    if (!isValidDateString(patch.datetimeISO)) return res.status(400).json({ error: "datetimeISO invalid" });
    cur.datetimeISO = String(patch.datetimeISO);
  }

  if (patch.repeatType !== undefined) {
    const rt = String(patch.repeatType).toLowerCase();
    const allowed = new Set([
      "once",
      "daily",
      "weekly",
      "monthly",
      "interval_seconds",
      "interval_minutes",
      "interval_hours",
      "interval_days",
      "interval_months",
    ]);
    if (!allowed.has(rt)) return res.status(400).json({ error: "repeatType invalid" });
    cur.repeatType = rt;

    if (!rt.startsWith("interval_")) cur.intervalMinutes = undefined;
    // reset nextRunISO biar hitung ulang
    cur.nextRunISO = undefined;
  }

  if (patch.intervalMinutes !== undefined) {
    if (patch.intervalMinutes === "" || patch.intervalMinutes === null) cur.intervalMinutes = undefined;
    else {
      const n = Number(patch.intervalMinutes);
      if (!Number.isFinite(n) || n < 1) return res.status(400).json({ error: "interval value must be >= 1" });
      cur.intervalMinutes = Math.floor(n);
      cur.nextRunISO = undefined;
    }
  }

  if (patch.repeatUntilISO !== undefined) {
    if (patch.repeatUntilISO === "" || patch.repeatUntilISO === null) cur.repeatUntilISO = undefined;
    else {
      if (!isValidDateString(patch.repeatUntilISO)) return res.status(400).json({ error: "repeatUntilISO invalid" });
      cur.repeatUntilISO = String(patch.repeatUntilISO);
    }
  }

  if (patch.repeatCount !== undefined) {
    if (patch.repeatCount === "" || patch.repeatCount === null) cur.remainingCount = undefined;
    else {
      const n = Number(patch.repeatCount);
      if (!Number.isFinite(n) || n < 1) return res.status(400).json({ error: "repeatCount must be >= 1" });
      cur.remainingCount = Math.floor(n);
    }
  }

  if (patch.windowStart !== undefined) cur.windowStart = patch.windowStart || undefined;
  if (patch.windowEnd !== undefined) cur.windowEnd = patch.windowEnd || undefined;

  if (patch.gapSeconds !== undefined) cur.gapSeconds = Math.max(0, Math.floor(Number(patch.gapSeconds || 2)));
  if (patch.randomDelayMinSeconds !== undefined)
    cur.randomDelayMinSeconds = Math.max(0, Math.floor(Number(patch.randomDelayMinSeconds || 0)));
  if (patch.randomDelayMaxSeconds !== undefined)
    cur.randomDelayMaxSeconds = Math.max(0, Math.floor(Number(patch.randomDelayMaxSeconds || 0)));

  if (patch.stopOnReplyKeyword !== undefined) {
    const k = String(patch.stopOnReplyKeyword || "").trim();
    cur.stopOnReplyKeyword = k ? k : undefined;
  }

  if (String(cur.repeatType || "").startsWith("interval_")) {
    const iv = Number(cur.intervalMinutes);
    if (!Number.isFinite(iv) || iv < 1) return res.status(400).json({ error: "interval value must be >= 1" });
  }

  saveMessages(accountId);

  if (acc.jobs[id]) {
    try { acc.jobs[id].cancel(); } catch {}
    delete acc.jobs[id];
  }
  scheduleOne(accountId, cur);

  updateRecent(accountId, cur.targetsText || "", cur.defaultMessage || "");

  log(accountId, "INFO", "Schedule updated", `id=${id}`);
  res.json({ ok: true, item: cur });
});

app.delete("/accounts/:accountId/messages/:id", (req, res) => {
  const accountId = req.params.accountId;
  const id = parseInt(req.params.id, 10);
  const acc = ensureAccount(accountId);

  const idx = acc.messages.findIndex((m) => m.id === id);
  if (idx === -1) return res.status(404).json({ error: "not found" });

  if (acc.jobs[id]) {
    try { acc.jobs[id].cancel(); } catch {}
    delete acc.jobs[id];
  }

  acc.messages.splice(idx, 1);
  saveMessages(accountId);

  log(accountId, "INFO", "Schedule deleted", `id=${id}`);
  res.json({ ok: true });
});

// logout (keep schedules)
app.post("/accounts/:accountId/logout", async (req, res) => {
  const { accountId } = req.params;
  const acc = ensureAccount(accountId);

  try {
    cancelAllJobs(acc);
    try { await acc.client.logout(); } catch {}

    // hapus session (supaya scan QR ulang)
    removeDirSafe(accountSessionDir(accountId));

    acc.ready = false;
    acc.qrDataUrl = "";

    log(accountId, "INFO", "Logged out (session removed)");
    res.json({ ok: true, message: `Logged out ${accountId}. Open /accounts/${accountId}/qr to scan again.` });
  } catch (e) {
    log(accountId, "ERROR", "Logout failed", errToStr(e));
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// delete account (remove schedules + recent + session)
app.delete("/accounts/:accountId", async (req, res) => {
  const { accountId } = req.params;
  const acc = accounts[accountId] || null;

  try {
    if (acc) {
      cancelAllJobs(acc);
      try { await acc.client.destroy(); } catch {}
      try { await acc.client.logout(); } catch {}
    }

    removeDirSafe(accountSessionDir(accountId));

    try { fs.unlinkSync(path.join(DATA_DIR, `scheduledMessages.${accountId}.json`)); } catch {}
    try { fs.unlinkSync(recentFile(accountId)); } catch {}

    delete accounts[accountId];

    log(accountId, "INFO", "Account deleted (session+schedules+recent removed)");
    res.json({ ok: true, message: `Account ${accountId} deleted (session + schedules + recent removed)` });
  } catch (e) {
    log(accountId, "ERROR", "Delete account failed", errToStr(e));
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get("/health", (req, res) => res.send("ok"));

process.on("unhandledRejection", (reason) => {
  console.log("[GLOBAL] unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.log("[GLOBAL] uncaughtException:", err);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
  console.log(`UI: http://IP:${PORT}/`);
  console.log(`Chromium: ${chromePath || "puppeteer-bundled"}`);

  // ✅ server hidup dulu, lalu bootstrap WA (biar port pasti kebuka)
  setTimeout(() => {
    try {
      bootstrapAccountsOnStart();
    } catch (e) {
      console.log("[BOOT] bootstrap failed:", errToStr(e));
    }
  }, 1500);
});