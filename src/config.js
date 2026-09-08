import { join } from "node:path";

const dataDir = join(process.cwd(), "data");

export const config = Object.freeze({
  port: Number(process.env.PORT || 8787),
  publicDir: join(process.cwd(), "public"),
  dataDir,
  binanceFapi: "https://fapi.binance.com",
  coingeckoApi: "https://api.coingecko.com/api/v3",
  dexscreenerApi: "https://api.dexscreener.com",
  bscRpc: process.env.BSC_RPC || "https://bsc-dataseed.binance.org",
  cacheMs: 30_000,
  macroCacheMs: 60_000,
  fetchTimeoutMs: 15_000,
  maxScanCache: 60,
  reversalCacheMs: 5 * 60_000,
  reversalTopFutures: Math.min(600, Math.max(20, Number(process.env.REVERSAL_TOP_FUTURES || 600))),
  reversalMaxAssets: Math.min(650, Math.max(40, Number(process.env.REVERSAL_MAX_ASSETS || 600))),
  reversalHistoryFile: join(dataDir, "reversal-signals.json"),
  reversalHistoryLimit: 500,
  onchainAlertsFile: join(dataDir, "onchain-alerts.json"),
  onchainAlertLimit: 200,
  onchainPriceCacheMs: 30_000,
  onchainCheckConcurrency: 4,
  fredApi: "https://api.stlouisfed.org/fred/series/observations",
  treasuryCurveCsv: "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv",
  cmeFedwatchApi: process.env.CME_FEDWATCH_API_URL || "https://markets.api.cmegroup.com/fedwatch/v1",
  concurrency: 12,
  reversalSignalCooldownDays: 7,
});
