import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_SCAN_URL =
  "http://127.0.0.1:8787/api/scan?period=4h&points=5&threshold=30&maxSymbols=500";
const DEFAULT_SMALLCAP_SCAN_URL =
  "http://127.0.0.1:8787/api/scan?period=4h&points=5&threshold=0&maxSymbols=500&smallCapMaxUsd=100000000&smallCapMinChange=30";
const DEFAULT_REVERSAL_HISTORY_URL = "http://127.0.0.1:8787/api/reversal/history?limit=100";
const DEFAULT_REVERSAL_REALTIME_URL = "http://127.0.0.1:8787/api/reversal/realtime?limit=100";
const DEFAULT_ONCHAIN_EVENTS_URL = "http://127.0.0.1:8787/api/onchain/alerts/events";
const DEFAULT_MANUAL_PUSH_URL = "http://127.0.0.1:8787/api/reversal/manual-push";
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 60 * 1000;

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const scanUrl = process.env.SIGNAL_SCAN_URL || DEFAULT_SCAN_URL;
const smallCapScanUrl = process.env.SMALLCAP_SCAN_URL || DEFAULT_SMALLCAP_SCAN_URL;
const reversalHistoryUrl = process.env.REVERSAL_HISTORY_URL || DEFAULT_REVERSAL_HISTORY_URL;
const reversalRealtimeUrl = process.env.REVERSAL_REALTIME_URL || DEFAULT_REVERSAL_REALTIME_URL;
const onchainEventsUrl = process.env.ONCHAIN_EVENTS_URL || DEFAULT_ONCHAIN_EVENTS_URL;
const manualPushUrl = process.env.REVERSAL_MANUAL_PUSH_URL || DEFAULT_MANUAL_PUSH_URL;
const reversalStateFile = process.env.REVERSAL_NOTIFY_STATE_FILE || join(process.cwd(), "data", "telegram-reversal-state.json");
const realtimeStateFile = process.env.REVERSAL_REALTIME_NOTIFY_STATE_FILE || join(process.cwd(), "data", "telegram-realtime-state.json");
const onchainStateFile = process.env.ONCHAIN_NOTIFY_STATE_FILE || join(process.cwd(), "data", "telegram-onchain-state.json");
const summaryIntervalMs = Math.max(60_000, Number(process.env.SIGNAL_INTERVAL_MS) || DEFAULT_INTERVAL_MS);
const pollIntervalMs = Math.max(15_000, Number(process.env.TELEGRAM_POLL_INTERVAL_MS) || DEFAULT_POLL_INTERVAL_MS);
const once = process.argv.includes("--once");
const REQUEST_TIMEOUT_MS = 15_000;
let lastSummaryAt = 0;

if (!token || !chatId) {
  console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");
  process.exit(1);
}

function htmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function fmtPct(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

function fmtRate(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return `${(n * 100).toFixed(4)}%`;
}

function fmtUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "-";
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtRatio(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "-";
  return `${(n * 100).toFixed(2)}%`;
}

function fmtTime(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function fmtPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  if (Math.abs(n) >= 100) return n.toFixed(2);
  if (Math.abs(n) >= 1) return n.toFixed(3);
  return n.toPrecision(5);
}

function tradingViewChart(row) {
  const raw = String(row?.symbol || "").trim().toUpperCase();
  let tvSymbol = row?.tradingViewSymbol || "";
  if (!tvSymbol && raw.endsWith(".HK")) tvSymbol = `HKEX:${raw.slice(0, -3).replace(/^0+(?=\d)/, "")}`;
  if (!tvSymbol && ["XAUUSD", "XAGUSD"].includes(raw)) tvSymbol = `OANDA:${raw}`;
  if (!tvSymbol && raw.endsWith("USDT")) tvSymbol = `BINANCE:${raw}.P`;
  return {
    symbol: tvSymbol || raw,
    url: row?.chartUrl || (tvSymbol ? `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tvSymbol)}` : ""),
  };
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function buildMessage(data) {
  const alerts = Array.isArray(data.alerts) ? data.alerts : [];
  const generatedAt = data.generatedAt ? fmtTime(data.generatedAt) : fmtTime(Date.now());
  const header = [
    "<b>Position Change Signals</b>",
    `Time: ${htmlEscape(generatedAt)}`,
    `Scan: ${htmlEscape(data.scanned ?? "-")} | Signals: ${alerts.length}`,
    `Window: ${htmlEscape(data.period ?? "-")} x ${htmlEscape(data.points ?? "-")} | Threshold: ${htmlEscape(data.threshold ?? "-")}%`,
  ].join("\n");

  if (!alerts.length) {
    return `${header}\n\nNo signals reached the threshold.`;
  }

  const rows = alerts
    .slice()
    .sort((a, b) => Number(b.changePct || 0) - Number(a.changePct || 0))
    .slice(0, 15)
    .map((row, index) => {
      const symbol = htmlEscape(row.symbol || "-");
      return [
        `${index + 1}. <b>${symbol}</b> ${fmtPct(row.changePct)}`,
        `Value ${fmtPct(row.valueChangePct)} | MCap ${fmtUsd(row.marketCap)} | Rate ${fmtRate(row.fundingRate)}`,
        `Liq/MCap ${fmtRatio(row.bscLiquidityToMcap)} | ${fmtTime(row.startTime)} - ${fmtTime(row.endTime)}`,
      ].join("\n");
    });

  return `${header}\n\n${rows.join("\n\n")}`;
}

function buildSmallCapMessage(data) {
  const rows = Array.isArray(data.smallCaps) ? data.smallCaps.slice().sort((a, b) => Number(b.changePct || 0) - Number(a.changePct || 0)).slice(0, 8) : [];
  const header = [
    "<b>Low-Cap Position Signals</b>",
    `Time: ${htmlEscape(data.generatedAt ? fmtTime(data.generatedAt) : fmtTime(Date.now()))}`,
    `MCap max ${htmlEscape(fmtUsd(data.smallCap?.maxUsd))} | Change min ${htmlEscape(data.smallCap?.minChangePct ?? "-")}%`,
    `Scanned: ${htmlEscape(data.scanned ?? "-")} | Candidates: ${rows.length}`,
  ].join("\n");
  if (!rows.length) return `${header}\n\nNo low-cap signals reached the filter.`;
  return `${header}\n\n${rows.map((row, index) => [
    `${index + 1}. <b>${htmlEscape(row.symbol || "-")}</b> ${fmtPct(row.changePct)}`,
    `MCap ${fmtUsd(row.marketCap)} | OI ${fmtPct(row.valueChangePct)} | Rate ${fmtRate(row.fundingRate)}`,
    `BSC ${htmlEscape(row.bscLiquidityBand || "-")} | Liq/MCap ${fmtRatio(row.bscLiquidityToMcap)}`,
  ].join("\n")).join("\n\n")}`;
}

function buildReversalMessage(records) {
  const watchlistCount = buildTradingViewWatchlist(records).length;
  const header = [
    "<b>Daily Key Zone Signals</b>",
    `New records: ${records.length}`,
    "Anchor: 1D | Trigger: 4h | Manual decision only",
    watchlistCount ? `TradingView list: ${watchlistCount} symbols (file below)` : "",
  ].filter(Boolean).join("\n");
  const rows = records.slice(0, 10).map((row, index) => {
    const support = row.type === "support-touch";
    const state = row.status === "approaching" ? "Approaching alert" : "Zone re-entry";
    const chart = tradingViewChart(row);
    const symbol = chart.url
      ? `<a href="${htmlEscape(chart.url)}"><b>${htmlEscape(chart.symbol)}</b></a>`
      : `<b>${htmlEscape(chart.symbol || "-")}</b>`;
    return [
      `${index + 1}. ${symbol} · ${state}`,
      `${support ? "Support / potential rebound" : "Resistance / potential pullback"}`,
      `Price ${fmtPrice(row.triggerPrice ?? row.current?.price)} | Zone ${fmtPrice(row.zoneLow)} - ${fmtPrice(row.zoneHigh)}`,
      `Anchor ${fmtTime(row.originTime)} | Trigger ${fmtTime(row.triggerTime ?? row.touchTime)}`,
    ].join("\n");
  });
  return `${header}\n\n${rows.join("\n\n")}`;
}

function realtimeType(type) {
  return ({
    approaching: "接近区域",
    touched: "触及区域",
    swept: "穿透区域",
    reclaimed: "收回确认",
    "front-run": "未触及转向",
  })[type] || type;
}

function buildRealtimeMessage(events) {
  const rows = events.slice(0, 10).map((event, index) => {
    const support = event.side === "support";
    const chart = tradingViewChart(event);
    const symbol = chart.url
      ? `<a href="${htmlEscape(chart.url)}"><b>${htmlEscape(chart.symbol)}</b></a>`
      : `<b>${htmlEscape(chart.symbol || event.symbol || "-")}</b>`;
    const evidence = event.evidence || {};
    const context = event.context || {};
    const evidenceText = ({ high: "高", medium: "中", low: "低" })[evidence.level] || "待观察";
    return [
      `${index + 1}. ${symbol} · <b>${realtimeType(event.type)}</b>`,
      `${support ? "支撑 / 潜在反弹" : "阻力 / 潜在回落"} | 证据 ${evidenceText} (${evidence.score ?? 0})`,
      `价格 ${fmtPrice(event.price)} | 区域 ${fmtPrice(event.zoneLow)} - ${fmtPrice(event.zoneHigh)}`,
      `穿透 ${fmtPct(event.penetrationPct || 0)} | OI ${fmtPct(context.oiChangePct)}`,
      `15分钟成交 ${fmtUsd(context.tradeVolumeUsd)} | 强平 ${fmtUsd(context.liquidationUsd)}`,
      Array.isArray(evidence.reasons) && evidence.reasons.length ? `依据 ${htmlEscape(evidence.reasons.join("、"))}` : "依据 暂无充分猎杀证据",
    ].join("\n");
  });
  return `<b>Key Zone Realtime</b>\n只做观察，不自动交易\n\n${rows.join("\n\n")}`;
}

function buildTradingViewWatchlist(records) {
  return [...new Set(records
    .map((row) => tradingViewChart(row).symbol)
    .map((symbol) => String(symbol || "").trim().toUpperCase())
    .filter((symbol) => symbol.includes(":")))];
}

function watchlistFilename() {
  const timestamp = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date()).replaceAll(/[-: ]/g, "");
  return `tradingview-key-zone-${timestamp}.txt`;
}

function buildOnchainMessage(events) {
  const rows = events.slice(0, 10).map((event, index) => [
    `${index + 1}. <b>${htmlEscape(event.symbol || event.address)}</b> · ${event.mode === "below" ? "跌破" : event.mode === "above" ? "突破" : "进入区间"}`,
    `Price ${fmtPrice(event.price)} | Target ${fmtPrice(event.targetPrice)} | MCap ${fmtUsd(event.marketCap)}`,
    `Address ${htmlEscape(event.address)}${event.note ? ` | ${htmlEscape(event.note)}` : ""}`,
  ].join("\n"));
  return `<b>On-chain Price Alerts</b>\nNew events: ${events.length}\n\n${rows.join("\n\n")}`;
}

async function readOnchainState() {
  try { return JSON.parse(await readFile(onchainStateFile, "utf8")); } catch { return { sent: [] }; }
}

async function findNewOnchainEvents(data) {
  const state = await readOnchainState();
  const sent = new Set(Array.isArray(state.sent) ? state.sent : []);
  const fresh = (Array.isArray(data.events) ? data.events : []).filter((event) => event.id && !sent.has(event.id));
  return { fresh, state };
}

async function markOnchainEventsSent(events, state) {
  if (!events.length) return;
  const sent = new Set(Array.isArray(state.sent) ? state.sent : []);
  events.forEach((event) => sent.add(event.id));
  await mkdir(join(process.cwd(), "data"), { recursive: true });
  await writeFile(onchainStateFile, JSON.stringify({ sent: Array.from(sent).slice(-500), updatedAt: new Date().toISOString() }, null, 2), "utf8");
}

async function readReversalState() {
  try {
    return JSON.parse(await readFile(reversalStateFile, "utf8"));
  } catch {
    return { initialized: false, sent: [] };
  }
}

async function findNewReversalRecords(data) {
  const records = Array.isArray(data.records) ? data.records : [];
  const state = await readReversalState();
  const sent = new Set(Array.isArray(state.sent) ? state.sent : []);
  const fresh = records.filter((record) => record.recordKey && !sent.has(record.recordKey));
  if (!state.initialized && !fresh.length) return { fresh: [], state };
  if (!state.initialized) return { fresh: fresh.slice(0, 10), state };
  return { fresh, state };
}

async function markReversalRecordsSent(records, state) {
  if (!records.length) return;
  const sent = new Set(Array.isArray(state.sent) ? state.sent : []);
  records.forEach((record) => sent.add(record.recordKey));
  const next = { initialized: true, sent: Array.from(sent).slice(-500), updatedAt: new Date().toISOString() };
  await mkdir(join(process.cwd(), "data"), { recursive: true });
  await writeFile(reversalStateFile, JSON.stringify(next, null, 2), "utf8");
}

async function findNewRealtimeEvents(data) {
  let state;
  try { state = JSON.parse(await readFile(realtimeStateFile, "utf8")); }
  catch { state = { initialized: false, sent: [] }; }
  const sent = new Set(Array.isArray(state.sent) ? state.sent : []);
  const fresh = (Array.isArray(data.events) ? data.events : []).filter((event) => event.id && !sent.has(event.id));
  if (!state.initialized) return { fresh: [], state: { ...state, initialized: true }, baseline: fresh, initialize: true };
  return { fresh, state, baseline: [], initialize: false };
}

async function markRealtimeEventsSent(items, state) {
  const sent = new Set(Array.isArray(state.sent) ? state.sent : []);
  items.forEach((item) => sent.add(item.id));
  await mkdir(join(process.cwd(), "data"), { recursive: true });
  await writeFile(realtimeStateFile, JSON.stringify({ initialized: true, sent: [...sent].slice(-2_000), updatedAt: new Date().toISOString() }, null, 2), "utf8");
}

async function sendTelegram(text) {
  const response = await fetchWithTimeout(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.description || `Telegram ${response.status}`);
  }
}

async function sendTradingViewWatchlist(records) {
  const symbols = buildTradingViewWatchlist(records);
  if (!symbols.length) return;
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("caption", `TradingView 自选列表｜本批 ${symbols.length} 个标的`);
  form.append("document", new Blob([symbols.join(",")], { type: "text/plain;charset=utf-8" }), watchlistFilename());
  const response = await fetchWithTimeout(`https://api.telegram.org/bot${token}/sendDocument`, {
    method: "POST",
    body: form,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.description || `Telegram document ${response.status}`);
}

async function acknowledgeManualPush(id) {
  const response = await fetchWithTimeout(manualPushUrl, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, status: "sent" }),
  });
  if (!response.ok) throw new Error(`Manual push acknowledgement ${response.status}`);
}

async function sendManualPushRequests(data) {
  const requests = Array.isArray(data.requests) ? data.requests : [];
  for (const request of requests) {
    const records = Array.isArray(request.records) ? request.records : [];
    if (!request.id || !records.length) continue;
    await sendTelegram(`<b>Manual Push</b>\n\n${buildReversalMessage(records)}`);
    try {
      await sendTradingViewWatchlist(records);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Manual TradingView watchlist: ${error.message}`);
    }
    await acknowledgeManualPush(request.id);
    console.log(`[${new Date().toISOString()}] sent manual keyzone=${records.length}`);
  }
}

async function run() {
  const includeSummary = once || Date.now() - lastSummaryAt >= summaryIntervalMs;
  const results = await Promise.allSettled([
    includeSummary ? fetchWithTimeout(scanUrl) : Promise.resolve(null),
    includeSummary ? fetchWithTimeout(smallCapScanUrl) : Promise.resolve(null),
    fetchWithTimeout(reversalHistoryUrl),
    fetchWithTimeout(reversalRealtimeUrl),
    fetchWithTimeout(onchainEventsUrl),
    fetchWithTimeout(manualPushUrl),
  ]);
  const [signalResult, smallCapResult, reversalResult, realtimeResult, onchainResult, manualPushResult] = results;
  const signalData = includeSummary && signalResult.status === "fulfilled" ? await signalResult.value.json().catch(() => ({})) : { error: signalResult.reason?.message };
  const smallCapData = includeSummary && smallCapResult.status === "fulfilled" ? await smallCapResult.value.json().catch(() => ({})) : { error: smallCapResult.reason?.message };
  const reversalData = reversalResult.status === "fulfilled" ? await reversalResult.value.json().catch(() => ({})) : { error: reversalResult.reason?.message };
  const realtimeData = realtimeResult.status === "fulfilled" ? await realtimeResult.value.json().catch(() => ({})) : { error: realtimeResult.reason?.message };
  const onchainData = onchainResult.status === "fulfilled" ? await onchainResult.value.json().catch(() => ({})) : { error: onchainResult.reason?.message };
  const manualPushData = manualPushResult.status === "fulfilled" ? await manualPushResult.value.json().catch(() => ({})) : { error: manualPushResult.reason?.message };
  const signalOk = includeSummary && signalResult.status === "fulfilled" && signalResult.value?.ok;
  const smallCapOk = includeSummary && smallCapResult.status === "fulfilled" && smallCapResult.value?.ok;
  const sections = [];
  if (includeSummary) {
    sections.push(signalOk ? buildMessage(signalData) : `<b>Position Change Signals</b>\n读取失败: ${htmlEscape(signalData.error || `HTTP ${signalResult.value?.status || "network"}`)}`);
    sections.push(smallCapOk ? buildSmallCapMessage(smallCapData) : `<b>Low-Cap Position Signals</b>\n读取失败: ${htmlEscape(smallCapData.error || `HTTP ${smallCapResult.value?.status || "network"}`)}`);
  }
  let reversalState = null;
  let newReversalRecords = [];
  if (reversalResult.status === "fulfilled" && reversalResult.value.ok) {
    const fresh = await findNewReversalRecords(reversalData);
    reversalState = fresh.state;
    newReversalRecords = fresh.fresh;
    if (newReversalRecords.length) sections.push(buildReversalMessage(newReversalRecords));
  }
  let realtimeState = null;
  let newRealtimeEvents = [];
  let realtimeBaseline = [];
  let initializeRealtimeState = false;
  if (realtimeResult.status === "fulfilled" && realtimeResult.value.ok) {
    const fresh = await findNewRealtimeEvents(realtimeData);
    realtimeState = fresh.state;
    newRealtimeEvents = fresh.fresh;
    realtimeBaseline = fresh.baseline;
    initializeRealtimeState = fresh.initialize;
    if (newRealtimeEvents.length) sections.push(buildRealtimeMessage(newRealtimeEvents));
  }
  let onchainState = null;
  let newOnchainEvents = [];
  if (onchainResult.status === "fulfilled" && onchainResult.value.ok) {
    const fresh = await findNewOnchainEvents(onchainData);
    onchainState = fresh.state;
    newOnchainEvents = fresh.fresh;
    if (newOnchainEvents.length) sections.push(buildOnchainMessage(newOnchainEvents));
  }
  if (sections.length) {
    await sendTelegram(sections.join("\n\n"));
    if (newReversalRecords.length) {
      try {
        await sendTradingViewWatchlist(newReversalRecords);
      } catch (error) {
        console.error(`[${new Date().toISOString()}] TradingView watchlist: ${error.message}`);
      }
    }
    if (reversalState && newReversalRecords.length) await markReversalRecordsSent(newReversalRecords, reversalState);
    if (realtimeState && (initializeRealtimeState || newRealtimeEvents.length || realtimeBaseline.length)) {
      await markRealtimeEventsSent([...newRealtimeEvents, ...realtimeBaseline], realtimeState);
    }
    if (onchainState && newOnchainEvents.length) await markOnchainEventsSent(newOnchainEvents, onchainState);
    if (includeSummary) lastSummaryAt = Date.now();
  }
  if (!sections.length && realtimeState && (initializeRealtimeState || realtimeBaseline.length)) {
    await markRealtimeEventsSent(realtimeBaseline, realtimeState);
  }
  if (manualPushResult.status === "fulfilled" && manualPushResult.value.ok) await sendManualPushRequests(manualPushData);
  if (!sections.length && !(Array.isArray(manualPushData.requests) && manualPushData.requests.length)) {
    console.log(`[${new Date().toISOString()}] checked: no new records`);
    return;
  }
  console.log(`[${new Date().toISOString()}] sent position=${includeSummary && Array.isArray(signalData.alerts) ? signalData.alerts.length : 0}, lowcap=${includeSummary && Array.isArray(smallCapData.smallCaps) ? smallCapData.smallCaps.length : 0}, keyzone=${newReversalRecords.length}, realtime=${newRealtimeEvents.length}, onchain=${newOnchainEvents.length}`);
}

async function loop() {
  while (true) {
    try {
      await run();
    } catch (error) {
      console.error(`[${new Date().toISOString()}] ${error.message}`);
    }
    if (once) break;
    await new Promise((resolve) => setTimeout(resolve, Number.isFinite(pollIntervalMs) ? pollIntervalMs : DEFAULT_POLL_INTERVAL_MS));
  }
}

loop();
