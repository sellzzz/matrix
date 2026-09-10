import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { WebSocket } from "undici";
import { config } from "../src/config.js";
import { candidateKey, createZoneRuntime, distanceFromZonePct, processZonePrice, summarizeEvidence } from "../src/realtime-zone-engine.js";

const REFRESH_MS = Math.max(30_000, Number(process.env.REALTIME_CANDIDATE_REFRESH_MS) || 60_000);
const OI_INTERVAL_MS = Math.max(60_000, Number(process.env.REALTIME_OI_INTERVAL_MS) || 120_000);
const WINDOW_MS = 15 * 60_000;
const MAX_OI_SYMBOLS = 20;
const MAX_EVENTS = 1_000;
const runtimes = new Map();
let runtimesBySymbol = new Map();
const trades = new Map();
const liquidations = new Map();
const oiSamples = new Map();
let socket = null;
let socketSignature = "";
let subscribedStreams = new Set();
let subscriptionTimer = null;
let subscriptionId = 1;
let reconnectTimer = null;
let events = [];
let connected = false;
let receivedMessages = 0;
let connectionStartedAt = 0;
let lastMessageAt = 0;
let candidateGeneratedAt = null;
let lastError = null;
let writeQueue = Promise.resolve();

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function trimWindow(rows, now = Date.now()) {
  return (rows || []).filter((row) => row.time >= now - WINDOW_MS);
}

function pushWindow(map, symbol, row) {
  const rows = trimWindow(map.get(symbol), row.time);
  rows.push(row);
  map.set(symbol, rows);
}

function pushTrade(symbol, row) {
  const rows = trimWindow(trades.get(symbol), row.time);
  const bucketTime = Math.floor(row.time / 10_000) * 10_000;
  const bucket = rows.at(-1);
  if (bucket?.time === bucketTime) {
    bucket.buyUsd += row.buyUsd;
    bucket.sellUsd += row.sellUsd;
    bucket.count += 1;
  } else {
    rows.push({ time: bucketTime, buyUsd: row.buyUsd, sellUsd: row.sellUsd, count: 1 });
  }
  trades.set(symbol, rows);
}

function tradeContext(symbol, now = Date.now()) {
  const tradeRows = trimWindow(trades.get(symbol), now);
  const liquidationRows = trimWindow(liquidations.get(symbol), now);
  const oiRows = trimWindow(oiSamples.get(symbol), now);
  const buyUsd = tradeRows.reduce((sum, row) => sum + row.buyUsd, 0);
  const sellUsd = tradeRows.reduce((sum, row) => sum + row.sellUsd, 0);
  const tradeVolumeUsd = buyUsd + sellUsd;
  const liquidationUsd = liquidationRows.reduce((sum, row) => sum + row.usd, 0);
  const firstOi = oiRows[0]?.value;
  const lastOi = oiRows.at(-1)?.value;
  const oiChangePct = firstOi > 0 && lastOi > 0 ? ((lastOi - firstOi) / firstOi) * 100 : null;
  return {
    windowMinutes: 15,
    tradeVolumeUsd,
    buyUsd,
    sellUsd,
    tradeImbalancePct: tradeVolumeUsd > 0 ? (Math.abs(buyUsd - sellUsd) / tradeVolumeUsd) * 100 : 0,
    aggressiveSide: buyUsd > sellUsd ? "buy" : sellUsd > buyUsd ? "sell" : "balanced",
    liquidationUsd,
    longLiquidationUsd: liquidationRows.filter((row) => row.side === "SELL").reduce((sum, row) => sum + row.usd, 0),
    shortLiquidationUsd: liquidationRows.filter((row) => row.side === "BUY").reduce((sum, row) => sum + row.usd, 0),
    oiChangePct,
  };
}

function makeEvent(runtime, raw) {
  const context = tradeContext(raw.symbol, raw.time);
  const evidence = summarizeEvidence(runtime, { ...context, ...raw }, raw.type);
  return {
    id: `${runtime.key}:${raw.type}:${raw.time}`,
    recordedAt: new Date().toISOString(),
    ...raw,
    context,
    evidence,
  };
}

async function saveState() {
  const now = Date.now();
  const active = [...runtimes.values()].map((runtime) => ({
    key: runtime.key,
    symbol: runtime.candidate.symbol,
    side: runtime.candidate.side,
    zoneLow: runtime.candidate.zoneLow,
    zoneHigh: runtime.candidate.zoneHigh,
    originTime: runtime.candidate.originTime,
    phase: runtime.phase,
    lastPrice: runtime.lastPrice,
    distancePct: distanceFromZonePct(runtime.lastPrice, runtime.candidate),
    evidence: summarizeEvidence(runtime, tradeContext(runtime.candidate.symbol, now)),
  })).sort((a, b) => a.distancePct - b.distancePct);
  const payload = {
    generatedAt: new Date().toISOString(),
    status: connected ? "monitoring" : "connecting",
    connected,
    candidateGeneratedAt,
    candidateCount: runtimes.size,
    monitoredSymbols: new Set(active.map((row) => row.symbol)).size,
    receivedMessages,
    lastMessageAt: lastMessageAt ? new Date(lastMessageAt).toISOString() : null,
    lastError,
    active,
    events: events.slice(0, MAX_EVENTS),
  };
  const file = config.reversalRealtimeFile;
  const temporary = `${file}.tmp`;
  writeQueue = writeQueue.then(async () => {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(temporary, JSON.stringify(payload, null, 2), "utf8");
    await rename(temporary, file);
  });
  return writeQueue;
}

function recordPrice(symbol, price, time) {
  let changed = false;
  for (const runtime of runtimesBySymbol.get(symbol) || []) {
    const produced = processZonePrice(runtime, price, time);
    if (produced.length) {
      events.unshift(...produced.map((row) => makeEvent(runtime, row)));
      events = events.slice(0, MAX_EVENTS);
      changed = true;
    }
  }
  scheduleSubscriptionSync();
  if (changed) saveState().catch((error) => { lastError = error.message; });
}

function handleMessage(payload) {
  const data = payload?.data || payload;
  if (!data?.e) return;
  receivedMessages += 1;
  lastMessageAt = Date.now();
  if (data.e === "24hrMiniTicker") {
    recordPrice(data.s, finite(data.c), finite(data.E, Date.now()));
    return;
  }
  if (data.e === "aggTrade") {
    const price = finite(data.p);
    const quote = price * finite(data.q);
    const time = finite(data.T || data.E, Date.now());
    pushTrade(data.s, {
      time,
      buyUsd: data.m ? 0 : quote,
      sellUsd: data.m ? quote : 0,
    });
    recordPrice(data.s, price, time);
    return;
  }
  if (data.e === "forceOrder" && data.o?.s) {
    const order = data.o;
    const price = finite(order.ap || order.p);
    pushWindow(liquidations, order.s, {
      time: finite(order.T || data.E, Date.now()),
      side: order.S,
      usd: price * finite(order.z || order.q),
    });
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect(true);
  }, 5_000);
}

function desiredStreams() {
  const symbols = [...runtimesBySymbol.keys()].map((symbol) => symbol.toLowerCase());
  const heavy = symbols.filter((symbol) => (runtimesBySymbol.get(symbol.toUpperCase()) || []).some((runtime) =>
    distanceFromZonePct(runtime.lastPrice, runtime.candidate) <= 3
    || ["approaching", "touched", "swept"].includes(runtime.phase)));
  return new Set([
    ...symbols.map((symbol) => `${symbol}@miniTicker`),
    ...heavy.flatMap((symbol) => [`${symbol}@aggTrade`, `${symbol}@forceOrder`]),
  ]);
}

function syncSubscriptions(force = false) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const desired = desiredStreams();
  const subscribe = [...desired].filter((stream) => force || !subscribedStreams.has(stream));
  const unsubscribe = force ? [] : [...subscribedStreams].filter((stream) => !desired.has(stream));
  if (subscribe.length) socket.send(JSON.stringify({ method: "SUBSCRIBE", params: subscribe, id: subscriptionId++ }));
  if (unsubscribe.length) socket.send(JSON.stringify({ method: "UNSUBSCRIBE", params: unsubscribe, id: subscriptionId++ }));
  subscribedStreams = desired;
}

function scheduleSubscriptionSync() {
  if (subscriptionTimer) return;
  subscriptionTimer = setTimeout(() => {
    subscriptionTimer = null;
    syncSubscriptions();
  }, 1_000);
}

function connect(force = false) {
  const symbols = [...new Set([...runtimes.values()].map((runtime) => runtime.candidate.symbol.toLowerCase()))].sort();
  const signature = symbols.join(",");
  if (!force && signature === socketSignature && socket) return;
  socketSignature = signature;
  if (socket) {
    socket.onclose = null;
    socket.close();
    socket = null;
  }
  connected = false;
  if (!symbols.length) {
    saveState().catch(() => {});
    return;
  }
  subscribedStreams = new Set();
  connectionStartedAt = Date.now();
  lastMessageAt = 0;
  socket = new WebSocket("wss://fstream.binance.com/market/ws");
  socket.onopen = () => {
    syncSubscriptions(true);
    connected = true;
    lastError = null;
    console.log(`[realtime] connected: ${symbols.length} symbols, ${subscribedStreams.size} streams`);
    saveState().catch(() => {});
  };
  socket.onmessage = (message) => {
    try { handleMessage(JSON.parse(String(message.data))); }
    catch (error) { lastError = error.message; }
  };
  socket.onerror = () => { lastError = "Binance WebSocket error"; };
  socket.onclose = () => {
    connected = false;
    socket = null;
    saveState().catch(() => {});
    scheduleReconnect();
  };
}

async function loadCandidates() {
  try {
    const parsed = JSON.parse(await readFile(config.reversalCandidateFile, "utf8"));
    candidateGeneratedAt = parsed.generatedAt || null;
    const nextCandidates = (Array.isArray(parsed.candidates) ? parsed.candidates : []).slice(0, 80);
    const nextKeys = new Set(nextCandidates.map(candidateKey));
    for (const key of runtimes.keys()) if (!nextKeys.has(key)) runtimes.delete(key);
    for (const candidate of nextCandidates) {
      const key = candidateKey(candidate);
      if (!runtimes.has(key)) runtimes.set(key, createZoneRuntime(candidate));
      else runtimes.get(key).candidate = candidate;
    }
    runtimesBySymbol = new Map();
    for (const runtime of runtimes.values()) {
      const symbol = runtime.candidate.symbol;
      if (!runtimesBySymbol.has(symbol)) runtimesBySymbol.set(symbol, []);
      runtimesBySymbol.get(symbol).push(runtime);
    }
    connect();
    scheduleSubscriptionSync();
    await saveState();
  } catch (error) {
    if (error.code !== "ENOENT") lastError = error.message;
    await saveState();
  }
}

async function pollOpenInterest() {
  const bySymbol = new Map();
  for (const runtime of runtimes.values()) {
    const distance = distanceFromZonePct(runtime.lastPrice, runtime.candidate);
    if (distance <= 1.5 || ["touched", "swept"].includes(runtime.phase)) {
      bySymbol.set(runtime.candidate.symbol, distance);
    }
  }
  const symbols = [...bySymbol].sort((a, b) => a[1] - b[1]).slice(0, MAX_OI_SYMBOLS).map(([symbol]) => symbol);
  for (const symbol of symbols) {
    try {
      const response = await fetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${encodeURIComponent(symbol)}`);
      if (!response.ok) throw new Error(`OI HTTP ${response.status}`);
      const data = await response.json();
      pushWindow(oiSamples, symbol, { time: finite(data.time, Date.now()), value: finite(data.openInterest) });
    } catch (error) {
      lastError = `${symbol}: ${error.message}`;
    }
  }
  if (symbols.length) await saveState();
}

async function start() {
  try {
    const previous = JSON.parse(await readFile(config.reversalRealtimeFile, "utf8"));
    events = Array.isArray(previous.events) ? previous.events.slice(0, MAX_EVENTS) : [];
  } catch {}
  await loadCandidates();
  setInterval(() => loadCandidates().catch((error) => { lastError = error.message; }), REFRESH_MS);
  setInterval(() => pollOpenInterest().catch((error) => { lastError = error.message; }), OI_INTERVAL_MS);
  setInterval(() => saveState().catch((error) => { lastError = error.message; }), 5 * 60_000);
  setInterval(() => {
    const activityAt = lastMessageAt || connectionStartedAt;
    if (socket && runtimes.size && Date.now() - activityAt > 120_000) {
      lastError = "Binance WebSocket has no market data for 120 seconds";
      socket.close();
    }
  }, 30_000);
}

process.on("SIGTERM", () => {
  socket?.close();
  process.exit(0);
});

start().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
