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

// ✅ rimraf replacement (fix: rimraf is not a function)
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
  return path.join(__dirname, ".wwebjs_auth", `session-wa_${accountId}`);
}

// ---------- parsing per-target message ----------
// per line formats:
// 1) target
// 2) target | custom message
// left can include multiple targets separated by comma/semicolon
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

// ---------- repeat (interval detik/menit/jam/hari/bulan) ----------
function buildScheduleSpec(datetimeISO, repeatType, intervalValue) {
  const dt = new Date(datetimeISO);

  const sec = dt.getSeconds();
  const minute = dt.getMinutes();
  const hour = dt.getHours();
  const dom = dt.getDate();
  const dow = dt.getDay(); // 0..6

  if (repeatType === "once") return { kind: "date", value: dt };

  // Cron 6-field: second minute hour day month dayOfWeek
  if (repeatType === "daily") return { kind: "cron", value: `${sec} ${minute} ${hour} * * *` };
  if (repeatType === "weekly") return { kind: "cron", value: `${sec} ${minute} ${hour} * * ${dow}` };
  if (repeatType === "monthly") return { kind: "cron", value: `${sec} ${minute} ${hour} ${dom} * *` };

  const nRaw = Number(intervalValue);
  const n = Number.isFinite(nRaw) && nRaw >= 1 ? Math.floor(nRaw) : 1;

  if (repeatType === "interval_seconds") return { kind: "cron", value: `*/${n} * * * * *` };
  if (repeatType === "interval_minutes") return { kind: "cron", value: `${sec} */${n} * * * *` };
  if (repeatType === "interval_hours") return { kind: "cron", value: `${sec} ${minute} */${n} * * *` };

  // Simple day-of-month step (bisa “lompat” di bulan yang jumlah harinya beda)
  if (repeatType === "interval_days") return { kind: "cron", value: `${sec} ${minute} ${hour} */${n} * *` };

  // Simple bulan: tanggal sama (dom) tiap N bulan
  if (repeatType === "interval_months") return { kind: "cron", value: `${sec} ${minute} ${hour} ${dom} */${n} *` };

  return { kind: "date", value: dt };
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
    authStrategy: new LocalAuth({ clientId: `wa_${accountId}` }),
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
    console.log(`[${accountId}] QR generated: /accounts/${accountId}/qr`);
  });

  client.on("authenticated", () => console.log(`[${accountId}] Authenticated`));
  client.on("auth_failure", (m) => {
    acc.ready = false;
    console.log(`[${accountId}] Auth failure:`, m);
  });

  client.on("ready", () => {
    acc.ready = true;
    console.log(`[${accountId}] READY`);
    rescheduleAll(accountId);
  });

  client.initialize();
  acc.client = client;

  accounts[accountId] = acc;
  return acc;
}

function saveMessages(accountId) {
  const acc = ensureAccount(accountId);
  atomicWriteJson(acc.filePath, acc.messages);
}

function cancelAllJobs(acc) {
  for (const id of Object.keys(acc.jobs)) {
    try { acc.jobs[id].cancel(); } catch {}
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
    try { await task(); } catch (e) {
      console.log(`[${accountId}] Queue task failed:`, e);
    }
  }
  acc.queueRunning = false;
}

async function sendTargetsPerItem(accountId, item) {
  const acc = ensureAccount(accountId);

  const list = Array.isArray(item.targets) ? item.targets : [];
  const gapSec = Number.isFinite(Number(item.gapSeconds)) ? Math.max(0, Math.floor(Number(item.gapSeconds))) : 2;
  const rMin = Number.isFinite(Number(item.randomDelayMinSeconds)) ? Math.max(0, Math.floor(Number(item.randomDelayMinSeconds))) : 0;
  const rMax = Number.isFinite(Number(item.randomDelayMaxSeconds)) ? Math.max(0, Math.floor(Number(item.randomDelayMaxSeconds))) : 0;

  for (const t of list) {
    const jitter = (rMax > 0 || rMin > 0) ? randInt(rMin, rMax) : 0;
    if (jitter > 0) await sleep(jitter * 1000);

    const chatId = toChatId(t.target);
    await acc.client.sendMessage(chatId, String(t.message || ""));

    if (gapSec > 0) await sleep(gapSec * 1000);
  }
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
    try { acc.jobs[id]?.cancel(); } catch {}
    delete acc.jobs[id];
    return;
  }

  if (typeof cur.remainingCount === "number") {
    cur.remainingCount -= 1;
    if (cur.remainingCount <= 0) {
      acc.messages.splice(idx, 1);
      saveMessages(accountId);
      try { acc.jobs[id]?.cancel(); } catch {}
      delete acc.jobs[id];
      return;
    }
    saveMessages(accountId);
  }
}

function scheduleOne(accountId, item) {
  const acc = ensureAccount(accountId);
  const { id, datetimeISO, repeatType = "once", intervalMinutes } = item;
  if (!isValidDateString(datetimeISO)) return;

  if (acc.jobs[id]) {
    try { acc.jobs[id].cancel(); } catch {}
    delete acc.jobs[id];
  }

  const spec = buildScheduleSpec(datetimeISO, repeatType, intervalMinutes);

  const job = schedule.scheduleJob(spec.value, async () => {
    try {
      const idx = acc.messages.findIndex((m) => m.id === id);
      if (idx === -1) {
        delete acc.jobs[id];
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
          return;
        }
      }

      // count
      if (typeof current.remainingCount === "number" && current.remainingCount <= 0) {
        try { acc.jobs[id]?.cancel(); } catch {}
        delete acc.jobs[id];
        acc.messages.splice(idx, 1);
        saveMessages(accountId);
        return;
      }

      // window check
      const now = new Date();
      if (!isNowInWindow(now, current.windowStart, current.windowEnd)) {
        const waitMs = msUntilWindowStart(now, current.windowStart, current.windowEnd);
        enqueueSend(accountId, async () => {
          const idx2 = acc.messages.findIndex((m) => m.id === id);
          if (idx2 === -1) return;
          const cur2 = acc.messages[idx2];

          if (cur2.repeatUntilISO && isValidDateString(cur2.repeatUntilISO)) {
            if (Date.now() > new Date(cur2.repeatUntilISO).getTime()) return;
          }
          if (typeof cur2.remainingCount === "number" && cur2.remainingCount <= 0) return;

          if (waitMs > 0) await sleep(waitMs);

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

        await sendTargetsPerItem(accountId, cur2);
        afterSendUpdate(accountId, id);
      });
    } catch (e) {
      console.log(`[${accountId}] Job error id=${id}:`, e);
    }
  });

  acc.jobs[id] = job;
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
  }

  for (const m of acc.messages) {
    if (!m?.id || !Array.isArray(m.targets) || !m?.datetimeISO) continue;
    if (!isValidDateString(m.datetimeISO)) continue;
    scheduleOne(accountId, m);
  }

  saveMessages(accountId);
}

// ---------- Routes ----------
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.post("/accounts/:accountId/init", (req, res) => {
  const { accountId } = req.params;
  ensureAccount(accountId);
  res.json({ ok: true, accountId });
});

app.get("/accounts", (req, res) => res.json(Object.keys(accounts)));

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
  const rMin = randomDelayMinSeconds !== undefined && randomDelayMinSeconds !== "" ? Math.max(0, Math.floor(Number(randomDelayMinSeconds))) : 0;
  const rMax = randomDelayMaxSeconds !== undefined && randomDelayMaxSeconds !== "" ? Math.max(0, Math.floor(Number(randomDelayMaxSeconds))) : 0;

  const item = {
    id: Date.now(),
    targets,
    targetsText: String(targetsText),
    defaultMessage: defMsg,
    datetimeISO: String(datetimeISO),
    repeatType: rt,
    intervalMinutes: interval, // interval value (N)
    repeatUntilISO: until,
    remainingCount,
    windowStart: windowStart || undefined,
    windowEnd: windowEnd || undefined,
    gapSeconds: gap,
    randomDelayMinSeconds: rMin,
    randomDelayMaxSeconds: rMax,
  };

  acc.messages.push(item);
  saveMessages(accountId);
  if (acc.ready) scheduleOne(accountId, item);

  updateRecent(accountId, item.targetsText, item.defaultMessage);

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
  }

  if (patch.intervalMinutes !== undefined) {
    if (patch.intervalMinutes === "" || patch.intervalMinutes === null) cur.intervalMinutes = undefined;
    else {
      const n = Number(patch.intervalMinutes);
      if (!Number.isFinite(n) || n < 1) return res.status(400).json({ error: "interval value must be >= 1" });
      cur.intervalMinutes = Math.floor(n);
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
  if (patch.randomDelayMinSeconds !== undefined) cur.randomDelayMinSeconds = Math.max(0, Math.floor(Number(patch.randomDelayMinSeconds || 0)));
  if (patch.randomDelayMaxSeconds !== undefined) cur.randomDelayMaxSeconds = Math.max(0, Math.floor(Number(patch.randomDelayMaxSeconds || 0)));

  // guard: interval_* harus punya intervalMinutes >=1
  if (String(cur.repeatType || "").startsWith("interval_")) {
    const iv = Number(cur.intervalMinutes);
    if (!Number.isFinite(iv) || iv < 1) return res.status(400).json({ error: "interval value must be >= 1" });
  }

  saveMessages(accountId);

  if (acc.jobs[id]) {
    try { acc.jobs[id].cancel(); } catch {}
    delete acc.jobs[id];
  }
  if (acc.ready) scheduleOne(accountId, cur);

  updateRecent(accountId, cur.targetsText || "", cur.defaultMessage || "");

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

  res.json({ ok: true });
});

// logout (keep schedules)
app.post("/accounts/:accountId/logout", async (req, res) => {
  const { accountId } = req.params;
  const acc = ensureAccount(accountId);

  try {
    cancelAllJobs(acc);
    try { await acc.client.logout(); } catch {}

    // ✅ remove session folder safely
    removeDirSafe(accountSessionDir(accountId));

    acc.ready = false;
    acc.qrDataUrl = "";

    res.json({ ok: true, message: `Logged out ${accountId}. Open /accounts/${accountId}/qr to scan again.` });
  } catch (e) {
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

    // ✅ remove session folder safely
    removeDirSafe(accountSessionDir(accountId));

    try { fs.unlinkSync(path.join(DATA_DIR, `scheduledMessages.${accountId}.json`)); } catch {}
    try { fs.unlinkSync(recentFile(accountId)); } catch {}

    delete accounts[accountId];

    res.json({ ok: true, message: `Account ${accountId} deleted (session + schedules + recent removed)` });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get("/health", (req, res) => res.send("ok"));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
  console.log(`UI: http://IP:${PORT}/`);
  console.log(`Chromium: ${chromePath || "puppeteer-bundled"}`);
});
