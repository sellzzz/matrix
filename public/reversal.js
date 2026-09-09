const $ = (id) => document.getElementById(id);

const els = {
  symbols: $("symbols"),
  refreshBtn: $("refreshBtn"),
  signalCount: $("signalCount"),
  watchCount: $("watchCount"),
  updated: $("updated"),
  status: $("status"),
  signalList: $("signalList"),
  watchBody: $("watchBody"),
  historyBody: $("historyBody"),
  historyStatus: $("historyStatus"),
  statsBtn: $("statsBtn"), statsHorizon: $("statsHorizon"), statsTarget: $("statsTarget"), statsStatus: $("statsStatus"), statsSummary: $("statsSummary"),
  statsOutcomeBar: $("statsOutcomeBar"), statsTimeline: $("statsTimeline"),
  exportStatsBtn: $("exportStatsBtn"),
  manualPushBtn: $("manualPushBtn"), manualPushStatus: $("manualPushStatus"),
};
let latestStats = null;
let latestSignals = [];

let controller = null;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function fmtPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  if (Math.abs(n) >= 100) return n.toFixed(2);
  if (Math.abs(n) >= 1) return n.toFixed(3);
  return n.toPrecision(5);
}

function fmtDate(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(new Date(value));
}

function fmtDateTime(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function tradingViewMeta(row) {
  const raw = String(row?.symbol || "").trim().toUpperCase();
  let tvSymbol = row?.tradingViewSymbol || "";
  if (!tvSymbol && raw.endsWith(".HK")) tvSymbol = `HKEX:${raw.slice(0, -3).replace(/^0+(?=\d)/, "")}`;
  if (!tvSymbol && ["XAUUSD", "XAGUSD"].includes(raw)) tvSymbol = `OANDA:${raw}`;
  if (!tvSymbol && raw.endsWith("USDT")) tvSymbol = `BINANCE:${raw}.P`;
  const chartUrl = row?.chartUrl || (tvSymbol ? `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tvSymbol)}` : "");
  return { tvSymbol, chartUrl };
}

function tradingViewLink(row, showCode = false) {
  const { tvSymbol, chartUrl } = tradingViewMeta(row);
  const label = showCode && tvSymbol ? tvSymbol : row?.symbol || "-";
  if (!chartUrl) return escapeHtml(label);
  return `<a class="tvSymbolLink" href="${escapeHtml(chartUrl)}" target="_blank" rel="noopener" title="在 TradingView 打开 ${escapeHtml(tvSymbol)}">${escapeHtml(label)}</a>`;
}

function renderHistory(records) {
  if (!records.length) {
    els.historyBody.innerHTML = '<tr><td class="empty" colspan="5">暂时没有已记录信号</td></tr>';
    return;
  }
  els.historyBody.innerHTML = records.map((record) => {
    const support = record.type === "support-touch";
    const approaching = record.status === "approaching";
    return `<tr>
      <td>${fmtDateTime(record.recordedAt)}</td>
      <td class="symbol">${tradingViewLink(record, true)}<small>${escapeHtml(record.market)} · ${escapeHtml(record.symbol)}</small></td>
      <td class="positive">${approaching ? "接近预警" : "重新进入"}</td>
      <td>${support ? "支撑 · 潜在反弹" : "阻力 · 潜在回落"}</td>
      <td><b>${fmtPrice(record.current?.price)}</b><small>${fmtPrice(record.zoneLow)} - ${fmtPrice(record.zoneHigh)}</small></td>
    </tr>`;
  }).join("");
}

async function loadHistory() {
  try {
    const response = await fetch("/api/reversal/history?limit=100", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "读取记录失败");
    renderHistory(data.records || []);
    els.historyStatus.textContent = `${data.records.length} 条记录`;
  } catch (error) {
    els.historyStatus.textContent = error.message;
    renderHistory([]);
  }
}

async function loadStats() {
  els.statsBtn.disabled = true;
  els.statsStatus.textContent = "计算中";
  try {
    const query = new URLSearchParams({ horizon: els.statsHorizon.value, targetPct: els.statsTarget.value });
    const response = await fetch(`/api/reversal/stats?${query}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "统计失败");
    latestStats = data;
    els.exportStatsBtn.disabled = false;
    const pct = (value) => Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(1)}%` : "-";
    const num = (value) => Number.isFinite(Number(value)) ? `${Number(value).toFixed(2)}%` : "-";
    els.statsStatus.textContent = `${data.assetsWithData}/${data.assetsRequested} 个标的 · ${data.samples} 个样本 · 已忽略 ${data.cooldownDays} 日内重复信号`;
    els.statsSummary.innerHTML = [["指标命中", data.successful], ["指标失效", data.invalidated], ["待复核", data.ambiguous], ["未完成", data.timeout], ["总体命中率", pct(data.indicatorHitRate)], ["支撑命中率", pct(data.supportHitRate)], ["阻力命中率", pct(data.resistanceHitRate)], ["平均有利波动", num(data.averageMaxFavorablePct)], ["平均不利波动", num(data.averageMaxAdversePct)]]
      .map(([label, value]) => `<div><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`).join("");
    const total = Math.max(1, data.samples);
    els.statsOutcomeBar.innerHTML = [
      ["成功", data.successful, "isSuccess"], ["失效", data.invalidated, "isFailure"], ["待复核", data.ambiguous, "isPending"], ["未完成", data.timeout, "isPending"],
    ].map(([label, value, cls]) => `<div class="statsOutcomeSegment ${cls}" style="width:${Number(value) / total * 100}%" title="${label} ${value}"><span>${label}</span><b>${value}</b></div>`).join("");
    els.statsTimeline.innerHTML = (data.recent || []).slice().reverse().map((row) => {
      const cls = row.outcome === "successful" ? "isSuccess" : row.outcome === "invalidated" ? "isFailure" : "isPending";
      const label = row.outcome === "successful" ? "命中" : row.outcome === "invalidated" ? "失效" : row.outcome === "ambiguous" ? "待复核" : "未完成";
      return `<div class="statsTimelineItem ${cls}" title="${fmtDate(row.signalTime)} · ${label} · ${Number(row.maxFavorablePct).toFixed(2)}% 有利波动"><span>${fmtDate(row.signalTime)}</span><b>${label}</b></div>`;
    }).join("");
  } catch (error) {
    els.statsStatus.textContent = "失败";
    els.statsSummary.innerHTML = `<div class="emptySignal">${escapeHtml(error.message)}</div>`;
    els.statsOutcomeBar.innerHTML = "";
    els.statsTimeline.innerHTML = "";
    latestStats = null;
    els.exportStatsBtn.disabled = true;
  } finally { els.statsBtn.disabled = false; }
}

function renderSignals(signals) {
  if (!signals.length) {
    els.signalList.innerHTML = '<div class="emptySignal">当前没有新的关键区域信号</div>';
    return;
  }
  els.signalList.innerHTML = signals.map((signal) => {
    const support = signal.type === "support-touch";
    const approaching = signal.isSecondApproach && !signal.isSecondTouch;
    return `<article class="reversalSignal ${support ? "isSupport" : "isResistance"}">
      <div class="signalState">${approaching ? "\u63a5\u8fd1\u9884\u8b66" : "\u91cd\u65b0\u8fdb\u5165"}</div>
      <div class="reversalSignalTop"><span class="signalBadge">${support ? "支撑 · 潜在反弹" : "阻力 · 潜在回落"}</span><strong>${tradingViewLink(signal, true)}</strong><span class="signalMarket">${escapeHtml(signal.market)}</span></div>
      <div class="reversalSignalGrid">
        <div><span>当前价格</span><b>${fmtPrice(signal.current?.price)}</b></div>
        <div><span>关键区域</span><b>${fmtPrice(signal.zoneLow)} - ${fmtPrice(signal.zoneHigh)}</b></div>
        <div><span>区域年龄</span><b>${signal.ageDays ?? signal.ageBars} ${signal.ageDays != null ? "天" : "根日线"}</b></div>
        <div><span>4 小时触发</span><b>${fmtDateTime(signal.triggerTime || signal.touchTime)}</b></div>
      </div>
      <div class="reversalSignalFoot">日线锚点 ${fmtDate(signal.originTime)} · 触发价 ${fmtPrice(signal.triggerPrice)} · 距离区域 ${Number(signal.distancePct).toFixed(2)}%</div>
    </article>`;
  }).join("");
}

function renderWatch(rows) {
  if (!rows.length) {
    els.watchBody.innerHTML = '<tr><td class="empty" colspan="7">没有观察标的</td></tr>';
    return;
  }
  els.watchBody.innerHTML = rows.map((row) => {
    const firstTouch = ["revisit", "second-touch", "approaching"].includes(row.status);
    const zone = row.zones?.[0];
    return `<tr>
      <td class="symbol">${tradingViewLink(row, true)}<small>${escapeHtml(row.symbol)}</small></td>
      <td>${escapeHtml(row.market)}</td>
      <td class="${firstTouch ? "positive" : ""}">${firstTouch ? (row.status === "approaching" ? "接近预警" : "重新进入") : row.status === "error" ? "读取失败" : "观察中"}</td>
      <td>${fmtPrice(row.current?.price)}</td>
      <td>${zone ? `${fmtPrice(zone.zoneLow)} - ${fmtPrice(zone.zoneHigh)}` : "-"}</td>
      <td>${zone ? `${zone.ageDays ?? zone.ageBars} ${zone.ageDays != null ? "天" : "根"}` : "-"}</td>
      <td>${escapeHtml(row.error || "-")}</td>
    </tr>`;
  }).join("");
}

async function scan() {
  controller?.abort();
  controller = new AbortController();
  els.refreshBtn.disabled = true;
  els.status.textContent = "正在扫描…";
  const symbols = encodeURIComponent(els.symbols.value.trim());
  try {
    const response = await fetch(`/api/reversal/scan?symbols=${symbols}`, { signal: controller.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "扫描失败");
    els.signalCount.textContent = data.signals.length;
    els.watchCount.textContent = data.rows.length;
    els.updated.textContent = new Date(data.generatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    els.status.textContent = `${data.selectionMode === "24h-quote-volume" ? "币安 USDT 永续自动观察池" : "手动观察池"} / 日线锚点 / 4 小时触发 / ${data.minimumAgeText}`;
    latestSignals = data.signals || [];
    els.manualPushBtn.disabled = latestSignals.length === 0;
    els.manualPushStatus.textContent = latestSignals.length ? `可手动推送 ${latestSignals.length} 条` : "人工判断 · 不自动交易";
    renderSignals(data.signals);
    renderWatch(data.rows);
    await loadHistory();
  } catch (error) {
    if (error.name === "AbortError") return;
    els.status.textContent = error.message;
    latestSignals = [];
    els.manualPushBtn.disabled = true;
    els.manualPushStatus.textContent = "扫描失败";
    els.signalList.innerHTML = '<div class="emptySignal">扫描失败，请稍后重试</div>';
    renderWatch([]);
  } finally {
    els.refreshBtn.disabled = false;
  }
}

async function manualPush() {
  const recordKeys = [...new Set(latestSignals.map((signal) => {
    const key = String(signal.recordKey || "").trim();
    const symbol = String(signal.symbol || "").trim().toUpperCase();
    return key.includes("::") && symbol ? key.replace("::", `:${symbol}:`) : key;
  }).filter(Boolean))];
  if (!recordKeys.length) return;
  els.manualPushBtn.disabled = true;
  els.manualPushStatus.textContent = "正在加入推送队列…";
  try {
    const response = await fetch("/api/reversal/manual-push", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recordKeys }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "推送失败");
    els.manualPushStatus.textContent = data.duplicate ? "本批已在推送队列" : `已排队 ${data.request.count} 条 · 1 分钟内发送`;
  } catch (error) {
    els.manualPushStatus.textContent = error.message;
  } finally {
    setTimeout(() => { els.manualPushBtn.disabled = latestSignals.length === 0; }, 3000);
  }
}

els.refreshBtn.addEventListener("click", scan);
els.manualPushBtn.addEventListener("click", manualPush);
els.statsBtn.addEventListener("click", loadStats);
els.exportStatsBtn.addEventListener("click", () => {
  if (!latestStats?.records?.length) return;
  const headers = ["symbol", "tradingViewSymbol", "chartUrl", "market", "type", "status", "originTime", "originPoint", "triggerTime", "entry", "zoneLow", "zoneHigh", "triggerOpen", "triggerHigh", "triggerLow", "triggerClose", "outcome", "barsToOutcome", "maxFavorablePct", "maxAdversePct"];
  const lines = [headers.join(","), ...latestStats.records.map((row) => headers.map((key) => {
    const value = ["originTime", "triggerTime"].includes(key) && row[key] ? new Date(row[key]).toISOString() : row[key] ?? "";
    return `"${String(value).replaceAll('"', '""')}"`;
  }).join(","))];
  const blob = new Blob(["\ufeff" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${latestStats.symbol || "default-watchlist"}-key-zone-stats.csv`;
  link.click();
  URL.revokeObjectURL(url);
});
els.symbols.addEventListener("keydown", (event) => {
  if (event.key === "Enter") scan();
});
scan();
setInterval(scan, 2 * 60 * 60_000);
