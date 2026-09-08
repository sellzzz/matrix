import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import { Interface } from "ethers";
import { config } from "./src/config.js";
import { createJsonStore } from "./src/json-store.js";
import { createRouter } from "./src/router.js";

const { port: PORT, publicDir: PUBLIC_DIR, binanceFapi: BINANCE_FAPI, coingeckoApi: COINGECKO_API, dexscreenerApi: DEXSCREENER_API, bscRpc: BSC_RPC, cacheMs: CACHE_MS, macroCacheMs: MACRO_CACHE_MS, fetchTimeoutMs: FETCH_TIMEOUT_MS, maxScanCache: MAX_SCAN_CACHE, reversalCacheMs: REVERSAL_CACHE_MS, reversalTopFutures: REVERSAL_TOP_FUTURES, reversalMaxAssets: REVERSAL_MAX_ASSETS, reversalHistoryFile: REVERSAL_HISTORY_FILE, reversalHistoryLimit: REVERSAL_HISTORY_LIMIT, onchainAlertsFile: ONCHAIN_ALERTS_FILE, onchainAlertLimit: ONCHAIN_ALERT_LIMIT, onchainPriceCacheMs: ONCHAIN_PRICE_CACHE_MS, onchainCheckConcurrency: ONCHAIN_CHECK_CONCURRENCY, reversalSignalCooldownDays: REVERSAL_SIGNAL_COOLDOWN_DAYS, fredApi: FRED_API, treasuryCurveCsv: TREASURY_CURVE_CSV, cmeFedwatchApi: CME_FEDWATCH_API, concurrency: CONCURRENCY } = config;

let symbolsCache = { at: 0, data: [] };
let marketCapCache = { at: 0, data: new Map() };
let fundingCache = { at: 0, data: new Map() };
let bscContractCache = { at: 0, data: new Map() };
let bscPoolCache = new Map();
let pancakeV3PoolCache = new Map();
let scanCache = new Map();
let pancakeRangeCache = new Map();
let reversalCache = new Map();
let reversalCandleCache = new Map();
let binanceRateState = { used: 0, blockedUntil: 0 };
let reversalHistory = null;
const REVERSAL_MIN_AGE_DAYS = 14;
const REVERSAL_MIN_AGE_MS = REVERSAL_MIN_AGE_DAYS * 24 * 60 * 60 * 1000;
const REVERSAL_STRATEGY_VERSION = "isolated-pivot-v2";
let vixCache = { at: 0, data: null };
let dxyCache = { at: 0, data: null };
let treasuryCurveCache = { at: 0, data: null };
let onchainAlerts = null;
let onchainCheckInFlight = false;
const onchainSpotPriceCache = new Map();

const reversalStore = createJsonStore({ file: REVERSAL_HISTORY_FILE, fallback: [], limit: REVERSAL_HISTORY_LIMIT });
const onchainStore = createJsonStore({ file: ONCHAIN_ALERTS_FILE, fallback: { alerts: [], events: [] } });

const POOL_IFACE = new Interface([
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint32 feeProtocol,bool unlocked)",
  "function liquidity() view returns (uint128)",
  "function tickSpacing() view returns (int24)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function ticks(int24 tick) view returns (uint128 liquidityGross,int128 liquidityNet,uint256 feeGrowthOutside0X128,uint256 feeGrowthOutside1X128,int56 tickCumulativeOutside,uint160 secondsPerLiquidityOutsideX128,uint32 secondsOutside,bool initialized)",
  "function tickBitmap(int16 wordPosition) view returns (uint256)",
]);
const ERC20_IFACE = new Interface([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
]);

const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY;
if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
}

function json(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  res.end(JSON.stringify(payload));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function parseNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function parseInteger(value, fallback, min, max) {
  return Math.round(parseNumber(value, fallback, min, max));
}

async function readJsonBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 100_000) throw new Error("Request body too large");
  }
  return body ? JSON.parse(body) : {};
}

function nextRateWindow() {
  const now = Date.now();
  return now + (60_000 - (now % 60_000)) + 250;
}

async function waitForBinanceBudget() {
  const now = Date.now();
  if (now >= binanceRateState.blockedUntil && binanceRateState.used < 1800) return;
  const waitMs = Math.max(0, binanceRateState.blockedUntil - now);
  if (waitMs > 0) await new Promise((resolveWait) => setTimeout(resolveWait, waitMs));
  binanceRateState = { used: 0, blockedUntil: 0 };
}

async function binance(path) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await waitForBinanceBudget();
    const response = await fetchWithTimeout(`${BINANCE_FAPI}${path}`, {
      headers: { "user-agent": "oi-dashboard/1.0" },
    });
    const usedWeight = Number(response.headers.get("x-mbx-used-weight-1m"));
    if (Number.isFinite(usedWeight)) {
      binanceRateState.used = Math.max(binanceRateState.used, usedWeight);
      if (usedWeight >= 1800) binanceRateState.blockedUntil = nextRateWindow();
    }
    if (response.ok) return response.json();
    if (response.status === 429 && attempt === 0) {
      const retryAfter = Number(response.headers.get("retry-after"));
      binanceRateState.blockedUntil = Math.max(nextRateWindow(), Date.now() + (Number.isFinite(retryAfter) ? retryAfter * 1000 : 0));
      continue;
    }
    const text = await response.text().catch(() => "");
    throw new Error(`Binance ${response.status}: ${text.slice(0, 180)}`);
  }
  throw new Error("Binance request throttled");
}

async function coingecko(path) {
  const response = await fetchWithTimeout(`${COINGECKO_API}${path}`, {
    headers: { "user-agent": "oi-dashboard/1.0" },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`CoinGecko ${response.status}: ${text.slice(0, 180)}`);
  }
  return response.json();
}

async function dexscreener(path) {
  const response = await fetchWithTimeout(`${DEXSCREENER_API}${path}`, {
    headers: { "user-agent": "oi-dashboard/1.0" },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`DexScreener ${response.status}: ${text.slice(0, 180)}`);
  }
  return response.json();
}

async function yahooChart(symbol, params) {
  const query = new URLSearchParams(params);
  const response = await fetchWithTimeout(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${query}`, {
    headers: { "user-agent": "market-data-dashboard/1.0" },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Yahoo ${response.status}: ${text.slice(0, 180)}`);
  }
  const payload = await response.json();
  const result = payload.chart?.result?.[0];
  if (!result) throw new Error(payload.chart?.error?.description || "Yahoo chart data unavailable");
  return result;
}

const reversalPresets = new Map([
  ["1810.HK", { symbol: "1810.HK", name: "小米集团", market: "港股", source: "yahoo", sourceSymbol: "1810.HK" }],
  ["0700.HK", { symbol: "0700.HK", name: "腾讯控股", market: "港股", source: "yahoo", sourceSymbol: "0700.HK" }],
  ["9988.HK", { symbol: "9988.HK", name: "阿里巴巴", market: "港股", source: "yahoo", sourceSymbol: "9988.HK" }],
  ["3690.HK", { symbol: "3690.HK", name: "美团", market: "港股", source: "yahoo", sourceSymbol: "3690.HK" }],
  ["9618.HK", { symbol: "9618.HK", name: "京东集团", market: "港股", source: "yahoo", sourceSymbol: "9618.HK" }],
  ["9999.HK", { symbol: "9999.HK", name: "网易", market: "港股", source: "yahoo", sourceSymbol: "9999.HK" }],
  ["2318.HK", { symbol: "2318.HK", name: "中国平安", market: "港股", source: "yahoo", sourceSymbol: "2318.HK" }],
  ["0941.HK", { symbol: "0941.HK", name: "中国移动", market: "港股", source: "yahoo", sourceSymbol: "0941.HK" }],
  ["0388.HK", { symbol: "0388.HK", name: "香港交易所", market: "港股", source: "yahoo", sourceSymbol: "0388.HK" }],
  ["0005.HK", { symbol: "0005.HK", name: "汇丰控股", market: "港股", source: "yahoo", sourceSymbol: "0005.HK" }],
  ["XAUUSD", { symbol: "XAUUSD", name: "黄金", market: "贵金属", source: "yahoo", sourceSymbol: "GC=F" }],
  ["XAGUSD", { symbol: "XAGUSD", name: "白银", market: "贵金属", source: "yahoo", sourceSymbol: "SI=F" }],
  ["AAPLUSDT", { symbol: "AAPLUSDT", name: "Apple", market: "美股合约", source: "binance", sourceSymbol: "AAPLUSDT" }],
  ["AMZNUSDT", { symbol: "AMZNUSDT", name: "Amazon", market: "美股合约", source: "binance", sourceSymbol: "AMZNUSDT" }],
  ["TSLAUSDT", { symbol: "TSLAUSDT", name: "Tesla", market: "美股合约", source: "binance", sourceSymbol: "TSLAUSDT" }],
  ["NVDAUSDT", { symbol: "NVDAUSDT", name: "NVIDIA", market: "美股合约", source: "binance", sourceSymbol: "NVDAUSDT" }],
  ["MSFTUSDT", { symbol: "MSFTUSDT", name: "Microsoft", market: "美股合约", source: "binance", sourceSymbol: "MSFTUSDT" }],
  ["METAUSDT", { symbol: "METAUSDT", name: "Meta", market: "美股合约", source: "binance", sourceSymbol: "METAUSDT" }],
  ["GOOGLUSDT", { symbol: "GOOGLUSDT", name: "Alphabet", market: "美股合约", source: "binance", sourceSymbol: "GOOGLUSDT" }],
  ["MSTRUSDT", { symbol: "MSTRUSDT", name: "Strategy", market: "美股合约", source: "binance", sourceSymbol: "MSTRUSDT" }],
  ["COINUSDT", { symbol: "COINUSDT", name: "Coinbase", market: "美股合约", source: "binance", sourceSymbol: "COINUSDT" }],
  ["HOODUSDT", { symbol: "HOODUSDT", name: "Robinhood", market: "美股合约", source: "binance", sourceSymbol: "HOODUSDT" }],
  ["PLTRUSDT", { symbol: "PLTRUSDT", name: "Palantir", market: "美股合约", source: "binance", sourceSymbol: "PLTRUSDT" }],
  ["CRCLUSDT", { symbol: "CRCLUSDT", name: "Circle", market: "美股合约", source: "binance", sourceSymbol: "CRCLUSDT" }],
  ["AMDUSDT", { symbol: "AMDUSDT", name: "AMD", market: "美股合约", source: "binance", sourceSymbol: "AMDUSDT" }],
  ["AVGOUSDT", { symbol: "AVGOUSDT", name: "Broadcom", market: "美股合约", source: "binance", sourceSymbol: "AVGOUSDT" }],
  ["QCOMUSDT", { symbol: "QCOMUSDT", name: "Qualcomm", market: "美股合约", source: "binance", sourceSymbol: "QCOMUSDT" }],
  ["INTCUSDT", { symbol: "INTCUSDT", name: "Intel", market: "美股合约", source: "binance", sourceSymbol: "INTCUSDT" }],
  ["ORCLUSDT", { symbol: "ORCLUSDT", name: "Oracle", market: "美股合约", source: "binance", sourceSymbol: "ORCLUSDT" }],
  ["NFLXUSDT", { symbol: "NFLXUSDT", name: "Netflix", market: "美股合约", source: "binance", sourceSymbol: "NFLXUSDT" }],
  ["DISUSDT", { symbol: "DISUSDT", name: "Disney", market: "美股合约", source: "binance", sourceSymbol: "DISUSDT" }],
  ["WMTUSDT", { symbol: "WMTUSDT", name: "Walmart", market: "美股合约", source: "binance", sourceSymbol: "WMTUSDT" }],
  ["COSTUSDT", { symbol: "COSTUSDT", name: "Costco", market: "美股合约", source: "binance", sourceSymbol: "COSTUSDT" }],
  ["LLYUSDT", { symbol: "LLYUSDT", name: "Eli Lilly", market: "美股合约", source: "binance", sourceSymbol: "LLYUSDT" }],
  ["CVXUSDT", { symbol: "CVXUSDT", name: "Chevron", market: "美股合约", source: "binance", sourceSymbol: "CVXUSDT" }],
  ["BABAUSDT", { symbol: "BABAUSDT", name: "Alibaba", market: "美股合约", source: "binance", sourceSymbol: "BABAUSDT" }],
  ["SPYUSDT", { symbol: "SPYUSDT", name: "S&P 500 ETF", market: "美股合约", source: "binance", sourceSymbol: "SPYUSDT" }],
  ["QQQUSDT", { symbol: "QQQUSDT", name: "Nasdaq 100 ETF", market: "美股合约", source: "binance", sourceSymbol: "QQQUSDT" }],
  ["TQQQUSDT", { symbol: "TQQQUSDT", name: "Nasdaq 3x ETF", market: "美股合约", source: "binance", sourceSymbol: "TQQQUSDT" }],
  ["SNXXUSDT", { symbol: "SNXXUSDT", name: "SNXX", market: "币安合约", source: "binance", sourceSymbol: "SNXXUSDT" }],
  ["BTCUSDT", { symbol: "BTCUSDT", name: "Bitcoin", market: "加密资产", source: "binance", sourceSymbol: "BTCUSDT" }],
  ["ETHUSDT", { symbol: "ETHUSDT", name: "Ethereum", market: "加密资产", source: "binance", sourceSymbol: "ETHUSDT" }],
  ["BNBUSDT", { symbol: "BNBUSDT", name: "BNB", market: "加密资产", source: "binance", sourceSymbol: "BNBUSDT" }],
  ["SOLUSDT", { symbol: "SOLUSDT", name: "Solana", market: "加密资产", source: "binance", sourceSymbol: "SOLUSDT" }],
  ["XRPUSDT", { symbol: "XRPUSDT", name: "XRP", market: "加密资产", source: "binance", sourceSymbol: "XRPUSDT" }],
  ["DOGEUSDT", { symbol: "DOGEUSDT", name: "Dogecoin", market: "加密资产", source: "binance", sourceSymbol: "DOGEUSDT" }],
  ["ADAUSDT", { symbol: "ADAUSDT", name: "Cardano", market: "加密资产", source: "binance", sourceSymbol: "ADAUSDT" }],
  ["SUIUSDT", { symbol: "SUIUSDT", name: "Sui", market: "加密资产", source: "binance", sourceSymbol: "SUIUSDT" }],
  ["AVAXUSDT", { symbol: "AVAXUSDT", name: "Avalanche", market: "加密资产", source: "binance", sourceSymbol: "AVAXUSDT" }],
  ["LINKUSDT", { symbol: "LINKUSDT", name: "Chainlink", market: "加密资产", source: "binance", sourceSymbol: "LINKUSDT" }],
  ["TRXUSDT", { symbol: "TRXUSDT", name: "TRON", market: "加密资产", source: "binance", sourceSymbol: "TRXUSDT" }],
  ["LTCUSDT", { symbol: "LTCUSDT", name: "Litecoin", market: "加密资产", source: "binance", sourceSymbol: "LTCUSDT" }],
  ["AAVEUSDT", { symbol: "AAVEUSDT", name: "Aave", market: "加密资产", source: "binance", sourceSymbol: "AAVEUSDT" }],
  ["ARBUSDT", { symbol: "ARBUSDT", name: "Arbitrum", market: "加密资产", source: "binance", sourceSymbol: "ARBUSDT" }],
  ["OPUSDT", { symbol: "OPUSDT", name: "Optimism", market: "加密资产", source: "binance", sourceSymbol: "OPUSDT" }],
  ["WIFUSDT", { symbol: "WIFUSDT", name: "dogwifhat", market: "加密资产", source: "binance", sourceSymbol: "WIFUSDT" }],
  ["BCHUSDT", { symbol: "BCHUSDT", name: "Bitcoin Cash", market: "加密资产", source: "binance", sourceSymbol: "BCHUSDT" }],
  ["ETCUSDT", { symbol: "ETCUSDT", name: "Ethereum Classic", market: "加密资产", source: "binance", sourceSymbol: "ETCUSDT" }],
  ["ATOMUSDT", { symbol: "ATOMUSDT", name: "Cosmos", market: "加密资产", source: "binance", sourceSymbol: "ATOMUSDT" }],
  ["DOTUSDT", { symbol: "DOTUSDT", name: "Polkadot", market: "加密资产", source: "binance", sourceSymbol: "DOTUSDT" }],
  ["CRVUSDT", { symbol: "CRVUSDT", name: "Curve", market: "加密资产", source: "binance", sourceSymbol: "CRVUSDT" }],
  ["RUNEUSDT", { symbol: "RUNEUSDT", name: "THORChain", market: "加密资产", source: "binance", sourceSymbol: "RUNEUSDT" }],
  ["EGLDUSDT", { symbol: "EGLDUSDT", name: "MultiversX", market: "加密资产", source: "binance", sourceSymbol: "EGLDUSDT" }],
  ["UNIUSDT", { symbol: "UNIUSDT", name: "Uniswap", market: "加密资产", source: "binance", sourceSymbol: "UNIUSDT" }],
  ["NEARUSDT", { symbol: "NEARUSDT", name: "NEAR Protocol", market: "加密资产", source: "binance", sourceSymbol: "NEARUSDT" }],
  ["FILUSDT", { symbol: "FILUSDT", name: "Filecoin", market: "加密资产", source: "binance", sourceSymbol: "FILUSDT" }],
  ["IMXUSDT", { symbol: "IMXUSDT", name: "Immutable", market: "加密资产", source: "binance", sourceSymbol: "IMXUSDT" }],
  ["INJUSDT", { symbol: "INJUSDT", name: "Injective", market: "加密资产", source: "binance", sourceSymbol: "INJUSDT" }],
  ["APTUSDT", { symbol: "APTUSDT", name: "Aptos", market: "加密资产", source: "binance", sourceSymbol: "APTUSDT" }],
  ["STXUSDT", { symbol: "STXUSDT", name: "Stacks", market: "加密资产", source: "binance", sourceSymbol: "STXUSDT" }],
  ["SEIUSDT", { symbol: "SEIUSDT", name: "Sei", market: "加密资产", source: "binance", sourceSymbol: "SEIUSDT" }],
  ["TIAUSDT", { symbol: "TIAUSDT", name: "Celestia", market: "加密资产", source: "binance", sourceSymbol: "TIAUSDT" }],
  ["KASUSDT", { symbol: "KASUSDT", name: "Kaspa", market: "加密资产", source: "binance", sourceSymbol: "KASUSDT" }],
  ["JUPUSDT", { symbol: "JUPUSDT", name: "Jupiter", market: "加密资产", source: "binance", sourceSymbol: "JUPUSDT" }],
  ["TAOUSDT", { symbol: "TAOUSDT", name: "Bittensor", market: "加密资产", source: "binance", sourceSymbol: "TAOUSDT" }],
  ["POLUSDT", { symbol: "POLUSDT", name: "Polygon", market: "加密资产", source: "binance", sourceSymbol: "POLUSDT" }],
  ["PENGUUSDT", { symbol: "PENGUUSDT", name: "PENGU", market: "加密资产", source: "binance", sourceSymbol: "PENGUUSDT" }],
  ["BUSDT", { symbol: "BUSDT", name: "B", market: "加密资产", source: "binance", sourceSymbol: "BUSDT" }],
]);

function getTradingViewSymbol(symbol, market = "") {
  const raw = String(symbol || "").trim().toUpperCase();
  if (!raw) return "";
  if (raw.endsWith(".HK")) {
    return `HKEX:${raw.slice(0, -3).replace(/^0+(?=\d)/, "")}`;
  }
  if (["XAUUSD", "XAGUSD"].includes(raw)) return `OANDA:${raw}`;
  if (raw.endsWith("USDT")) return `BINANCE:${raw}.P`;
  return market === "港股" ? `HKEX:${raw.replace(/^0+(?=\d)/, "")}` : raw;
}

function withTradingView(asset) {
  if (!asset) return asset;
  const tradingViewSymbol = getTradingViewSymbol(asset.symbol, asset.market);
  return {
    ...asset,
    tradingViewSymbol,
    chartUrl: tradingViewSymbol
      ? `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tradingViewSymbol)}`
      : "",
  };
}

function resolveReversalAsset(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw) return null;
  const aliases = new Map([
    ["PUMP/USD", "PUMPUSDT"],
    ["PUMP-USD", "PUMPUSDT"],
    ["PUMPFUN-USD", "PUMPUSDT"],
  ]);
  if (aliases.has(raw)) return resolveReversalAsset(aliases.get(raw));
  if (reversalPresets.has(raw)) return withTradingView(reversalPresets.get(raw));
  if (/\.HK$|=|\^|-USD$/.test(raw)) {
    return withTradingView({ symbol: raw, name: raw, market: "自定义行情", source: "yahoo", sourceSymbol: raw });
  }
  return withTradingView({ symbol: raw, name: raw, market: "币安合约", source: "binance", sourceSymbol: raw });
}

async function getTopReversalFutures(limit = REVERSAL_TOP_FUTURES) {
  const tickers = await binance("/fapi/v1/ticker/24hr");
  return tickers
    .filter((ticker) => ticker.symbol?.endsWith("USDT") && !ticker.symbol.includes("_") && Number(ticker.quoteVolume) > 0)
    .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
    .slice(0, limit)
    .map((ticker) => ({
      ...resolveReversalAsset(ticker.symbol),
      tickerPrice: Number(ticker.lastPrice),
      quoteVolume24h: Number(ticker.quoteVolume),
    }));
}

async function getDefaultReversalAssets() {
  const fixedSymbols = ["1810.HK", "0700.HK", "9988.HK", "3690.HK", "9618.HK", "9999.HK", "2318.HK", "0941.HK", "0388.HK", "0005.HK", "XAUUSD", "XAGUSD", "AAPLUSDT", "AMZNUSDT", "TSLAUSDT", "NVDAUSDT", "MSFTUSDT", "METAUSDT", "GOOGLUSDT", "MSTRUSDT", "COINUSDT", "HOODUSDT", "PLTRUSDT", "CRCLUSDT", "AMDUSDT", "AVGOUSDT", "QCOMUSDT", "INTCUSDT", "ORCLUSDT", "NFLXUSDT", "DISUSDT", "WMTUSDT", "COSTUSDT", "LLYUSDT", "CVXUSDT", "BABAUSDT", "SPYUSDT", "QQQUSDT", "TQQQUSDT", "SNXXUSDT"];
  const fixed = fixedSymbols.map(resolveReversalAsset).filter(Boolean);
  try {
    const dynamic = await getTopReversalFutures();
    const dynamicBySymbol = new Map(dynamic.map((asset) => [asset.symbol, asset]));
    const enrichedFixed = fixed.map((asset) => {
      const live = dynamicBySymbol.get(asset.symbol);
      return live ? { ...live, ...asset, tickerPrice: live.tickerPrice, quoteVolume24h: live.quoteVolume24h } : asset;
    });
    const fixedSet = new Set(fixed.map((asset) => asset.symbol));
    return [...enrichedFixed, ...dynamic.filter((asset) => !fixedSet.has(asset.symbol))].slice(0, REVERSAL_MAX_ASSETS);
  } catch {
    return fixed;
  }
}

async function getReversalCandles(asset) {
  if (asset.source === "yahoo") {
    const chart = await yahooChart(asset.sourceSymbol, { range: "1y", interval: "1d" });
    const timestamps = chart.timestamp || [];
    const quote = chart.indicators?.quote?.[0] || {};
    return timestamps.map((timestamp, index) => ({
      timestamp: Number(timestamp) * 1000,
      open: Number(quote.open?.[index]),
      high: Number(quote.high?.[index]),
      low: Number(quote.low?.[index]),
      close: Number(quote.close?.[index]),
      volume: Number(quote.volume?.[index]),
    })).filter(isValidCandle);
  }

  const rows = await binance(`/fapi/v1/klines?symbol=${encodeURIComponent(asset.sourceSymbol)}&interval=1d&limit=365`);
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    timestamp: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
  })).filter(isValidCandle);
}

function isValidCandle(row) {
  return [row.open, row.high, row.low, row.close].every((value) => Number.isFinite(value) && value > 0);
}

function normalizeKline(row) {
  return {
    timestamp: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
  };
}

function aggregateFourHourCandles(rows) {
  const days = new Map();
  for (const row of rows) {
    const day = new Date(row.timestamp).toISOString().slice(0, 10);
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(row);
  }
  return [...days.values()].flatMap((dayRows) => {
    const ordered = dayRows.sort((a, b) => a.timestamp - b.timestamp);
    const result = [];
    for (let index = 0; index < ordered.length; index += 4) {
      const group = ordered.slice(index, index + 4);
      if (!group.length) continue;
      result.push({
        timestamp: group[0].timestamp,
        open: group[0].open,
        high: Math.max(...group.map((row) => row.high)),
        low: Math.min(...group.map((row) => row.low)),
        close: group.at(-1).close,
        volume: group.reduce((sum, row) => sum + Number(row.volume || 0), 0),
      });
    }
    return result;
  });
}

async function getReversalTriggerCandles(asset, mode = "live") {
  if (asset.source === "yahoo") {
    const chart = await yahooChart(asset.sourceSymbol, { range: mode === "stats" ? "1y" : "3mo", interval: "1h" });
    const timestamps = chart.timestamp || [];
    const quote = chart.indicators?.quote?.[0] || {};
    const hourly = timestamps.map((timestamp, index) => ({
      timestamp: Number(timestamp) * 1000,
      open: Number(quote.open?.[index]),
      high: Number(quote.high?.[index]),
      low: Number(quote.low?.[index]),
      close: Number(quote.close?.[index]),
      volume: Number(quote.volume?.[index]),
    })).filter(isValidCandle);
    return aggregateFourHourCandles(hourly);
  }

  if (mode === "live") {
    const rows = await binance(`/fapi/v1/klines?symbol=${encodeURIComponent(asset.sourceSymbol)}&interval=4h&limit=499`);
    return (Array.isArray(rows) ? rows : []).map(normalizeKline).filter(isValidCandle);
  }

  const intervalMs = 4 * 60 * 60 * 1000;
  const earliest = Date.now() - 370 * 24 * 60 * 60 * 1000;
  const pages = [];
  let endTime = Date.now();
  let pageCount = 0;
  while (endTime > earliest && pageCount < 2) {
    const rows = await binance(`/fapi/v1/klines?symbol=${encodeURIComponent(asset.sourceSymbol)}&interval=4h&limit=1500&endTime=${endTime}`);
    if (!Array.isArray(rows) || !rows.length) break;
    pageCount += 1;
    pages.unshift(...rows);
    const oldest = Number(rows[0][0]);
    if (!Number.isFinite(oldest) || oldest <= earliest || rows.length < 1500) break;
    endTime = oldest - intervalMs;
  }
  const unique = [...new Map(pages.map((row) => [Number(row[0]), row])).values()];
  return unique.map(normalizeKline).filter(isValidCandle);
}

async function getCachedReversalCandles(asset, timeframe) {
  if (timeframe === "4h-stats") return getReversalTriggerCandles(asset, "stats");
  const key = `${asset.source}:${asset.sourceSymbol}:${timeframe}`;
  const cached = reversalCandleCache.get(key);
  if (cached && Date.now() - cached.at < REVERSAL_CACHE_MS) return cached.promise;
  const promise = (timeframe === "1d"
    ? getReversalCandles(asset)
    : getReversalTriggerCandles(asset, timeframe === "4h-stats" ? "stats" : "live"))
    .catch((error) => {
      reversalCandleCache.delete(key);
      throw error;
    });
  reversalCandleCache.set(key, { at: Date.now(), promise });
  return promise;
}

function pruneReversalCandleCache() {
  const cutoff = Date.now() - REVERSAL_CACHE_MS;
  for (const [key, cached] of reversalCandleCache) {
    if (cached.at < cutoff) reversalCandleCache.delete(key);
  }
}

function averageRange(candles, index) {
  const rows = candles.slice(Math.max(1, index - 13), index + 1);
  if (!rows.length) return 0;
  return rows.reduce((sum, row) => sum + Math.max(0, row.high - row.low), 0) / rows.length;
}

function isPivot(candles, index, side, radius = 4) {
  const pivot = side === "support" ? candles[index].low : candles[index].high;
  for (let offset = -radius; offset <= radius; offset += 1) {
    if (!offset) continue;
    const value = side === "support" ? candles[index + offset].low : candles[index + offset].high;
    if (side === "support" && value < pivot) return false;
    if (side === "resistance" && value > pivot) return false;
  }
  return true;
}

function touchesZone(candle, zone) {
  const low = Number(zone.zoneLow ?? zone.low);
  const high = Number(zone.zoneHigh ?? zone.high);
  return candle.low <= high && candle.high >= low;
}

function isSafeSide(candle, zone, side) {
  const low = Number(zone.zoneLow ?? zone.low);
  const high = Number(zone.zoneHigh ?? zone.high);
  return side === "support" ? candle.close > high : candle.close < low;
}

function isValidEntry(candle, previous, zone, side) {
  if (!previous || !isSafeSide(previous, zone, side) || !touchesZone(candle, zone)) return false;
  const low = Number(zone.zoneLow ?? zone.low);
  const high = Number(zone.zoneHigh ?? zone.high);
  return side === "support" ? candle.close >= low : candle.close <= high;
}

function hasCleanMaturation(candles, originIndex, zone) {
  const intervening = candles
    .slice(originIndex + 3)
    .filter((candle) => candle.timestamp < zone.eligibleTime);
  return intervening.length > 0 && intervening.every((candle) => !touchesZone(candle, zone));
}

function buildDailyZones(asset, candles) {
  const zones = [];
  for (const side of ["support", "resistance"]) {
    for (let index = 4; index <= candles.length - 5; index += 1) {
      if (!isPivot(candles, index, side)) continue;
      const point = side === "support" ? candles[index].low : candles[index].high;
      const width = Math.max(point * 0.01, averageRange(candles, index) * 0.7);
      const range = side === "support"
        ? { low: point - width * 0.35, high: point + width }
        : { low: point - width, high: point + width * 0.35 };
      const zone = {
        strategyVersion: REVERSAL_STRATEGY_VERSION,
        side,
        type: side === "support" ? "support-touch" : "resistance-touch",
        label: side === "support" ? "支撑区再次触及" : "阻力区再次触及",
        direction: side === "support" ? "potential-rebound" : "potential-pullback",
        zoneLow: range.low,
        zoneHigh: range.high,
        point,
        originTime: candles[index].timestamp,
        confirmedTime: candles[index + 2].timestamp,
        eligibleTime: candles[index].timestamp + REVERSAL_MIN_AGE_MS,
        originIndex: index,
      };
      if (!hasCleanMaturation(candles, index, zone)) continue;
      zones.push(zone);
    }
  }
  return zones;
}

function findZoneEntries(triggerCandles, zone) {
  const entries = [];
  for (let index = 1; index < triggerCandles.length; index += 1) {
    if (triggerCandles[index].timestamp < zone.eligibleTime) continue;
    if (isValidEntry(triggerCandles[index], triggerCandles[index - 1], zone, zone.side)) entries.push(triggerCandles[index]);
  }
  return entries;
}

function zoneDistancePct(price, zone) {
  if (price < zone.zoneLow) return ((zone.zoneLow - price) / price) * 100;
  if (price > zone.zoneHigh) return ((price - zone.zoneHigh) / price) * 100;
  return 0;
}

function needsFourHourScan(dailyCandles, price, now = Date.now()) {
  if (!Number.isFinite(price) || price <= 0) return true;
  const oldHistoryCutoff = now - 84 * 24 * 60 * 60 * 1000;
  return buildDailyZones(null, dailyCandles).some((zone) => {
    if (now < zone.eligibleTime || zoneDistancePct(price, zone) > 3) return false;
    return !dailyCandles.some((candle) =>
      candle.timestamp >= zone.eligibleTime
      && candle.timestamp < oldHistoryCutoff
      && touchesZone(candle, zone));
  });
}

function dedupeReversalSignals(signals) {
  const gapMs = REVERSAL_SIGNAL_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
  const kept = [];
  for (const signal of signals.slice().sort((a, b) => a.touchTime - b.touchTime || a.distancePct - b.distancePct || b.originTime - a.originTime)) {
    if (!kept.some((item) => item.type === signal.type && Math.abs(item.touchTime - signal.touchTime) < gapMs)) kept.push(signal);
  }
  return kept;
}

function buildReversalSignal(asset, dailyCandles, triggerCandles) {
  if (dailyCandles.length < 20 || triggerCandles.length < 2) return { status: "insufficient_data", current: null, signals: [], zones: [] };
  const current = triggerCandles.at(-1);
  const previous = triggerCandles.at(-2);
  const proximityPct = 1.2;
  const candidates = [];

  for (const zone of buildDailyZones(asset, dailyCandles)) {
      if (current.timestamp < zone.eligibleTime) continue;
      const entries = findZoneEntries(triggerCandles.slice(0, -1), zone);
      const triggerHistoryStart = triggerCandles[0]?.timestamp ?? current.timestamp;
      const hasOlderDailyTouch = dailyCandles.some((candle) =>
        candle.timestamp >= zone.eligibleTime
        && candle.timestamp < triggerHistoryStart
        && touchesZone(candle, zone));
      const hasPriorEntry = hasOlderDailyTouch || entries.length > 0;
      const isTouching = isValidEntry(current, previous, zone, zone.side) && !hasPriorEntry;
      const distance = zoneDistancePct(current.close, zone);
      const movingToward = zone.side === "support"
        ? current.close < previous.close
        : current.close > previous.close;
      const approachingFromSafeSide = isSafeSide(current, zone, zone.side);
      const isApproaching = !hasPriorEntry && !isTouching && approachingFromSafeSide && movingToward && Math.abs(distance) <= proximityPct;
      candidates.push({
        ...zone,
        touchTime: current.timestamp,
        triggerTime: current.timestamp,
        triggerPrice: zone.side === "support" ? zone.zoneHigh : zone.zoneLow,
        triggerCandle: { open: current.open, high: current.high, low: current.low, close: current.close },
        ageBars: dailyCandles.filter((candle) => candle.timestamp > zone.originTime && candle.timestamp <= current.timestamp).length,
        ageDays: Math.floor((current.timestamp - zone.originTime) / (24 * 60 * 60 * 1000)),
        distancePct: Math.abs(distance),
        wickSize: zone.side === "support" ? current.low : current.high,
        isTouching,
        isFirstTouch: isTouching,
        isSecondTouch: isTouching,
        isApproaching,
        isFirstApproach: isApproaching,
        isSecondApproach: isApproaching,
        priorTouchCount: hasPriorEntry ? 1 : 0,
        hadPriorTouch: hasPriorEntry,
      });
  }

  const signals = dedupeReversalSignals(candidates
    .filter((candidate) => candidate.isSecondTouch || candidate.isSecondApproach)
    .sort((a, b) => a.distancePct - b.distancePct || a.ageBars - b.ageBars));
  const zones = candidates
    .slice()
    .sort((a, b) => a.distancePct - b.distancePct || a.ageBars - b.ageBars)
    .slice(0, 6);
  return {
    status: signals.length ? (signals.some((signal) => signal.isSecondTouch) ? "revisit" : "approaching") : "waiting",
    current: { price: current.close, time: current.timestamp, timeframe: "4h" },
    signals: signals.slice(0, 2),
    zones,
  };
}

async function loadReversalHistory() {
  if (reversalHistory) return reversalHistory;
  const parsed = await reversalStore.load();
  reversalHistory = Array.isArray(parsed) ? parsed.slice(0, REVERSAL_HISTORY_LIMIT) : [];
  return reversalHistory;
}

function isEligibleReversalRecord(record) {
  const originTime = Number(record?.originTime);
  const triggerTime = Number(record?.triggerTime ?? record?.touchTime);
  if (record?.strategyVersion !== REVERSAL_STRATEGY_VERSION) return false;
  if (!Number.isFinite(originTime) || !Number.isFinite(triggerTime)) return true;
  return triggerTime - originTime >= REVERSAL_MIN_AGE_MS;
}

function reversalHistoryKey(signal) {
  const state = signal.isSecondTouch ? "revisit" : "approaching";
  return [signal.strategyVersion || "legacy", signal.symbol, signal.type, state, signal.originTime, signal.touchTime].join(":");
}

async function recordReversalSignals(signals) {
  const eligibleSignals = signals.filter(isEligibleReversalRecord);
  if (!eligibleSignals.length) return (await loadReversalHistory()).filter(isEligibleReversalRecord);
  const history = await loadReversalHistory();
  const known = new Set(history.map(reversalHistoryKey));
  const additions = eligibleSignals
    .map((signal) => ({
      ...signal,
      recordKey: reversalHistoryKey(signal),
      recordedAt: new Date().toISOString(),
      status: signal.isSecondTouch ? "revisit" : "approaching",
      zones: undefined,
      signals: undefined,
    }))
    .filter((signal) => !known.has(signal.recordKey));
  if (!additions.length) return history.filter(isEligibleReversalRecord);
  history.unshift(...additions);
  reversalHistory = history.slice(0, REVERSAL_HISTORY_LIMIT);
  await reversalStore.save(reversalHistory);
  return reversalHistory.filter(isEligibleReversalRecord);
}

async function handleReversalHistory(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const limit = parseInteger(url.searchParams.get("limit"), 100, 1, 500);
  const history = await loadReversalHistory();
  const records = history.filter(isEligibleReversalRecord).slice(0, limit);
  json(res, 200, { generatedAt: new Date().toISOString(), records });
}

function buildReversalStats(asset, dailyCandles, triggerCandles, horizon, targetPct) {
  const horizonMs = horizon * 24 * 60 * 60 * 1000;
  const candidates = [];
  const dailyZones = buildDailyZones(asset, dailyCandles);
  for (const zone of dailyZones) {
    const entryCandle = findZoneEntries(triggerCandles, zone)[0];
    if (!entryCandle) continue;
    candidates.push({
      ...zone,
      touchTime: entryCandle.timestamp,
      triggerTime: entryCandle.timestamp,
      triggerPrice: zone.side === "support" ? zone.zoneHigh : zone.zoneLow,
      triggerCandle: { open: entryCandle.open, high: entryCandle.high, low: entryCandle.low, close: entryCandle.close },
      distancePct: 0,
    });
  }

  const signals = dedupeReversalSignals(candidates.sort((a, b) => a.touchTime - b.touchTime || a.originTime - b.originTime));
  const samples = [];
  for (const signal of signals) {
      const support = signal.type === "support-touch";
      const entry = signal.triggerPrice;
      const target = support ? entry * (1 + targetPct / 100) : entry * (1 - targetPct / 100);
      const future = triggerCandles.filter((candle) => candle.timestamp > signal.triggerTime && candle.timestamp <= signal.triggerTime + horizonMs);
      if (!future.length) continue;
      let outcome = "timeout";
      let barsToOutcome = future.length;
      let maxFavorablePct = 0;
      let maxAdversePct = 0;
      for (let offset = 0; offset < future.length; offset += 1) {
        const candle = future[offset];
        const favorable = support ? ((candle.high - entry) / entry) * 100 : ((entry - candle.low) / entry) * 100;
        const adverse = support ? ((entry - candle.low) / entry) * 100 : ((candle.high - entry) / entry) * 100;
        maxFavorablePct = Math.max(maxFavorablePct, favorable);
        maxAdversePct = Math.max(maxAdversePct, adverse);
        const hitTarget = support ? candle.high >= target : candle.low <= target;
        const invalidated = support ? candle.low < signal.zoneLow : candle.high > signal.zoneHigh;
        if (hitTarget && invalidated) {
          outcome = "ambiguous";
          barsToOutcome = offset + 1;
          break;
        }
        if (invalidated || hitTarget) {
          outcome = invalidated ? "invalidated" : "successful";
          barsToOutcome = offset + 1;
          break;
        }
      }
      samples.push({
        symbol: asset.symbol,
        tradingViewSymbol: asset.tradingViewSymbol,
        chartUrl: asset.chartUrl,
        market: asset.market,
        type: signal.type,
        status: "revisit",
        originTime: signal.originTime,
        triggerTime: signal.triggerTime,
        signalTime: signal.triggerTime,
        entry,
        originPoint: signal.point,
        zoneLow: signal.zoneLow,
        zoneHigh: signal.zoneHigh,
        triggerOpen: signal.triggerCandle.open,
        triggerHigh: signal.triggerCandle.high,
        triggerLow: signal.triggerCandle.low,
        triggerClose: signal.triggerCandle.close,
        outcome,
        barsToOutcome,
        maxFavorablePct,
        maxAdversePct,
      });
  }
  const dedupedSamples = dedupeReversalSignals(samples.map((row) => ({ ...row, touchTime: row.signalTime, distancePct: 0 })));
  const resolved = dedupedSamples.filter((row) => !["timeout", "ambiguous"].includes(row.outcome));
  const supportRows = resolved.filter((row) => row.type === "support-touch");
  const resistanceRows = resolved.filter((row) => row.type === "resistance-touch");
  const hitRate = (rows) => rows.length ? rows.filter((row) => row.outcome === "successful").length / rows.length : null;
  const avg = (rows, field) => rows.length ? rows.reduce((sum, row) => sum + Number(row[field] || 0), 0) / rows.length : null;
  return {
    generatedAt: new Date().toISOString(), symbol: asset.symbol, market: asset.market, anchorTimeframe: "1D", triggerTimeframe: "4h", horizonDays: horizon, targetPct,
    cooldownDays: REVERSAL_SIGNAL_COOLDOWN_DAYS, samples: dedupedSamples.length, resolved: resolved.length, successful: dedupedSamples.filter((row) => row.outcome === "successful").length, invalidated: dedupedSamples.filter((row) => row.outcome === "invalidated").length, timeout: dedupedSamples.filter((row) => row.outcome === "timeout").length,
    ambiguous: dedupedSamples.filter((row) => row.outcome === "ambiguous").length, indicatorHitRate: hitRate(resolved), supportHitRate: hitRate(supportRows), resistanceHitRate: hitRate(resistanceRows), winRate: hitRate(resolved), averageBarsToOutcome: avg(resolved, "barsToOutcome"), averageMaxFavorablePct: avg(dedupedSamples, "maxFavorablePct"), averageMaxAdversePct: avg(dedupedSamples, "maxAdversePct"), coverage: { dailyCandles: dailyCandles.length, triggerCandles: triggerCandles.length, dailyZones: dailyZones.length, entries: candidates.length }, records: dedupedSamples, recent: dedupedSamples.slice(-20).reverse(),
  };
}

async function handleReversalStats(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const symbols = url.searchParams.get("symbols")?.trim();
  const horizon = parseInteger(url.searchParams.get("horizon"), 10, 3, 30);
  const targetPct = parseNumber(url.searchParams.get("targetPct"), 5, 0.5, 50);
  try {
    const requestedAssets = symbols
      ? symbols.split(",").map(resolveReversalAsset).filter(Boolean).slice(0, REVERSAL_MAX_ASSETS)
      : await getDefaultReversalAssets();
    const assets = [...new Map(requestedAssets.map((asset) => [asset.symbol, asset])).values()];
    const results = await mapLimit(assets, 4, async (asset) => {
      try {
        const [dailyCandles, triggerCandles] = await Promise.all([getCachedReversalCandles(asset, "1d"), getCachedReversalCandles(asset, "4h-stats")]);
        return buildReversalStats(asset, dailyCandles, triggerCandles, horizon, targetPct);
      } catch (error) {
        return { symbol: asset.symbol, market: asset.market, error: error.message, samples: 0, records: [] };
      }
    });
    const valid = results.filter((result) => !result.error);
    const records = valid.flatMap((result) => result.records || []).sort((a, b) => a.signalTime - b.signalTime);
    const resolved = records.filter((row) => !["timeout", "ambiguous"].includes(row.outcome));
    const successful = records.filter((row) => row.outcome === "successful");
    const support = resolved.filter((row) => row.type === "support-touch");
    const resistance = resolved.filter((row) => row.type === "resistance-touch");
    const rate = (rows) => rows.length ? rows.filter((row) => row.outcome === "successful").length / rows.length : null;
    const average = (field) => records.length ? records.reduce((sum, row) => sum + Number(row[field] || 0), 0) / records.length : null;
    return json(res, 200, {
      generatedAt: new Date().toISOString(), symbol: symbols || "DEFAULT_WATCHLIST", assetsRequested: assets.length, assetsWithData: valid.length, assetsFailed: results.filter((result) => result.error).map((result) => ({ symbol: result.symbol, error: result.error })), assetsCoverage: valid.map((result) => ({ symbol: result.symbol, ...result.coverage })), anchorTimeframe: "1D", triggerTimeframe: "4h", horizonDays: horizon, targetPct, cooldownDays: REVERSAL_SIGNAL_COOLDOWN_DAYS,
      samples: records.length, resolved: resolved.length, successful: successful.length, invalidated: records.filter((row) => row.outcome === "invalidated").length, timeout: records.filter((row) => row.outcome === "timeout").length, ambiguous: records.filter((row) => row.outcome === "ambiguous").length, indicatorHitRate: rate(resolved), supportHitRate: rate(support), resistanceHitRate: rate(resistance), averageBarsToOutcome: resolved.length ? resolved.reduce((sum, row) => sum + Number(row.barsToOutcome || 0), 0) / resolved.length : null, averageMaxFavorablePct: average("maxFavorablePct"), averageMaxAdversePct: average("maxAdversePct"), records, recent: records.slice(-20).reverse(),
    });
  } catch (error) {
    return json(res, 502, { error: error.message });
  }
}

async function scanReversalData(requested, selectionMode) {
  pruneReversalCandleCache();
  const key = requested.map((asset) => asset.symbol).join(",");
  const cached = reversalCache.get(key);
  if (cached && Date.now() - cached.at < REVERSAL_CACHE_MS) return cached.data;

  const rows = await mapLimit(requested, 4, async (asset) => {
    try {
      const dailyCandles = await getCachedReversalCandles(asset, "1d");
      if (asset.source === "binance" && Number.isFinite(asset.tickerPrice) && !needsFourHourScan(dailyCandles, asset.tickerPrice)) {
        return {
          ...asset,
          status: "waiting",
          current: { price: asset.tickerPrice, time: Date.now(), timeframe: "ticker" },
          signals: [],
          zones: [],
          fourHourScanned: false,
          error: null,
        };
      }
      const triggerCandles = await getCachedReversalCandles(asset, "4h-live");
      const result = buildReversalSignal(asset, dailyCandles, triggerCandles);
      return { ...asset, ...result, fourHourScanned: true, error: null };
    } catch (error) {
      return { ...asset, status: "error", current: null, signals: [], zones: [], error: error.message };
    }
  });
  const data = {
    generatedAt: new Date().toISOString(),
    anchorTimeframe: "1D",
    triggerTimeframe: "4h",
    selectionMode,
    minimumAgeDays: REVERSAL_MIN_AGE_DAYS,
    fourHourCandidates: rows.filter((row) => row.fourHourScanned).length,
    proximityPct: 1.2,
    minimumAgeText: `日线区域至少形成 ${REVERSAL_MIN_AGE_DAYS} 天`,
    rows,
    signals: rows.flatMap((row) => row.signals.map((signal) => ({ ...signal, ...row }))),
  };
  try {
    const history = await recordReversalSignals(data.signals);
    data.historyCount = history.length;
  } catch (error) {
    data.historyCount = (await loadReversalHistory()).length;
    data.historyError = error.message;
  }
  reversalCache.set(key, { at: Date.now(), data });
  return data;
}

async function handleReversalScan(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const symbols = url.searchParams.get("symbols")?.trim();
  try {
    const requested = symbols
      ? symbols.split(",").map(resolveReversalAsset).filter(Boolean).slice(0, REVERSAL_MAX_ASSETS)
      : await getDefaultReversalAssets();
    const data = await scanReversalData(requested, symbols ? "manual" : "24h-quote-volume");
    json(res, 200, data);
  } catch (error) {
    json(res, 502, { error: error.message });
  }
}

async function getVix() {
  if (vixCache.data && Date.now() - vixCache.at < MACRO_CACHE_MS) return vixCache.data;
  const chart = await yahooChart("^VIX", { range: "5d", interval: "1d" });
  const meta = chart.meta || {};
  const closes = (chart.indicators?.quote?.[0]?.close || []).filter((value) => Number.isFinite(Number(value)));
  const value = Number(meta.regularMarketPrice ?? closes.at(-1));
  const metaPreviousClose = Number(meta.previousClose);
  const previousClose = metaPreviousClose > 0 ? metaPreviousClose : Number(closes.at(-2));
  if (!Number.isFinite(value)) throw new Error("VIX value unavailable");
  const change = Number.isFinite(previousClose) ? value - previousClose : null;
  const changePct = Number.isFinite(previousClose) && previousClose !== 0 ? (change / previousClose) * 100 : null;
  const data = {
    symbol: "VIX",
    name: "CBOE Volatility Index",
    value,
    previousClose: Number.isFinite(previousClose) ? previousClose : null,
    change,
    changePct,
    dayHigh: Number.isFinite(Number(meta.regularMarketDayHigh)) ? Number(meta.regularMarketDayHigh) : null,
    dayLow: Number.isFinite(Number(meta.regularMarketDayLow)) ? Number(meta.regularMarketDayLow) : null,
    yearHigh: Number.isFinite(Number(meta.fiftyTwoWeekHigh)) ? Number(meta.fiftyTwoWeekHigh) : null,
    yearLow: Number.isFinite(Number(meta.fiftyTwoWeekLow)) ? Number(meta.fiftyTwoWeekLow) : null,
    asOf: meta.regularMarketTime ? new Date(Number(meta.regularMarketTime) * 1000).toISOString() : new Date().toISOString(),
    fetchedAt: new Date().toISOString(),
    source: "Yahoo Finance",
  };
  vixCache = { at: Date.now(), data };
  return data;
}

async function getDxy() {
  if (dxyCache.data && Date.now() - dxyCache.at < MACRO_CACHE_MS) return dxyCache.data;
  const chart = await yahooChart("DX-Y.NYB", { range: "5d", interval: "1d" });
  const meta = chart.meta || {};
  const closes = (chart.indicators?.quote?.[0]?.close || []).filter((value) => Number.isFinite(Number(value)));
  const value = Number(meta.regularMarketPrice ?? closes.at(-1));
  const metaPreviousClose = Number(meta.previousClose);
  const previousClose = metaPreviousClose > 0 ? metaPreviousClose : Number(closes.at(-2));
  if (!Number.isFinite(value)) throw new Error("DXY value unavailable");
  const change = Number.isFinite(previousClose) ? value - previousClose : null;
  const changePct = Number.isFinite(previousClose) && previousClose !== 0 ? (change / previousClose) * 100 : null;
  const data = {
    symbol: "DXY",
    name: "U.S. Dollar Index",
    value,
    previousClose: Number.isFinite(previousClose) ? previousClose : null,
    change,
    changePct,
    dayHigh: Number.isFinite(Number(meta.regularMarketDayHigh)) ? Number(meta.regularMarketDayHigh) : null,
    dayLow: Number.isFinite(Number(meta.regularMarketDayLow)) ? Number(meta.regularMarketDayLow) : null,
    yearHigh: Number.isFinite(Number(meta.fiftyTwoWeekHigh)) ? Number(meta.fiftyTwoWeekHigh) : null,
    yearLow: Number.isFinite(Number(meta.fiftyTwoWeekLow)) ? Number(meta.fiftyTwoWeekLow) : null,
    asOf: meta.regularMarketTime ? new Date(Number(meta.regularMarketTime) * 1000).toISOString() : new Date().toISOString(),
    fetchedAt: new Date().toISOString(),
    source: "Yahoo Finance",
  };
  dxyCache = { at: Date.now(), data };
  return data;
}

function unavailableMacro(definition, status = "unavailable") {
  return { ...definition, status, value: null, previousClose: null, change: null, changePct: null, asOf: null };
}

function parseCsvLine(line) {
  return line.match(/(?:[^,\"]|\"[^\"]*\")+/g)?.map((value) => value.trim().replace(/^\"|\"$/g, "")) || [];
}

async function getTreasuryCurve() {
  if (treasuryCurveCache.data && Date.now() - treasuryCurveCache.at < MACRO_CACHE_MS) return treasuryCurveCache.data;
  const year = new Date().getUTCFullYear();
  const url = `${TREASURY_CURVE_CSV}/${year}/all?field_tdr_date_value=${year}&type=daily_treasury_yield_curve&page&_format=csv`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Treasury ${response.status}`);
  const text = await response.text();
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) throw new Error("Treasury curve empty");
  const headers = parseCsvLine(lines[0]).map((header) => header.toLowerCase());
  const rows = lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  }).filter((row) => row.date);
  const latest = rows.at(-1);
  const previous = rows.at(-2) || null;
  if (!latest) throw new Error("Treasury curve has no dated rows");
  const data = { latest, previous, date: latest.date };
  treasuryCurveCache = { at: Date.now(), data };
  return data;
}

async function getTreasuryMacro(definition) {
  try {
    const curve = await getTreasuryCurve();
    const read = (row, field) => {
      const value = Number(row?.[field.toLowerCase()]);
      return Number.isFinite(value) ? value : null;
    };
    const calculate = (row) => definition.treasurySpread
      ? read(row, definition.treasurySpread[0]) - read(row, definition.treasurySpread[1])
      : read(row, definition.treasuryField);
    const value = calculate(curve.latest);
    const previousClose = curve.previous ? calculate(curve.previous) : null;
    if (!Number.isFinite(value)) return unavailableMacro(definition);
    return { ...definition, status: "live", value, previousClose, change: Number.isFinite(previousClose) ? value - previousClose : null, changePct: null, asOf: curve.date };
  } catch (error) {
    console.warn(`Treasury curve: ${error.message}`);
    return unavailableMacro(definition);
  }
}

async function getFredMacro(definition) {
  if (!process.env.FRED_API_KEY) return unavailableMacro(definition);
  const url = new URL(FRED_API);
  url.search = new URLSearchParams({
    series_id: definition.fredSeries,
    api_key: process.env.FRED_API_KEY,
    file_type: "json",
    sort_order: "desc",
    limit: "2",
  });
  try {
    const response = await fetchWithTimeout(url);
    if (!response.ok) throw new Error(`FRED ${response.status}`);
    const payload = await response.json();
    const observations = (payload.observations || [])
      .filter((item) => item.value !== "." && Number.isFinite(Number(item.value)))
      .slice(0, 2);
    if (!observations.length) return unavailableMacro(definition);
    const value = Number(observations[0].value);
    const previousClose = observations[1] ? Number(observations[1].value) : null;
    const change = Number.isFinite(previousClose) ? value - previousClose : null;
    return { ...definition, status: "live", value, previousClose, change, changePct: null, asOf: observations[0].date };
  } catch (error) {
    console.warn(`${definition.fredSeries}: ${error.message}`);
    return unavailableMacro(definition);
  }
}

async function getFedWatchMacros() {
  const definitions = macroDefinitions.filter((item) => item.fedField);
  if (!process.env.CME_FEDWATCH_OAUTH_TOKEN) return definitions.map((definition) => unavailableMacro(definition));
  try {
    const response = await fetchWithTimeout(`${CME_FEDWATCH_API.replace(/\/$/, "")}/forecasts`, {
      headers: {
        Authorization: `Bearer ${process.env.CME_FEDWATCH_OAUTH_TOKEN}`,
        Accept: "application/json",
        "CME-Application-Name": "binance-dashboard",
        "CME-Application-Vendor": "local",
        "CME-Application-Version": "1.0.0",
        "CME-Request-ID": `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        "User-Agent": "binance-dashboard/1.0",
      },
    });
    if (!response.ok) throw new Error(`CME ${response.status}`);
    const payload = await response.json();
    const meeting = payload.payload?.[0];
    if (!meeting) return definitions.map((definition) => unavailableMacro(definition));
    const ranges = (meeting.rateRange || []).filter((range) => Number.isFinite(Number(range.probability)));
    const topRange = ranges.slice().sort((a, b) => Number(b.probability) - Number(a.probability))[0];
    const probabilityText = ranges.length
      ? ranges.map((range) => `${Number(range.lowerRt) / 100}-${Number(range.upperRt) / 100}%: ${(Number(range.probability) * 100).toFixed(1)}%`).join(" / ")
      : null;
    return definitions.map((definition) => {
      if (definition.fedField === "meeting") return { ...definition, status: meeting.meetingDt ? "live" : "unavailable", value: meeting.meetingDt || null, change: null, changePct: null, asOf: meeting.reportingDt || null };
      if (definition.fedField === "range") return { ...definition, status: topRange ? "live" : "unavailable", value: topRange ? `${Number(topRange.lowerRt) / 100}-${Number(topRange.upperRt) / 100}%` : null, change: null, changePct: null, asOf: meeting.reportingDt || null };
      return { ...definition, status: probabilityText ? "live" : "unavailable", value: probabilityText, change: null, changePct: null, asOf: meeting.reportingDt || null };
    });
  } catch (error) {
    console.warn(`FedWatch: ${error.message}`);
    return definitions.map((definition) => unavailableMacro(definition));
  }
}

const macroDefinitions = [
  { id: "6m", label: "6M 美国国债收益率", purpose: "观察短期资金成本和降息预期", source: "美国财政部 Daily Treasury", treasuryField: "6 Mo", fredSeries: "DGS6MO", unit: "percent", frequency: "每日" },
  { id: "1y", label: "1Y 美国国债收益率", purpose: "观察未来一年政策利率预期", source: "美国财政部 Daily Treasury", treasuryField: "1 Yr", fredSeries: "DGS1", unit: "percent", frequency: "每日" },
  { id: "2y", label: "2Y 美国国债收益率", purpose: "观察短期利率与经济预期", source: "美国财政部 Daily Treasury", treasuryField: "2 Yr", fredSeries: "DGS2", unit: "percent", frequency: "每日" },
  { id: "5y", label: "5Y 美国国债收益率", purpose: "观察中期利率变化", source: "美国财政部 Daily Treasury", treasuryField: "5 Yr", fredSeries: "DGS5", unit: "percent", frequency: "每日" },
  { id: "10y", label: "10Y 美国国债收益率", purpose: "观察市场核心无风险利率", source: "美国财政部 Daily Treasury", treasuryField: "10 Yr", fredSeries: "DGS10", unit: "percent", frequency: "每日" },
  { id: "30y", label: "30Y 美国国债收益率", purpose: "观察长期通胀与财政预期", source: "美国财政部 Daily Treasury", treasuryField: "30 Yr", fredSeries: "DGS30", unit: "percent", frequency: "每日" },
  { id: "2s10s", label: "2s10s 曲线利差", purpose: "观察短长端利率曲线是否倒挂或变陡", source: "美国财政部 Daily Treasury", treasurySpread: ["10 Yr", "2 Yr"], unit: "percent", frequency: "每日" },
  { id: "5s30s", label: "5s30s 曲线利差", purpose: "观察中长期期限溢价和财政压力", source: "美国财政部 Daily Treasury", treasurySpread: ["30 Yr", "5 Yr"], unit: "percent", frequency: "每日" },
  { id: "gold", label: "黄金", purpose: "避险、通胀和美元压力参考", source: "Yahoo Finance GC=F", yahoo: "GC=F", frequency: "5 分钟" },
  { id: "silver", label: "白银", purpose: "贵金属需求和工业需求参考", source: "Yahoo Finance SI=F", yahoo: "SI=F", frequency: "5 分钟" },
  { id: "wti", label: "WTI 原油", purpose: "美国原油价格和通胀压力参考", source: "Yahoo Finance CL=F", yahoo: "CL=F", frequency: "5 分钟" },
  { id: "brent", label: "Brent 原油", purpose: "全球原油价格参考", source: "Yahoo Finance BZ=F", yahoo: "BZ=F", frequency: "5 分钟" },
  { id: "dxy", label: "DXY 美元指数", purpose: "判断美元整体强弱", source: "Yahoo Finance DX-Y.NYB", yahoo: "DX-Y.NYB", frequency: "5 分钟" },
  { id: "usdcny", label: "USD/CNY", purpose: "美元兑人民币汇率", source: "Yahoo Finance CNY=X", yahoo: "CNY=X", frequency: "5 分钟" },
  { id: "cnyusd", label: "CNY/USD", purpose: "人民币兑美元汇率，由 USD/CNY 反算", source: "由 USD/CNY 反算", derivedFrom: "usdcny", inverse: true, frequency: "5 分钟" },
  { id: "eurusd", label: "EUR/USD", purpose: "欧元兑美元，观察美元和欧洲市场变化", source: "Yahoo Finance EURUSD=X", yahoo: "EURUSD=X", frequency: "5 分钟" },
  { id: "usdjpy", label: "USD/JPY", purpose: "美元兑日元，观察避险和套息交易", source: "Yahoo Finance JPY=X", yahoo: "JPY=X", frequency: "5 分钟" },
  { id: "real10y", label: "10Y REAL", purpose: "10 年实际利率，衡量扣除通胀预期后的资金成本", source: "FRED DFII10", fredSeries: "DFII10", unit: "percent", frequency: "每日" },
  { id: "be5y", label: "5Y BE", purpose: "未来 5 年的市场通胀预期", source: "FRED T5YIE", fredSeries: "T5YIE", unit: "percent", frequency: "每日" },
  { id: "be10y", label: "10Y BE", purpose: "未来 10 年的市场通胀预期", source: "FRED T10YIE", fredSeries: "T10YIE", unit: "percent", frequency: "每日" },
  { id: "fedMeeting", label: "Fed Futures 会议日期", purpose: "下一次美联储会议时间", source: "CME FedWatch API", fedField: "meeting", frequency: "工作日更新" },
  { id: "fedRange", label: "Fed Futures 目标利率区间", purpose: "市场对会议后利率区间的预期", source: "CME FedWatch API", fedField: "range", frequency: "工作日更新" },
  { id: "fedProbability", label: "Fed Futures 概率分布", purpose: "不同利率区间的市场定价概率", source: "CME FedWatch API", fedField: "probability", frequency: "工作日更新" },
  { id: "fedFunds", label: "Fed Funds Future 价格及隐含利率", purpose: "观察利率期货正在定价的平均利率", source: "Yahoo Finance / Investing", frequency: "1 小时" },
  { id: "vix", label: "VIX", purpose: "标普 500 短期期权波动率，常用恐慌指标", source: "Yahoo Finance ^VIX", yahoo: "^VIX", frequency: "5 分钟" },
  { id: "vvix", label: "VVIX", purpose: "VIX 自身的波动率，观察恐慌是否加剧", source: "Yahoo Finance ^VVIX", yahoo: "^VVIX", frequency: "5 分钟" },
  { id: "vix3m", label: "VIX3M", purpose: "三个月波动率，用于比较中期风险", source: "Yahoo Finance ^VIX3M", yahoo: "^VIX3M", frequency: "5 分钟" },
  { id: "es", label: "ES 标普期货", purpose: "观察标普 500 盘前和盘后方向", source: "Yahoo Finance ES=F", yahoo: "ES=F", frequency: "5 分钟" },
  { id: "nq", label: "NQ 纳指期货", purpose: "观察科技股和纳指方向", source: "Yahoo Finance NQ=F", yahoo: "NQ=F", frequency: "5 分钟" },
  { id: "rty", label: "RTY 罗素期货", purpose: "观察美国小盘股表现", source: "Yahoo Finance RTY=F", yahoo: "RTY=F", frequency: "5 分钟" },
];

let macroOverviewCache = { at: 0, data: null };

async function getMacroOverview() {
  if (macroOverviewCache.data && Date.now() - macroOverviewCache.at < MACRO_CACHE_MS) return macroOverviewCache.data;
  const rows = await mapLimit(macroDefinitions, 6, async (definition) => {
    if (definition.treasuryField || definition.treasurySpread) return getTreasuryMacro(definition);
    if (definition.fredSeries) return getFredMacro(definition);
    if (definition.fedField || definition.derivedFrom) return unavailableMacro(definition);
    if (!definition.yahoo) return unavailableMacro(definition);
    try {
      const chart = await yahooChart(definition.yahoo, { range: "5d", interval: "1d" });
      const meta = chart.meta || {};
      const closes = (chart.indicators?.quote?.[0]?.close || []).filter((value) => Number.isFinite(Number(value)) && Number(value) > 0);
      const scale = definition.scale || 1;
      const value = Number(meta.regularMarketPrice ?? closes.at(-1)) * scale;
      const metaPreviousClose = Number(meta.previousClose);
      const previousClose = (metaPreviousClose > 0 ? metaPreviousClose : Number(closes.at(-2))) * scale;
      const change = Number.isFinite(previousClose) ? value - previousClose : null;
      return {
        ...definition,
        status: Number.isFinite(value) ? "live" : "unavailable",
        value: Number.isFinite(value) ? value : null,
        previousClose: Number.isFinite(previousClose) ? previousClose : null,
        change,
        changePct: Number.isFinite(previousClose) && previousClose !== 0 ? (change / previousClose) * 100 : null,
        asOf: meta.regularMarketTime ? new Date(Number(meta.regularMarketTime) * 1000).toISOString() : null,
      };
    } catch {
      return { ...definition, status: "unavailable", value: null, change: null, changePct: null };
    }
  });
  const sourceRows = new Map(rows.map((row) => [row.id, row]));
  const derivedRows = rows.map((row) => {
    if (!row.derivedFrom || !row.inverse) return row;
    const source = sourceRows.get(row.derivedFrom);
    const sourceValue = Number(source?.value);
    const sourcePrevious = Number(source?.previousClose);
    if (source?.status !== "live" || !Number.isFinite(sourceValue) || sourceValue === 0) return unavailableMacro(row);
    const value = 1 / sourceValue;
    const previousClose = Number.isFinite(sourcePrevious) && sourcePrevious !== 0 ? 1 / sourcePrevious : null;
    return { ...row, status: "live", value, previousClose, change: previousClose === null ? null : value - previousClose, changePct: previousClose === null ? null : ((value - previousClose) / previousClose) * 100, asOf: source.asOf || null };
  });
  const fedRows = await getFedWatchMacros();
  const fedByField = new Map(fedRows.map((row) => [row.fedField, row]));
  const data = {
    generatedAt: new Date().toISOString(),
    rows: derivedRows.map((row) => row.fedField ? fedByField.get(row.fedField) || row : row),
  };
  macroOverviewCache = { at: Date.now(), data };
  return data;
}

async function rpc(method, params) {
  const response = await fetchWithTimeout(BSC_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`BSC RPC ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message || "BSC RPC error");
  return payload.result;
}

async function contractCall(address, iface, fragment, args = []) {
  const data = iface.encodeFunctionData(fragment, args);
  const result = await rpc("eth_call", [{ to: address, data }, "latest"]);
  return iface.decodeFunctionResult(fragment, result);
}

function normalizeBaseAsset(baseAsset) {
  return baseAsset
    .replace(/^1000000/, "")
    .replace(/^1000/, "")
    .replace(/^1M/, "")
    .toUpperCase();
}

async function getBscContracts() {
  if (Date.now() - bscContractCache.at < 24 * 60 * 60_000 && bscContractCache.data.size) {
    return bscContractCache.data;
  }

  const rows = await coingecko("/coins/list?include_platform=true");
  const contracts = new Map();
  for (const coin of rows) {
    const symbol = String(coin.symbol || "").toUpperCase();
    const address = coin.platforms?.["binance-smart-chain"];
    if (!symbol || !address) continue;
    if (!contracts.has(symbol)) contracts.set(symbol, []);
    contracts.get(symbol).push({
      address,
      coinId: coin.id,
      coinName: coin.name,
    });
  }
  bscContractCache = { at: Date.now(), data: contracts };
  return contracts;
}

function liquidityBand(liquidityUsd, marketCap) {
  const liq = Number(liquidityUsd);
  const cap = Number(marketCap);
  if (!Number.isFinite(liq) || liq <= 0) return "无池子";

  if (Number.isFinite(cap) && cap > 0) {
    const ratio = liq / cap;
    if (ratio >= 0.02) return "深流动性";
    if (ratio >= 0.005) return "中等流动性";
    if (ratio >= 0.001) return "偏薄流动性";
    return "很薄";
  }

  if (liq >= 5_000_000) return "深流动性";
  if (liq >= 1_000_000) return "中等流动性";
  if (liq >= 250_000) return "偏薄流动性";
  return "很薄";
}

async function getBscPool(symbolInfo, marketCap) {
  const base = normalizeBaseAsset(symbolInfo.baseAsset);
  const contracts = await getBscContracts().catch(() => new Map());
  const candidates = contracts.get(base) || [];
  if (!candidates.length) {
    return {
      hasBscPool: false,
      bscLiquidityBand: "无BSC合约",
    };
  }

  const cacheKey = candidates.map((c) => c.address).join(",");
  const cached = bscPoolCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 5 * 60_000) {
    return cached.data;
  }

  let best = null;
  for (const candidate of candidates.slice(0, 3)) {
    try {
      const pairs = await dexscreener(`/token-pairs/v1/bsc/${candidate.address}`);
      const bscPairs = Array.isArray(pairs) ? pairs.filter((p) => p.chainId === "bsc") : [];
      for (const pair of bscPairs) {
        const liquidityUsd = Number(pair.liquidity?.usd);
        if (!Number.isFinite(liquidityUsd)) continue;
        if (!best || liquidityUsd > Number(best.liquidity?.usd || 0)) {
          best = { ...pair, candidate };
        }
      }
    } catch {
      // Keep scanning other candidates when one token address fails.
    }
  }

  const data = best
    ? {
        hasBscPool: true,
        bscTokenAddress: best.candidate.address,
        bscPairAddress: best.pairAddress,
        bscDex: best.dexId,
        bscPairUrl: best.url,
        bscLiquidityUsd: Number(best.liquidity?.usd) || null,
        bscVolume24h: Number(best.volume?.h24) || null,
        bscPriceUsd: Number(best.priceUsd) || null,
        bscLiquidityToMcap:
          Number.isFinite(Number(marketCap)) && Number(marketCap) > 0
            ? (Number(best.liquidity?.usd) || 0) / Number(marketCap)
            : null,
        bscLiquidityBand: liquidityBand(best.liquidity?.usd, marketCap),
      }
    : {
        hasBscPool: false,
        bscTokenAddress: candidates[0].address,
        bscLiquidityBand: "无活跃池",
      };

  bscPoolCache.set(cacheKey, { at: Date.now(), data });
  return data;
}

async function getBscPancakeV3Pool(symbolInfo) {
  const base = normalizeBaseAsset(symbolInfo.baseAsset);
  const contracts = await getBscContracts().catch(() => new Map());
  const candidates = contracts.get(base) || [];
  if (!candidates.length) return null;

  const cacheKey = `pcs-v3:${candidates.map((c) => c.address).join(",")}`;
  const cached = pancakeV3PoolCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.data;

  let best = null;
  for (const candidate of candidates.slice(0, 4)) {
    try {
      const pairs = await dexscreener(`/token-pairs/v1/bsc/${candidate.address}`);
      const pcsPairs = Array.isArray(pairs)
        ? pairs.filter((p) => {
            const dex = String(p.dexId || "").toLowerCase();
            const labels = (p.labels || []).map((x) => String(x).toLowerCase());
            return p.chainId === "bsc" && dex.includes("pancake") && (dex.includes("v3") || labels.includes("v3"));
          })
        : [];
      for (const pair of pcsPairs) {
        const liquidityUsd = Number(pair.liquidity?.usd);
        if (!Number.isFinite(liquidityUsd)) continue;
        if (!best || liquidityUsd > Number(best.liquidity?.usd || 0)) {
          best = { ...pair, candidate };
        }
      }
    } catch {
      // Try the next CoinGecko contract candidate.
    }
  }

  const data = best
    ? {
        tokenAddress: best.candidate.address,
        pairAddress: best.pairAddress,
        dexId: best.dexId,
        url: best.url,
        liquidityUsd: Number(best.liquidity?.usd) || null,
        baseSymbol: best.baseToken?.symbol,
        quoteSymbol: best.quoteToken?.symbol,
      }
    : null;
  pancakeV3PoolCache.set(cacheKey, { at: Date.now(), data });
  return data;
}

async function getBscPancakeV3PoolByAddress(address) {
  const normalized = String(address || "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(normalized)) return null;
  const cacheKey = `pcs-v3-address:${normalized}`;
  const cached = pancakeV3PoolCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.data;

  const pairs = await dexscreener(`/token-pairs/v1/bsc/${normalized}`);
  const candidates = Array.isArray(pairs)
    ? pairs.filter((pair) => {
        const dex = String(pair.dexId || "").toLowerCase();
        const labels = (pair.labels || []).map((item) => String(item).toLowerCase());
        return pair.chainId === "bsc" && dex.includes("pancake") && (dex.includes("v3") || labels.includes("v3"));
      })
    : [];
  const best = candidates
    .filter((pair) => Number.isFinite(Number(pair.liquidity?.usd)))
    .sort((a, b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0))[0];
  const data = best
    ? { tokenAddress: normalized, pairAddress: best.pairAddress, dexId: best.dexId, url: best.url, liquidityUsd: Number(best.liquidity?.usd) || null, baseSymbol: best.baseToken?.symbol, quoteSymbol: best.quoteToken?.symbol }
    : null;
  pancakeV3PoolCache.set(cacheKey, { at: Date.now(), data });
  return data;
}

function tickToPrice(tick, decimals0, decimals1) {
  return Math.pow(1.0001, tick) * Math.pow(10, decimals0 - decimals1);
}

function alignTick(tick, spacing) {
  return Math.floor(tick / spacing) * spacing;
}

function wordPosition(compressedTick) {
  return Math.floor(compressedTick / 256);
}

async function buildPancakeLiquidityRange(symbol) {
  const cached = pancakeRangeCache.get(symbol);
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.data;

  const isAddress = /^0x[a-f0-9]{40}$/i.test(symbol);
  const symbols = isAddress ? [] : await getUsdtPerpetualSymbols();
  const symbolInfo = symbols.find((s) => s.symbol === symbol);
  if (!isAddress && !symbolInfo) throw new Error("Unknown Binance futures symbol or BSC token address");

  const poolInfo = isAddress ? await getBscPancakeV3PoolByAddress(symbol) : await getBscPancakeV3Pool(symbolInfo);
  if (!poolInfo?.pairAddress) {
    return { symbol, hasPancakeV3Pool: false, message: "未找到 PancakeSwap V3 BSC 池子" };
  }

  const pool = poolInfo.pairAddress;
  const [slot0, liquidityResult, spacingResult, token0Result, token1Result] = await Promise.all([
    contractCall(pool, POOL_IFACE, "slot0"),
    contractCall(pool, POOL_IFACE, "liquidity"),
    contractCall(pool, POOL_IFACE, "tickSpacing"),
    contractCall(pool, POOL_IFACE, "token0"),
    contractCall(pool, POOL_IFACE, "token1"),
  ]);

  const currentTick = Number(slot0.tick);
  const currentLiquidity = BigInt(liquidityResult[0].toString());
  const tickSpacing = Number(spacingResult[0]);
  const token0 = token0Result[0];
  const token1 = token1Result[0];

  const [symbol0Result, symbol1Result, decimals0Result, decimals1Result] = await Promise.all([
    contractCall(token0, ERC20_IFACE, "symbol").catch(() => ["TOKEN0"]),
    contractCall(token1, ERC20_IFACE, "symbol").catch(() => ["TOKEN1"]),
    contractCall(token0, ERC20_IFACE, "decimals").catch(() => [18]),
    contractCall(token1, ERC20_IFACE, "decimals").catch(() => [18]),
  ]);
  const symbol0 = symbol0Result[0];
  const symbol1 = symbol1Result[0];
  const decimals0 = Number(decimals0Result[0]);
  const decimals1 = Number(decimals1Result[0]);

  const compressed = Math.floor(currentTick / tickSpacing);
  const currentWord = wordPosition(compressed);
  const wordRadius = 8;
  const initializedTicks = [];
  for (let word = currentWord - wordRadius; word <= currentWord + wordRadius; word += 1) {
    const bitmapResult = await contractCall(pool, POOL_IFACE, "tickBitmap", [word]);
    const bitmap = BigInt(bitmapResult[0].toString());
    if (bitmap === 0n) continue;
    for (let bit = 0; bit < 256; bit += 1) {
      if (((bitmap >> BigInt(bit)) & 1n) === 1n) {
        initializedTicks.push((word * 256 + bit) * tickSpacing);
      }
    }
  }

  const tickRows = [];
  for (const tick of initializedTicks) {
    const result = await contractCall(pool, POOL_IFACE, "ticks", [tick]);
    tickRows.push({
      tick,
      liquidityNet: BigInt(result.liquidityNet.toString()),
    });
  }
  tickRows.sort((a, b) => a.tick - b.tick);

  const baseAddress = poolInfo.tokenAddress.toLowerCase();
  const baseIsToken0 = token0.toLowerCase() === baseAddress;
  const baseSymbol = baseIsToken0 ? symbol0 : symbol1;
  const quoteSymbol = baseIsToken0 ? symbol1 : symbol0;
  const baseDecimals = baseIsToken0 ? decimals0 : decimals1;
  const totalSupplyResult = await contractCall(poolInfo.tokenAddress, ERC20_IFACE, "totalSupply").catch(() => [null]);
  const totalSupplyRaw = totalSupplyResult[0] === null ? null : BigInt(totalSupplyResult[0].toString());
  const totalSupply = totalSupplyRaw === null ? null : Number(totalSupplyRaw) / 10 ** baseDecimals;

  const binSize = tickSpacing * 24;
  const halfBins = 24;
  const startTick = alignTick(currentTick - binSize * halfBins, tickSpacing);
  const bins = [];

  function activeLiquidityAt(targetTick) {
    let active = currentLiquidity;
    if (targetTick >= currentTick) {
      for (const row of tickRows) {
        if (row.tick > currentTick && row.tick <= targetTick) active += row.liquidityNet;
      }
    } else {
      for (let i = tickRows.length - 1; i >= 0; i -= 1) {
        const row = tickRows[i];
        if (row.tick <= currentTick && row.tick > targetTick) active -= row.liquidityNet;
      }
    }
    return active > 0n ? active : 0n;
  }

  for (let i = 0; i < halfBins * 2 + 1; i += 1) {
    const lowerTick = startTick + i * binSize;
    const upperTick = lowerTick + binSize;
    const midTick = Math.floor((lowerTick + upperTick) / 2);
    const rawLiquidity = activeLiquidityAt(midTick);
    const price0 = tickToPrice(midTick, decimals0, decimals1);
    const orientedPrice = baseIsToken0 ? price0 : 1 / price0;
    bins.push({
      tick: midTick,
      price: orientedPrice,
      liquidity: Number(rawLiquidity / 1_000_000_000_000n),
      active: lowerTick <= currentTick && currentTick < upperTick,
    });
  }

  const currentPrice0 = tickToPrice(currentTick, decimals0, decimals1);
  const currentPrice = baseIsToken0 ? currentPrice0 : 1 / currentPrice0;
  const stableQuotes = new Set(["USDT", "USDC", "BUSD", "DAI", "FDUSD"]);
  const data = {
    symbol: isAddress ? `${baseSymbol}/${quoteSymbol}` : symbol,
    query: symbol,
    tokenAddress: poolInfo.tokenAddress,
    hasPancakeV3Pool: true,
    pool,
    poolUrl: poolInfo.url,
    dexId: poolInfo.dexId,
    currentTick,
    tickSpacing,
    baseSymbol,
    quoteSymbol,
    currentPrice,
    totalSupply,
    marketCapUsd: stableQuotes.has(String(quoteSymbol).toUpperCase()) && Number.isFinite(totalSupply) ? totalSupply * currentPrice : null,
    liquidityUsd: poolInfo.liquidityUsd,
    bins: bins.sort((a, b) => a.price - b.price),
  };
  pancakeRangeCache.set(symbol, { at: Date.now(), data });
  return data;
}

async function getOnchainSpotPrice(address) {
  const cacheKey = String(address).toLowerCase();
  const cached = onchainSpotPriceCache.get(cacheKey);
  if (cached && Date.now() - cached.at < ONCHAIN_PRICE_CACHE_MS) return cached.data;
  const poolInfo = await getBscPancakeV3PoolByAddress(cacheKey);
  if (!poolInfo?.pairAddress) throw new Error("未找到 PancakeSwap V3 池子");
  const pool = poolInfo.pairAddress;
  const [slot0Result, token0Result, token1Result] = await Promise.all([
    contractCall(pool, POOL_IFACE, "slot0"),
    contractCall(pool, POOL_IFACE, "token0"),
    contractCall(pool, POOL_IFACE, "token1"),
  ]);
  const token0 = token0Result[0];
  const token1 = token1Result[0];
  const [decimals0Result, decimals1Result, symbol0Result, symbol1Result] = await Promise.all([
    contractCall(token0, ERC20_IFACE, "decimals").catch(() => [18]),
    contractCall(token1, ERC20_IFACE, "decimals").catch(() => [18]),
    contractCall(token0, ERC20_IFACE, "symbol").catch(() => ["TOKEN0"]),
    contractCall(token1, ERC20_IFACE, "symbol").catch(() => ["TOKEN1"]),
  ]);
  const decimals0 = Number(decimals0Result[0]);
  const decimals1 = Number(decimals1Result[0]);
  const price0 = tickToPrice(Number(slot0Result.tick), decimals0, decimals1);
  const baseIsToken0 = token0.toLowerCase() === String(address).toLowerCase();
  const baseSymbol = baseIsToken0 ? symbol0Result[0] : symbol1Result[0];
  const quoteSymbol = baseIsToken0 ? symbol1Result[0] : symbol0Result[0];
  const price = baseIsToken0 ? price0 : 1 / price0;
  const data = { address: cacheKey, pool, price, baseSymbol, quoteSymbol, liquidityUsd: poolInfo.liquidityUsd, checkedAt: new Date().toISOString() };
  onchainSpotPriceCache.set(cacheKey, { at: Date.now(), data });
  return data;
}

async function loadOnchainAlerts() {
  if (onchainAlerts) return onchainAlerts;
  onchainAlerts = await onchainStore.load();
  if (!Array.isArray(onchainAlerts.alerts)) onchainAlerts.alerts = [];
  if (!Array.isArray(onchainAlerts.events)) onchainAlerts.events = [];
  return onchainAlerts;
}

async function saveOnchainAlerts() {
  return onchainStore.save(onchainAlerts);
}

function normalizeOnchainAlert(input) {
  const address = String(input.address || "").trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(address)) throw new Error("无效的 BSC 合约地址");
  const price = Number(input.price);
  if (!Number.isFinite(price) || price <= 0) throw new Error("目标价格必须大于 0");
  const supply = parseNumber(input.supply, 1_000_000_000, 0, 1e30);
  const tolerance = parseNumber(input.tolerance, 1, 0, 50);
  const interval = parseInteger(input.interval, 300, 60, 3600);
  const mode = ["enter", "below", "above"].includes(input.mode) ? input.mode : "enter";
  return {
    id: String(input.id || `${address}:${price}:${Date.now()}`), address, price, supply, marketCap: price * supply, mode, tolerance, interval,
    note: String(input.note || "").slice(0, 160), enabled: input.enabled !== false, armed: true, lastCheckedAt: null, lastPrice: null, lastTriggeredAt: null,
  };
}

function alertIsTriggered(alert, price) {
  const band = alert.price * (alert.tolerance / 100);
  if (alert.mode === "below") return price <= alert.price - band;
  if (alert.mode === "above") return price >= alert.price + band;
  return Math.abs(price - alert.price) <= band;
}

function alertIsOutside(alert, price) {
  const band = alert.price * (alert.tolerance / 100);
  if (alert.mode === "below") return price >= alert.price;
  if (alert.mode === "above") return price <= alert.price;
  return Math.abs(price - alert.price) > band * 1.25;
}

async function checkOnchainAlerts() {
  if (onchainCheckInFlight) return;
  onchainCheckInFlight = true;
  try {
    const store = await loadOnchainAlerts();
    const now = Date.now();
    let changed = false;
    const dueAlerts = store.alerts.filter((item) => item.enabled && (!item.lastCheckedAt || now - new Date(item.lastCheckedAt).getTime() >= item.interval * 1000));
    await mapLimit(dueAlerts, ONCHAIN_CHECK_CONCURRENCY, async (alert) => {
    try {
      const quote = await getOnchainSpotPrice(alert.address);
      const price = quote.price;
      alert.lastCheckedAt = quote.checkedAt;
      alert.lastPrice = price;
      changed = true;
      if (!alert.armed && alertIsOutside(alert, price)) {
        alert.armed = true;
        changed = true;
      }
      if (alert.armed && alertIsTriggered(alert, price)) {
        const event = { id: `${alert.id}:${now}`, alertId: alert.id, address: alert.address, symbol: quote.baseSymbol, quoteSymbol: quote.quoteSymbol, price, targetPrice: alert.price, mode: alert.mode, tolerance: alert.tolerance, supply: alert.supply, marketCap: alert.marketCap, note: alert.note, triggeredAt: new Date(now).toISOString() };
        store.events.unshift(event);
        store.events = store.events.slice(0, ONCHAIN_ALERT_LIMIT);
        alert.armed = false;
        alert.lastTriggeredAt = event.triggeredAt;
        changed = true;
        console.log(`[onchain] alert ${quote.baseSymbol} ${price}`);
      }
    } catch (error) {
      alert.lastError = error.message;
      alert.lastCheckedAt = new Date(now).toISOString();
      changed = true;
    }
    });
    if (changed) await saveOnchainAlerts();
  } finally {
    onchainCheckInFlight = false;
  }
}

async function handleOnchainAlerts(req, res) {
  const store = await loadOnchainAlerts();
  if (req.method === "GET") return json(res, 200, { alerts: store.alerts });
  if (req.method === "POST") {
    try {
      const input = await readJsonBody(req);
      const alert = normalizeOnchainAlert(input);
      const index = store.alerts.findIndex((item) => item.id === alert.id);
      if (index >= 0) store.alerts[index] = { ...store.alerts[index], ...alert };
      else store.alerts.unshift(alert);
      store.alerts = store.alerts.slice(0, ONCHAIN_ALERT_LIMIT);
      await saveOnchainAlerts();
      return json(res, 200, { alert });
    } catch (error) { return json(res, 400, { error: error.message }); }
  }
  if (req.method === "DELETE") {
    const id = new URL(req.url, `http://${req.headers.host}`).searchParams.get("id");
    store.alerts = store.alerts.filter((item) => item.id !== id);
    await saveOnchainAlerts();
    return json(res, 200, { alerts: store.alerts });
  }
  return json(res, 405, { error: "Method not allowed" });
}

async function handleOnchainEvents(req, res) {
  const store = await loadOnchainAlerts();
  const since = Number(new URL(req.url, `http://${req.headers.host}`).searchParams.get("since") || 0);
  const events = store.events.filter((event) => new Date(event.triggeredAt).getTime() > since);
  return json(res, 200, { events });
}

async function getMarketCaps() {
  if (Date.now() - marketCapCache.at < 10 * 60_000 && marketCapCache.data.size) {
    return marketCapCache.data;
  }

  const pages = Array.from({ length: 10 }, (_, index) => index + 1);
  const pageRows = await mapLimit(pages, 3, (page) =>
    coingecko(`/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${page}&sparkline=false`)
  );
  const rows = pageRows.flatMap((page) => (Array.isArray(page) ? page : []));

  const caps = new Map();
  for (const coin of rows) {
    const symbol = String(coin.symbol || "").toUpperCase();
    const marketCap = Number(coin.market_cap);
    if (!symbol || !Number.isFinite(marketCap)) continue;
    const existing = caps.get(symbol);
    if (!existing || marketCap > existing.marketCap) {
      caps.set(symbol, {
        marketCap,
        marketCapRank: Number(coin.market_cap_rank) || null,
        coinName: coin.name || symbol,
        coinId: coin.id || null,
      });
    }
  }

  marketCapCache = { at: Date.now(), data: caps };
  return caps;
}

async function getFundingRates() {
  if (Date.now() - fundingCache.at < 60_000 && fundingCache.data.size) {
    return fundingCache.data;
  }
  const rows = await binance("/fapi/v1/premiumIndex");
  const rates = new Map();
  for (const row of rows) {
    const rate = Number(row.lastFundingRate);
    rates.set(row.symbol, {
      fundingRate: Number.isFinite(rate) ? rate : null,
      nextFundingTime: Number(row.nextFundingTime) || null,
    });
  }
  fundingCache = { at: Date.now(), data: rates };
  return rates;
}

async function getUsdtPerpetualSymbols() {
  if (Date.now() - symbolsCache.at < 10 * 60_000 && symbolsCache.data.length) {
    return symbolsCache.data;
  }
  const [info, tickers] = await Promise.all([
    binance("/fapi/v1/exchangeInfo"),
    binance("/fapi/v1/ticker/24hr"),
  ]);
  const volumeBySymbol = new Map(
    (Array.isArray(tickers) ? tickers : []).map((ticker) => [ticker.symbol, Number(ticker.quoteVolume)])
  );
  const symbols = info.symbols
    .filter((s) => s.contractType === "PERPETUAL")
    .filter((s) => s.quoteAsset === "USDT")
    .filter((s) => s.status === "TRADING")
    .map((s) => ({
      symbol: s.symbol,
      baseAsset: s.baseAsset,
      quoteAsset: s.quoteAsset,
      quoteVolume24h: Number.isFinite(volumeBySymbol.get(s.symbol)) ? volumeBySymbol.get(s.symbol) : null,
    }))
    .sort((a, b) => (b.quoteVolume24h || 0) - (a.quoteVolume24h || 0) || a.symbol.localeCompare(b.symbol));
  symbolsCache = { at: Date.now(), data: symbols };
  return symbols;
}

async function mapLimit(items, limit, worker) {
  const results = [];
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = items[index++];
      try {
        results.push(await worker(current));
      } catch (error) {
        results.push({ symbol: current.symbol, error: error.message });
      }
    }
  });
  await Promise.all(runners);
  return results;
}

async function getOpenInterestChange(symbolInfo, period, points) {
  const params = new URLSearchParams({
    symbol: symbolInfo.symbol,
    period,
    limit: String(points),
  });
  const rows = await binance(`/futures/data/openInterestHist?${params}`);
  if (!Array.isArray(rows) || rows.length < 2) {
    return { symbol: symbolInfo.symbol, skipped: "not_enough_history" };
  }

  const first = rows[0];
  const last = rows[rows.length - 1];
  const startOi = Number(first.sumOpenInterest);
  const endOi = Number(last.sumOpenInterest);
  const startValue = Number(first.sumOpenInterestValue);
  const endValue = Number(last.sumOpenInterestValue);
  const circulatingSupply = Number(last.CMCCirculatingSupply);
  const impliedPrice = endOi > 0 && Number.isFinite(endValue) ? endValue / endOi : null;
  const cmcMarketCap =
    Number.isFinite(circulatingSupply) && circulatingSupply > 0 && Number.isFinite(impliedPrice)
      ? circulatingSupply * impliedPrice
      : null;
  if (!Number.isFinite(startOi) || !Number.isFinite(endOi) || startOi <= 0) {
    return { symbol: symbolInfo.symbol, skipped: "bad_open_interest" };
  }

  return {
    ...symbolInfo,
    startTime: Number(first.timestamp),
    endTime: Number(last.timestamp),
    startOpenInterest: startOi,
    endOpenInterest: endOi,
    changePct: ((endOi - startOi) / startOi) * 100,
    startOpenInterestValue: startValue,
    endOpenInterestValue: endValue,
    cmcCirculatingSupply: Number.isFinite(circulatingSupply) ? circulatingSupply : null,
    impliedPrice,
    cmcMarketCap,
    valueChangePct:
      Number.isFinite(startValue) && Number.isFinite(endValue) && startValue > 0
        ? ((endValue - startValue) / startValue) * 100
        : null,
  };
}

async function handleScan(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const period = url.searchParams.get("period") || "4h";
  const points = parseInteger(url.searchParams.get("points"), 5, 2, 30);
  const threshold = parseNumber(url.searchParams.get("threshold"), 30, 0, 500);
  const maxSymbols = parseInteger(url.searchParams.get("maxSymbols"), 260, 20, 500);
  const smallCapMaxUsd = parseNumber(url.searchParams.get("smallCapMaxUsd"), 100_000_000, 1_000_000, 5_000_000_000);
  const smallCapMinChange = parseNumber(url.searchParams.get("smallCapMinChange"), 0, -100, 500);
  const liqMinRaw = url.searchParams.get("liqMin");
  const liqMaxRaw = url.searchParams.get("liqMax");
  const liqMin = liqMinRaw === null || liqMinRaw === "" ? null : parseNumber(liqMinRaw, 0, 0, 100) / 100;
  const liqMax = liqMaxRaw === null || liqMaxRaw === "" ? null : parseNumber(liqMaxRaw, 100, 0, 100) / 100;
  const hasLiquidityRange = liqMin !== null || liqMax !== null;
  const allowedPeriods = new Set(["5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d"]);

  if (!allowedPeriods.has(period)) {
    return json(res, 400, { error: "Unsupported period" });
  }
  if (liqMin !== null && liqMax !== null && liqMin > liqMax) {
    return json(res, 400, { error: "Liquidity minimum cannot exceed maximum" });
  }

  const key = [
    period,
    points,
    threshold,
    maxSymbols,
    smallCapMaxUsd,
    smallCapMinChange,
    liqMin ?? "",
    liqMax ?? "",
  ].join(":");
  const cached = scanCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) {
    return json(res, 200, cached.data);
  }

  try {
    const [allSymbols, marketCaps, fundingRates] = await Promise.all([
      getUsdtPerpetualSymbols(),
      getMarketCaps().catch(() => new Map()),
      getFundingRates().catch(() => new Map()),
    ]);
    const symbols = allSymbols.slice(0, maxSymbols);
    const scanned = await mapLimit(symbols, CONCURRENCY, (s) => getOpenInterestChange(s, period, points));
    const valid = scanned
      .filter((row) => Number.isFinite(row.changePct))
      .map((row) => {
        const cap = marketCaps.get(normalizeBaseAsset(row.baseAsset));
        const funding = fundingRates.get(row.symbol);
        const binanceCap = Number.isFinite(Number(row.cmcMarketCap)) ? Number(row.cmcMarketCap) : null;
        return {
          ...row,
          marketCap: binanceCap ?? cap?.marketCap ?? null,
          marketCapRank: cap?.marketCapRank ?? null,
          coinName: cap?.coinName ?? null,
          marketCapSource: binanceCap ? "binance_cmc_supply" : cap ? "coingecko" : null,
          fundingRate: funding?.fundingRate ?? null,
          nextFundingTime: funding?.nextFundingTime ?? null,
        };
      });
    const baseSorted = valid.sort((a, b) => b.changePct - a.changePct);
    const alertsBase = baseSorted.filter((row) => row.changePct >= threshold);
    const topBase = baseSorted.slice(0, 30);
    const smallCapBase = baseSorted
      .filter((row) => Number.isFinite(Number(row.marketCap)))
      .filter((row) => Number(row.marketCap) > 0 && Number(row.marketCap) <= smallCapMaxUsd)
      .filter((row) => row.changePct >= smallCapMinChange)
      .slice(0, 120);
    const enrichTargets = hasLiquidityRange
      ? baseSorted
      : [...new Map([...alertsBase, ...topBase, ...smallCapBase].map((row) => [row.symbol, row])).values()];
    const enrichedRows = await mapLimit(enrichTargets, 6, async (row) => ({
      ...row,
      ...(await getBscPool(row, row.marketCap)),
    }));
    const enrichedBySymbol = new Map(enrichedRows.map((row) => [row.symbol, row]));
    const inLiquidityRange = (row) => {
      if (!hasLiquidityRange) return true;
      const ratio = Number(row.bscLiquidityToMcap);
      if (!Number.isFinite(ratio)) return false;
      if (liqMin !== null && ratio < liqMin) return false;
      if (liqMax !== null && ratio > liqMax) return false;
      return true;
    };
    const enrichedSorted = baseSorted.map((row) => enrichedBySymbol.get(row.symbol) || row);
    const alerts = enrichedSorted.filter((row) => row.changePct >= threshold).filter(inLiquidityRange);
    const topRisers = enrichedSorted.filter(inLiquidityRange).slice(0, 30);
    const smallCaps = smallCapBase.map((row) => enrichedBySymbol.get(row.symbol) || row).filter(inLiquidityRange).slice(0, 100);
    const payload = {
      exchange: "binance",
      market: "usdt_m_futures",
      period,
      points,
      threshold,
      smallCap: {
        maxUsd: smallCapMaxUsd,
        minChangePct: smallCapMinChange,
      },
      liquidityRange: hasLiquidityRange
        ? {
            minPct: liqMin === null ? null : liqMin * 100,
            maxPct: liqMax === null ? null : liqMax * 100,
          }
        : null,
      scanned: valid.length,
      errors: scanned.filter((row) => row.error).length,
      generatedAt: new Date().toISOString(),
      alerts,
      smallCaps,
      topRisers,
    };
    scanCache.set(key, { at: Date.now(), data: payload });
    while (scanCache.size > MAX_SCAN_CACHE) {
      const oldestKey = scanCache.keys().next().value;
      scanCache.delete(oldestKey);
    }
    json(res, 200, payload);
  } catch (error) {
    json(res, 502, { error: error.message });
  }
}

async function handleVix(req, res) {
  try {
    json(res, 200, await getVix());
  } catch (error) {
    json(res, 502, { error: error.message });
  }
}

async function handleDxy(req, res) {
  try {
    json(res, 200, await getDxy());
  } catch (error) {
    json(res, 502, { error: error.message });
  }
}

async function handleMacroOverview(req, res) {
  try {
    json(res, 200, await getMacroOverview());
  } catch (error) {
    json(res, 502, { error: error.message });
  }
}

async function handleLiquidityRange(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const symbol = String(url.searchParams.get("symbol") || "").toUpperCase();
  if (!symbol) return json(res, 400, { error: "Missing symbol" });
  try {
    return json(res, 200, await buildPancakeLiquidityRange(symbol));
  } catch (error) {
    return json(res, 502, { error: error.message });
  }
}

function handleHealth(req, res) {
  json(res, 200, {
    status: "ok",
    uptimeSeconds: Math.round(process.uptime()),
    generatedAt: new Date().toISOString(),
    caches: {
      symbols: symbolsCache.data.length,
      marketCaps: marketCapCache.data.size,
      fundingRates: fundingCache.data.size,
      scans: scanCache.size,
      reversalCandles: reversalCandleCache.size,
      onchainSpotPrices: onchainSpotPriceCache.size,
    },
    binanceRateLimit: {
      usedWeight1m: binanceRateState.used,
      pausedUntil: binanceRateState.blockedUntil ? new Date(binanceRateState.blockedUntil).toISOString() : null,
    },
    schedulers: {
      onchainAlertChecker: onchainCheckInFlight ? "running" : "idle",
    },
    persistence: {
      onchainAlertsLoaded: Boolean(onchainAlerts),
      reversalHistoryLoaded: Boolean(reversalHistory),
    },
  });
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const safePath = normalize(pathname).replace(/^[/\\]+/, "");
  const filePath = resolve(PUBLIC_DIR, safePath);
  if (filePath !== resolve(PUBLIC_DIR) && !filePath.startsWith(`${resolve(PUBLIC_DIR)}${sep}`)) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
  };
  try {
    const content = await readFile(filePath);
    res.writeHead(200, {
      "content-type": types[extname(filePath)] || "application/octet-stream",
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

const dispatchRequest = createRouter({
  routes: [
    { match: (req) => req.url === "/api/health" || req.url === "/healthz", handler: handleHealth },
    { match: (req) => req.url.startsWith("/api/reversal/scan"), handler: handleReversalScan },
    { match: (req) => req.url.startsWith("/api/reversal/history"), handler: handleReversalHistory },
    { match: (req) => req.url.startsWith("/api/reversal/stats"), handler: handleReversalStats },
    { match: (req) => req.url.startsWith("/api/onchain/alerts/events"), handler: handleOnchainEvents },
    { match: (req) => req.url.startsWith("/api/onchain/alerts"), handler: handleOnchainAlerts },
    { match: (req) => req.url.startsWith("/api/liquidity-range"), handler: handleLiquidityRange },
    { match: (req) => req.url.startsWith("/api/scan"), handler: handleScan },
    { match: (req) => req.url.startsWith("/api/macro/vix"), handler: handleVix },
    { match: (req) => req.url.startsWith("/api/macro/dxy"), handler: handleDxy },
    { match: (req) => req.url.startsWith("/api/macro/all"), handler: handleMacroOverview },
  ],
  fallback: serveStatic,
});

const server = http.createServer(dispatchRequest);

server.listen(PORT, () => {
  console.log(`OI dashboard running at http://localhost:${PORT}`);
  const runAutomaticReversalScan = async () => {
    try {
      const requested = await getDefaultReversalAssets();
      const data = await scanReversalData(requested, "24h-quote-volume");
      console.log(`[reversal] automatic scan: ${data.rows.length} assets, ${data.signals.length} signals, history ${data.historyCount}`);
    } catch (error) {
      console.error(`[reversal] automatic scan failed: ${error.message}`);
    }
  };
  setTimeout(runAutomaticReversalScan, 3_000);
  setInterval(runAutomaticReversalScan, 2 * 60 * 60_000);
  setTimeout(() => checkOnchainAlerts().catch((error) => console.error(`[onchain] alert check failed: ${error.message}`)), 5_000);
  setInterval(() => checkOnchainAlerts().catch((error) => console.error(`[onchain] alert check failed: ${error.message}`)), 60_000);
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Set PORT to another value or stop the existing service.`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
