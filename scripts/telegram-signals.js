import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setDefaultResultOrder } from "node:dns";
import { Agent, ProxyAgent } from "undici";
import { shouldNotifyRealtimeEvent } from "../src/telegram-quiet-mode.js";

setDefaultResultOrder("ipv4first");

const DEFAULT_SCAN_URL =
  "http://127.0.0.1:8787/api/scan?period=4h&points=5&threshold=30&maxSymbols=500";
const DEFAULT_SMALLCAP_SCAN_URL =
  "http://127.0.0.1:8787/api/scan?period=4h&points=5&threshold=0&maxSymbols=500&smallCapMaxUsd=100000000&smallCapMinChange=30";
const DEFAULT_REVERSAL_HISTORY_URL = "http://127.0.0.1:8787/api/reversal/history?limit=500";
const DEFAULT_REVERSAL_REALTIME_URL = "http://127.0.0.1:8787/api/reversal/realtime?limit=500";
const DEFAULT_ONCHAIN_EVENTS_URL = "http://127.0.0.1:8787/api/onchain/alerts/events";
const DEFAULT_MANUAL_PUSH_URL = "http://127.0.0.1:8787/api/reversal/manual-push";
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 60 * 1000;

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const telegramApiBaseUrl = String(process.env.TELEGRAM_API_BASE_URL || "https://api.telegram.org").replace(/\/+$/, "");
const telegramProxyUrl = String(process.env.TELEGRAM_PROXY_URL || "").trim();
const telegramRelaySecret = String(process.env.TELEGRAM_RELAY_SECRET || "").trim();
const telegramForceIpv4 = process.env.TELEGRAM_FORCE_IPV4 !== "0";
const telegramDispatcher = telegramProxyUrl
  ? new ProxyAgent(telegramProxyUrl)
  : telegramForceIpv4
    ? new Agent({ connect: { family: 4 } })
    : null;
const scanUrl = process.env.SIGNAL_SCAN_URL || DEFAULT_SCAN_URL;
const smallCapScanUrl = process.env.SMALLCAP_SCAN_URL || DEFAULT_SMALLCAP_SCAN_URL;
const reversalHistoryUrl = process.env.REVERSAL_HISTORY_URL || DEFAULT_REVERSAL_HISTORY_URL;
const reversalRealtimeUrl = process.env.REVERSAL_REALTIME_URL || DEFAULT_REVERSAL_REALTIME_URL;
const onchainEventsUrl = process.env.ONCHAIN_EVENTS_URL || DEFAULT_ONCHAIN_EVENTS_URL;
const manualPushUrl = process.env.REVERSAL_MANUAL_PUSH_URL || DEFAULT_MANUAL_PUSH_URL;
const reversalStateFile = process.env.REVERSAL_NOTIFY_STATE_FILE || join(process.cwd(), "data", "telegram-reversal-state.json");
const realtimeStateFile = process.env.REVERSAL_REALTIME_NOTIFY_STATE_FILE || join(process.cwd(), "data", "telegram-realtime-state.json");
const onchainStateFile = process.env.ONCHAIN_NOTIFY_STATE_FILE || join(process.cwd(), "data", "telegram-onchain-state.json");
const dailySummaryStateFile = process.env.DAILY_KEY_ZONE_STATE_FILE || join(process.cwd(), "data", "telegram-daily-key-zone-state.json");
const summaryIntervalMs = Math.max(60_000, Number(process.env.SIGNAL_INTERVAL_MS) || DEFAULT_INTERVAL_MS);
const pollIntervalMs = Math.max(15_000, Number(process.env.TELEGRAM_POLL_INTERVAL_MS) || DEFAULT_POLL_INTERVAL_MS);
const dailySummaryHour = Math.min(23, Math.max(0, Number.parseInt(process.env.DAILY_KEY_ZONE_REPORT_HOUR || "9", 10) || 0));
const quietMode = process.env.TELEGRAM_QUIET_MODE !== "0";
const forceDailySummary = process.argv.includes("--daily-summary");
const once = process.argv.includes("--once") || forceDailySummary;
const REQUEST_TIMEOUT_MS = 15_000;
const telegramRequestRetries = Math.min(5, Math.max(1, Number.parseInt(process.env.TELEGRAM_REQUEST_RETRIES || "3", 10) || 3));
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

function shanghaiDateKey(value = Date.now()) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

function shanghaiHour(value = Date.now()) {
  return Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value)));
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
  } catch (error) {
    const target = new URL(url);
    const safePath = target.pathname.replace(/\/bot[^/]+/, "/bot***/");
    const code = error?.cause?.code || error?.code;
    const detail = error?.name === "AbortError" ? `timeout after ${REQUEST_TIMEOUT_MS}ms` : code || error?.cause?.message || error?.message || "unknown error";
    throw new Error(`${target.host}${safePath}: ${detail}`);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTelegram(url, options) {
  let lastError;
  for (let attempt = 1; attempt <= telegramRequestRetries; attempt += 1) {
    try {
      return await fetchWithTimeout(url, { ...options, ...(telegramDispatcher ? { dispatcher: telegramDispatcher } : {}) });
    } catch (error) {
      lastError = error;
      if (attempt < telegramRequestRetries) await new Promise((resolve) => setTimeout(resolve, attempt * 1_500));
    }
  }
  throw lastError;
}

function telegramApiUrl(method) {
  return `${telegramApiBaseUrl}/bot${token}/${method}`;
}

function telegramRequestHeaders(headers = {}) {
  return telegramRelaySecret ? { ...headers, "x-telegram-relay-secret": telegramRelaySecret } : headers;
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
    accepted: "突破成立 / 原区域失效",
    "front-run": "未触及转向",
  })[type] || type;
}

function buildRealtimeMessage(events) {
  const opportunityMap = new Map();
  for (const event of events) {
    const key = event.zoneKey || [event.symbol, event.side, event.originTime, event.zoneLow, event.zoneHigh].join(":");
    if (!opportunityMap.has(key)) opportunityMap.set(key, event);
  }
  const opportunities = [...opportunityMap.values()];
  const rows = opportunities.slice(0, 10).map((event, index) => {
    const support = event.side === "support";
    const chart = tradingViewChart(event);
    const symbol = chart.url
      ? `<a href="${htmlEscape(chart.url)}"><b>${htmlEscape(chart.symbol)}</b></a>`
      : `<b>${htmlEscape(chart.symbol || event.symbol || "-")}</b>`;
    const evidence = event.evidence || {};
    const context = event.context || {};
    const evidenceText = ({ high: "高", medium: "中", low: "低", watch: "观察中", separate: "抢跑型", invalidated: "区域失效" })[evidence.level] || "待观察";
    const stageText = ({ confirmed: "已确认", invalidated: "原区域失效", developing: "形成中", watching: "等待触发", "front-run": "单独统计" })[evidence.stage] || "形成中";
    return [
      `${index + 1}. ${symbol} · <b>${realtimeType(event.type)}</b>`,
      `${support ? "支撑 / 潜在反弹" : "阻力 / 潜在回落"} | ${stageText} | 证据 ${evidenceText} (${evidence.score ?? 0})`,
      `价格 ${fmtPrice(event.price)} | 区域 ${fmtPrice(event.zoneLow)} - ${fmtPrice(event.zoneHigh)}`,
      `穿透 ${fmtPct(event.penetrationPct || 0)} | OI ${fmtPct(context.oiChangePct)}`,
      `15分钟成交 ${fmtUsd(context.tradeVolumeUsd)} | 强平 ${fmtUsd(context.liquidationUsd)}`,
      Array.isArray(evidence.reasons) && evidence.reasons.length ? `依据 ${htmlEscape(evidence.reasons.join("、"))}` : "依据 暂无充分猎杀证据",
    ].join("\n");
  });
  return `<b>Key Zone Realtime</b>\n${opportunities.length} 次机会 · ${events.length} 个阶段\n只做观察，不自动交易\n\n${rows.join("\n\n")}`;
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

function dailySummaryFilename(dateKey) {
  return `matrix-key-zone-daily-${dateKey}.txt`;
}

function dailyWatchlistFilename(dateKey) {
  return `tradingview-key-zone-daily-${dateKey}.txt`;
}

function plainDirection(row) {
  return row.type === "support-touch" || row.side === "support" ? "支撑 / 潜在反弹" : "阻力 / 潜在回落";
}

function buildDailyKeyZoneSummary(historyData, realtimeData, now = Date.now()) {
  const since = now - 24 * 60 * 60 * 1000;
  const records = (Array.isArray(historyData.records) ? historyData.records : [])
    .filter((row) => new Date(row.recordedAt || row.triggerTime || row.touchTime).getTime() >= since);
  const episodes = (Array.isArray(realtimeData.episodes) ? realtimeData.episodes : Array.isArray(realtimeData.events) ? realtimeData.events : [])
    .filter((row) => Number(row.updatedAt || row.time || 0) >= since);
  const grouped = new Map();
  const add = (row, text) => {
    const symbol = tradingViewChart(row).symbol || row.symbol || "-";
    const items = grouped.get(symbol) || [];
    items.push(text);
    grouped.set(symbol, items);
  };
  for (const record of records.sort((a, b) => new Date(a.recordedAt || 0) - new Date(b.recordedAt || 0))) {
    add(record, [
      `[信号] ${fmtTime(record.recordedAt)} · ${record.status === "approaching" ? "接近预警" : "重新进入"}`,
      `方向: ${plainDirection(record)}`,
      `价格: ${fmtPrice(record.triggerPrice ?? record.current?.price)} | 区域: ${fmtPrice(record.zoneLow)} - ${fmtPrice(record.zoneHigh)}`,
      `日线锚点: ${fmtTime(record.originTime)} | 4小时触发: ${fmtTime(record.triggerTime || record.touchTime)}`,
    ].join("\n"));
  }
  for (const episode of episodes.sort((a, b) => Number(a.updatedAt || a.time || 0) - Number(b.updatedAt || b.time || 0))) {
    const evidence = episode.evidence || {};
    const context = episode.context || {};
    const snapshots = episode.followUp?.snapshots || {};
    const outcomes = ["5m", "15m", "1h", "4h"]
      .filter((label) => Number.isFinite(Number(snapshots[label]?.directionalPct)))
      .map((label) => `${label} ${fmtPct(snapshots[label].directionalPct)}`)
      .join(" | ") || "等待后续表现";
    add(episode, [
      `[实时] ${fmtTime(episode.updatedAt || episode.time)} · ${(episode.stages || [episode.type]).slice().reverse().map(realtimeType).join(" -> ")}`,
      `方向: ${plainDirection(episode)} | 证据: ${evidence.level || "待观察"} (${evidence.score ?? 0})`,
      `价格: ${fmtPrice(episode.price)} | 区域: ${fmtPrice(episode.zoneLow)} - ${fmtPrice(episode.zoneHigh)}`,
      `依据: ${(evidence.reasons || []).join("、") || "暂无充分猎杀证据"}`,
      `OI: ${fmtPct(context.oiChangePct)} | 强平: ${fmtUsd(context.liquidationUsd)} | 15分钟成交: ${fmtUsd(context.tradeVolumeUsd)}`,
      `后续: ${outcomes}`,
    ].join("\n"));
  }
  const rows = [...grouped.entries()].map(([symbol, items], index) => `${index + 1}. ${symbol}\n${items.join("\n\n")}`);
  const dateKey = shanghaiDateKey(now);
  const symbols = buildTradingViewWatchlist([...records, ...episodes]);
  return {
    dateKey,
    symbols,
    text: [
      "Matrix 关键区域每日标的总结",
      `生成时间: ${fmtTime(now)}（北京时间）`,
      "范围: 过去 24 小时",
      `关键区域记录: ${records.length} | 实时机会: ${episodes.length} | 去重标的: ${symbols.length}`,
      "说明: 顺向表现仅用于指标复核，不代表真实成交或交易收益。",
      "",
      rows.join("\n\n--------------------\n\n") || "过去 24 小时没有已记录的关键区域信号或实时事件。",
      "",
      "TradingView 自选列表（可单独复制导入）:",
      symbols.join(",") || "-",
    ].join("\n"),
  };
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
  const response = await fetchTelegram(telegramApiUrl("sendMessage"), {
    method: "POST",
    headers: telegramRequestHeaders({ "content-type": "application/json" }),
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

async function sendTelegramDocument(content, filename, caption) {
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("caption", caption);
  form.append("document", new Blob([content], { type: "text/plain;charset=utf-8" }), filename);
  const response = await fetchTelegram(telegramApiUrl("sendDocument"), {
    method: "POST",
    headers: telegramRequestHeaders(),
    body: form,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.description || `Telegram document ${response.status}`);
}

async function sendTradingViewWatchlist(records) {
  const symbols = buildTradingViewWatchlist(records);
  if (!symbols.length) return;
  await sendTelegramDocument(symbols.join(","), watchlistFilename(), `TradingView 自选列表｜本批 ${symbols.length} 个标的`);
}

async function readDailySummaryState() {
  try { return JSON.parse(await readFile(dailySummaryStateFile, "utf8")); }
  catch { return {}; }
}

async function markDailySummarySent(dateKey) {
  await mkdir(join(process.cwd(), "data"), { recursive: true });
  await writeFile(dailySummaryStateFile, JSON.stringify({ lastDate: dateKey, sentAt: new Date().toISOString() }, null, 2), "utf8");
}

async function maybeSendDailySummary(historyData, realtimeData) {
  const dateKey = shanghaiDateKey();
  const state = await readDailySummaryState();
  if (!forceDailySummary && (shanghaiHour() < dailySummaryHour || state.lastDate === dateKey)) return false;
  const report = buildDailyKeyZoneSummary(historyData, realtimeData);
  await sendTelegramDocument(
    `\ufeff${report.text}`,
    dailySummaryFilename(report.dateKey),
    `每日标的总结｜过去24小时 ${report.symbols.length} 个标的`,
  );
  if (report.symbols.length) {
    await sendTelegramDocument(
      report.symbols.join(","),
      dailyWatchlistFilename(report.dateKey),
      `TradingView 每日聚合列表｜${report.symbols.length} 个标的`,
    );
  }
  await markDailySummarySent(dateKey);
  console.log(`[${new Date().toISOString()}] sent daily keyzone summary symbols=${report.symbols.length}`);
  return true;
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
  if (forceDailySummary) {
    const [historyResponse, realtimeResponse] = await Promise.all([
      fetchWithTimeout(reversalHistoryUrl),
      fetchWithTimeout(reversalRealtimeUrl),
    ]);
    const historyData = await historyResponse.json().catch(() => ({}));
    const realtimeData = await realtimeResponse.json().catch(() => ({}));
    if (!historyResponse.ok) throw new Error(historyData.error || `Daily history HTTP ${historyResponse.status}`);
    if (!realtimeResponse.ok) throw new Error(realtimeData.error || `Daily realtime HTTP ${realtimeResponse.status}`);
    await maybeSendDailySummary(historyData, realtimeData);
    return;
  }
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
  let realtimeNotifications = [];
  let realtimeBaseline = [];
  let initializeRealtimeState = false;
  if (realtimeResult.status === "fulfilled" && realtimeResult.value.ok) {
    const fresh = await findNewRealtimeEvents(realtimeData);
    realtimeState = fresh.state;
    newRealtimeEvents = fresh.fresh;
    realtimeNotifications = newRealtimeEvents.filter((event) => shouldNotifyRealtimeEvent(event, quietMode));
    realtimeBaseline = fresh.baseline;
    initializeRealtimeState = fresh.initialize;
    if (realtimeNotifications.length) sections.push(buildRealtimeMessage(realtimeNotifications));
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
    if (newReversalRecords.length && !quietMode) {
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
  }
  if (includeSummary) lastSummaryAt = Date.now();
  if (!sections.length && realtimeState && (initializeRealtimeState || newRealtimeEvents.length || realtimeBaseline.length)) {
    await markRealtimeEventsSent([...newRealtimeEvents, ...realtimeBaseline], realtimeState);
  }
  if (manualPushResult.status === "fulfilled" && manualPushResult.value.ok) await sendManualPushRequests(manualPushData);
  let sentDailySummary = false;
  if (reversalResult.status === "fulfilled" && reversalResult.value.ok && realtimeResult.status === "fulfilled" && realtimeResult.value.ok) {
    sentDailySummary = await maybeSendDailySummary(reversalData, realtimeData);
  }
  if (!sections.length && !sentDailySummary && !(Array.isArray(manualPushData.requests) && manualPushData.requests.length)) {
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
