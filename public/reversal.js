const $ = (id) => document.getElementById(id);

const els = {
  symbols: $("symbols"),
  refreshBtn: $("refreshBtn"),
  signalCount: $("signalCount"),
  watchCount: $("watchCount"),
  updated: $("updated"),
  status: $("status"),
  signalList: $("signalList"),
  watchBody: $("watchBody"), watchFilter: $("watchFilter"), watchStatus: $("watchStatus"), watchMoreBtn: $("watchMoreBtn"),
  historyBody: $("historyBody"),
  historyStatus: $("historyStatus"),
  dailyReviewBtn: $("dailyReviewBtn"),
  statsBtn: $("statsBtn"), statsHorizon: $("statsHorizon"), statsTarget: $("statsTarget"), statsStatus: $("statsStatus"), statsSummary: $("statsSummary"),
  statsOutcomeBar: $("statsOutcomeBar"), statsTimeline: $("statsTimeline"),
  exportStatsBtn: $("exportStatsBtn"),
  manualPushBtn: $("manualPushBtn"), manualPushStatus: $("manualPushStatus"),
  realtimeBody: $("realtimeBody"), realtimeStatus: $("realtimeStatus"), realtimeSummary: $("realtimeSummary"),
};
let latestStats = null;
let latestSignals = [];
let latestWatchRows = [];
let watchVisibleLimit = 80;

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

function shanghaiDateKey(value = Date.now()) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

function plainDirection(row) {
  return row.type === "support-touch" || row.side === "support" ? "支撑 / 潜在反弹" : "阻力 / 潜在回落";
}

function buildDailyReviewText(records, episodes, dateKey) {
  const typeLabels = { approaching: "接近", touched: "触及", swept: "穿透", reclaimed: "收回确认", "front-run": "未触及转向" };
  const todayRecords = records
    .filter((row) => shanghaiDateKey(row.recordedAt || row.triggerTime || row.touchTime) === dateKey)
    .sort((a, b) => new Date(a.recordedAt || 0) - new Date(b.recordedAt || 0));
  const todayEpisodes = episodes
    .filter((row) => shanghaiDateKey(row.updatedAt || row.time) === dateKey)
    .sort((a, b) => Number(a.updatedAt || a.time || 0) - Number(b.updatedAt || b.time || 0));
  const symbols = [...new Set([...todayRecords, ...todayEpisodes].map((row) => tradingViewMeta(row).tvSymbol || row.symbol).filter(Boolean))];
  const rows = new Map();
  for (const record of todayRecords) {
    const symbol = tradingViewMeta(record).tvSymbol || record.symbol || "-";
    const items = rows.get(symbol) || [];
    items.push([
      `[信号] ${fmtDateTime(record.recordedAt)} · ${record.status === "approaching" ? "接近预警" : "重新进入"}`,
      `方向: ${plainDirection(record)}`,
      `价格: ${fmtPrice(record.triggerPrice ?? record.current?.price)} | 区域: ${fmtPrice(record.zoneLow)} - ${fmtPrice(record.zoneHigh)}`,
      `日线锚点: ${fmtDateTime(record.originTime)} | 4小时触发: ${fmtDateTime(record.triggerTime || record.touchTime)}`,
    ].join("\n"));
    rows.set(symbol, items);
  }
  for (const episode of todayEpisodes) {
    const symbol = tradingViewMeta(episode).tvSymbol || episode.symbol || "-";
    const items = rows.get(symbol) || [];
    const evidence = episode.evidence || {};
    const context = episode.context || {};
    const snapshots = episode.followUp?.snapshots || {};
    const outcomes = ["5m", "15m", "1h", "4h"]
      .filter((label) => Number.isFinite(Number(snapshots[label]?.directionalPct)))
      .map((label) => `${label} ${Number(snapshots[label].directionalPct) >= 0 ? "+" : ""}${Number(snapshots[label].directionalPct).toFixed(2)}%`)
      .join(" | ") || "等待后续表现";
    items.push([
      `[实时] ${fmtDateTime(episode.updatedAt || episode.time)} · ${(episode.stages || [episode.type]).slice().reverse().map((type) => typeLabels[type] || type).join(" -> ")}`,
      `方向: ${plainDirection(episode)} | 证据: ${evidence.level || "待观察"} (${evidence.score ?? 0})`,
      `价格: ${fmtPrice(episode.price)} | 区域: ${fmtPrice(episode.zoneLow)} - ${fmtPrice(episode.zoneHigh)}`,
      `依据: ${(evidence.reasons || []).join("、") || "暂无充分猎杀证据"}`,
      `OI: ${Number.isFinite(Number(context.oiChangePct)) ? `${Number(context.oiChangePct).toFixed(2)}%` : "-"} | 强平: ${fmtUsd(context.liquidationUsd)} | 15分钟成交: ${fmtUsd(context.tradeVolumeUsd)}`,
      `后续: ${outcomes}`,
    ].join("\n"));
    rows.set(symbol, items);
  }
  const details = [...rows.entries()].map(([symbol, items], index) => `${index + 1}. ${symbol}\n${items.join("\n\n")}`).join("\n\n--------------------\n\n");
  return [
    `Matrix 关键区域每日复核`,
    `日期: ${dateKey}（北京时间）`,
    `关键区域记录: ${todayRecords.length} | 实时机会: ${todayEpisodes.length} | 去重标的: ${symbols.length}`,
    `说明: 顺向表现仅用于指标复核，不代表真实成交或交易收益。`,
    "",
    details || "今天暂时没有已记录的关键区域信号或实时事件。",
    "",
    `TradingView 自选列表（可单独复制导入）:`,
    symbols.join(",") || "-",
  ].join("\n");
}

async function downloadDailyReview() {
  els.dailyReviewBtn.disabled = true;
  const originalText = els.dailyReviewBtn.textContent;
  els.dailyReviewBtn.textContent = "聚合中";
  try {
    const [historyResponse, realtimeResponse] = await Promise.all([
      fetch("/api/reversal/history?limit=500", { cache: "no-store" }),
      fetch("/api/reversal/realtime?limit=500", { cache: "no-store" }),
    ]);
    const history = await historyResponse.json();
    const realtime = await realtimeResponse.json();
    if (!historyResponse.ok) throw new Error(history.error || "读取信号记录失败");
    if (!realtimeResponse.ok) throw new Error(realtime.error || "读取实时记录失败");
    const dateKey = shanghaiDateKey();
    const text = buildDailyReviewText(history.records || [], realtime.episodes || realtime.events || [], dateKey);
    const blob = new Blob(["\ufeff" + text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `matrix-key-zone-review-${dateKey}.txt`;
    link.click();
    URL.revokeObjectURL(url);
    els.historyStatus.textContent = `已生成 ${dateKey} 聚合文件`;
  } catch (error) {
    els.historyStatus.textContent = error.message;
  } finally {
    els.dailyReviewBtn.disabled = false;
    els.dailyReviewBtn.textContent = originalText;
  }
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

function fmtUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "-";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function renderRealtime(events) {
  if (!events.length) {
    els.realtimeBody.innerHTML = '<tr><td class="empty" colspan="6">监控已就绪，等待候选标的产生实时事件</td></tr>';
    return;
  }
  const typeLabels = { approaching: "接近", touched: "触及", swept: "穿透", reclaimed: "收回确认", "front-run": "未触及转向" };
  const evidenceLabels = { high: "高", medium: "中", low: "低", watch: "观察中", separate: "抢跑型" };
  els.realtimeBody.innerHTML = events.map((event) => {
    const context = event.context || {};
    const evidence = event.evidence || {};
    const snapshots = event.followUp?.snapshots || {};
    const resultText = snapshots["1h"]
      ? `1小时 ${Number(snapshots["1h"].directionalPct) >= 0 ? "+" : ""}${Number(snapshots["1h"].directionalPct).toFixed(2)}%`
      : snapshots["15m"]
        ? `15分钟 ${Number(snapshots["15m"].directionalPct) >= 0 ? "+" : ""}${Number(snapshots["15m"].directionalPct).toFixed(2)}%`
        : "等待后续表现";
    return `<tr>
      <td>${fmtDateTime(event.time)}</td>
      <td class="symbol">${tradingViewLink(event, true)}<small>${event.side === "support" ? "支撑" : "阻力"}</small></td>
      <td class="${event.type === "reclaimed" ? "positive" : ""}">${escapeHtml(typeLabels[event.type] || event.type)}<small>${event.eventCount > 1 ? `${event.eventCount} 个阶段` : ""}</small></td>
      <td><b>${fmtPrice(event.price)}</b><small>${fmtPrice(event.zoneLow)} - ${fmtPrice(event.zoneHigh)}</small></td>
      <td><b>${evidenceLabels[evidence.level] || "待观察"} · ${evidence.score ?? 0}</b><small>${escapeHtml((evidence.reasons || []).join("、") || "暂无充分证据")}</small></td>
      <td><b>${resultText}</b><small>OI ${Number.isFinite(Number(context.oiChangePct)) ? `${Number(context.oiChangePct).toFixed(2)}%` : "-"} · 强平 ${fmtUsd(context.liquidationUsd)}</small></td>
    </tr>`;
  }).join("");
}

function renderRealtimeSummary(summary = {}) {
  const followUp = summary.followUp || {};
  const fmtHorizon = (label) => {
    const row = followUp.horizons?.[label];
    if (!row?.samples) return ["-", "暂无完整样本"];
    const rate = `${(Number(row.positiveRate) * 100).toFixed(0)}%`;
    const average = Number(row.averageDirectionalPct);
    return [rate, `${row.samples} 个样本 · 平均 ${average >= 0 ? "+" : ""}${average.toFixed(2)}%`];
  };
  const cards = [
    ["收回确认", followUp.confirmed ?? 0, `${followUp.tracking ?? 0} 个跟踪中${followUp.legacyUntracked ? ` · ${followUp.legacyUntracked} 个旧记录` : ""}`],
    ["5 分钟顺向率", ...fmtHorizon("5m")],
    ["15 分钟顺向率", ...fmtHorizon("15m")],
    ["1 小时顺向率", ...fmtHorizon("1h")],
    ["4 小时顺向率", ...fmtHorizon("4h")],
    ["完成样本波动", followUp.completed ? `+${Number(followUp.averageMaxFavorablePct || 0).toFixed(2)}%` : "-", followUp.completed ? `${followUp.completed} 个 · 最大不利均值 ${Number(followUp.averageMaxAdversePct || 0).toFixed(2)}%` : "等待 4 小时样本"],
  ];
  els.realtimeSummary.innerHTML = cards.map(([label, value, detail]) => `<div><span>${label}</span><strong>${value}</strong><small>${detail}</small></div>`).join("");
}

async function loadRealtime() {
  try {
    const response = await fetch("/api/reversal/realtime?limit=50", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "读取失败");
    els.realtimeStatus.textContent = data.connected
      ? `在线 · ${data.monitoredSymbols || 0} 个标的 · ${data.candidateCount || 0} 个区域`
      : "等待实时监控进程";
    renderRealtimeSummary(data.summary);
    renderRealtime(data.episodes || data.events || []);
  } catch (error) {
    els.realtimeStatus.textContent = error.message;
    renderRealtimeSummary();
    renderRealtime([]);
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

function watchStateLabel(row) {
  if (row.status === "approaching") return "接近预警";
  if (["revisit", "second-touch"].includes(row.status)) return "重新进入";
  if (row.status === "error") return "读取失败";
  return "观察中";
}

function renderWatch() {
  const query = els.watchFilter.value.trim().toUpperCase();
  const filtered = query ? latestWatchRows.filter((row) =>
    [row.symbol, row.tradingViewSymbol, row.market, watchStateLabel(row), row.error]
      .some((value) => String(value || "").toUpperCase().includes(query))) : latestWatchRows;
  const visible = filtered.slice(0, watchVisibleLimit);
  els.watchStatus.textContent = query
    ? `匹配 ${filtered.length} 个 · 显示 ${visible.length} 个`
    : `共 ${latestWatchRows.length} 个 · 显示 ${visible.length} 个`;
  els.watchMoreBtn.hidden = visible.length >= filtered.length;
  if (!filtered.length) {
    els.watchBody.innerHTML = '<tr><td class="empty" colspan="7">没有观察标的</td></tr>';
    return;
  }
  els.watchBody.innerHTML = visible.map((row) => {
    const firstTouch = ["revisit", "second-touch", "approaching"].includes(row.status);
    const zone = row.zones?.[0];
    return `<tr>
      <td class="symbol">${tradingViewLink(row, true)}<small>${escapeHtml(row.symbol)}</small></td>
      <td>${escapeHtml(row.market)}</td>
      <td class="${firstTouch ? "positive" : ""}">${watchStateLabel(row)}</td>
      <td>${fmtPrice(row.current?.price)}</td>
      <td>${zone ? `${fmtPrice(zone.zoneLow)} - ${fmtPrice(zone.zoneHigh)}` : "-"}</td>
      <td>${zone ? `${zone.ageDays ?? zone.ageBars} ${zone.ageDays != null ? "天" : "根"}` : "-"}</td>
      <td>${escapeHtml(row.error || "-")}</td>
    </tr>`;
  }).join("");
}

function setWatchRows(rows) {
  latestWatchRows = Array.isArray(rows) ? rows : [];
  watchVisibleLimit = 80;
  renderWatch();
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
    setWatchRows(data.rows);
    await loadHistory();
  } catch (error) {
    if (error.name === "AbortError") return;
    els.status.textContent = error.message;
    latestSignals = [];
    els.manualPushBtn.disabled = true;
    els.manualPushStatus.textContent = "扫描失败";
    els.signalList.innerHTML = '<div class="emptySignal">扫描失败，请稍后重试</div>';
    setWatchRows([]);
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
els.dailyReviewBtn.addEventListener("click", downloadDailyReview);
els.statsBtn.addEventListener("click", loadStats);
els.watchFilter.addEventListener("input", () => {
  watchVisibleLimit = 80;
  renderWatch();
});
els.watchMoreBtn.addEventListener("click", () => {
  watchVisibleLimit += 100;
  renderWatch();
});
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
loadRealtime();
setInterval(loadRealtime, 30_000);
setInterval(scan, 2 * 60 * 60_000);
