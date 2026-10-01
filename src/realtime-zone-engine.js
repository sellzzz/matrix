const MINUTE_MS = 60_000;
const ACCEPTANCE_HOLD_MS = 3 * MINUTE_MS;
const ACCEPTANCE_BUFFER = 0.003;

export function candidateKey(candidate) {
  return [candidate.symbol, candidate.side, candidate.originTime, candidate.zoneLow, candidate.zoneHigh].join(":");
}

export function distanceFromZonePct(price, candidate) {
  const value = Number(price);
  const low = Number(candidate.zoneLow);
  const high = Number(candidate.zoneHigh);
  if (![value, low, high].every(Number.isFinite) || value <= 0) return Infinity;
  if (value < low) return ((low - value) / value) * 100;
  if (value > high) return ((value - high) / value) * 100;
  return 0;
}

export function directionalReturnPct(side, entryPrice, currentPrice) {
  const entry = Number(entryPrice);
  const current = Number(currentPrice);
  if (![entry, current].every(Number.isFinite) || entry <= 0) return null;
  const raw = ((current - entry) / entry) * 100;
  return side === "support" ? raw : -raw;
}

export function groupZoneEvents(events = []) {
  const episodeMap = new Map();
  const sorted = [...events].sort((a, b) => Number(b?.time || 0) - Number(a?.time || 0));
  for (const event of sorted) {
    const key = event.zoneKey || [event.symbol, event.side, event.originTime, event.zoneLow, event.zoneHigh].join(":");
    const episode = episodeMap.get(key);
    if (!episode) {
      episodeMap.set(key, {
        ...event,
        zoneKey: key,
        startedAt: event.time,
        updatedAt: event.time,
        stages: [event.type],
        eventCount: 1,
      });
      continue;
    }
    episode.startedAt = Math.min(episode.startedAt, event.time);
    episode.updatedAt = Math.max(episode.updatedAt, event.time);
    episode.eventCount += 1;
    if (!episode.stages.includes(event.type)) episode.stages.push(event.type);
    if (!episode.followUp && event.followUp) episode.followUp = event.followUp;
    if (Number(event.evidence?.score || 0) > Number(episode.evidence?.score || 0)) episode.evidence = event.evidence;
  }
  for (const episode of episodeMap.values()) {
    if (episode.stages.includes("reclaimed")) episode.evidence = { ...episode.evidence, stage: "confirmed" };
    else if (episode.stages.includes("accepted")) {
      episode.evidence = {
        score: 0,
        level: "invalidated",
        stage: "invalidated",
        reasons: ["持续运行在区域外侧，原区域失效"],
      };
    }
    else if (episode.stages.includes("front-run")) episode.evidence = { ...episode.evidence, stage: "front-run" };
  }
  return [...episodeMap.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function summarizeFollowUpEpisodes(episodes = []) {
  const confirmed = episodes.filter((episode) => episode.stages?.includes("reclaimed"));
  const tracked = confirmed.filter((episode) => episode.followUp);
  const horizons = {};
  for (const label of ["5m", "15m", "1h", "4h"]) {
    const values = confirmed
      .map((episode) => Number(episode.followUp?.snapshots?.[label]?.directionalPct))
      .filter(Number.isFinite);
    const positive = values.filter((value) => value > 0).length;
    horizons[label] = {
      samples: values.length,
      positive,
      positiveRate: values.length ? positive / values.length : null,
      averageDirectionalPct: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
    };
  }
  const completed = confirmed.filter((episode) => episode.followUp?.snapshots?.["4h"]);
  const average = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  return {
    confirmed: confirmed.length,
    tracking: tracked.filter((episode) => !episode.followUp?.snapshots?.["4h"]).length,
    legacyUntracked: confirmed.length - tracked.length,
    completed: completed.length,
    averageMaxFavorablePct: average(completed.map((episode) => Number(episode.followUp?.maxFavorablePct)).filter(Number.isFinite)),
    averageMaxAdversePct: average(completed.map((episode) => Number(episode.followUp?.maxAdversePct)).filter(Number.isFinite)),
    horizons,
  };
}

export function createZoneRuntime(candidate) {
  return {
    candidate,
    key: candidateKey(candidate),
    phase: "armed",
    closestDistancePct: Infinity,
    approachAt: null,
    touchAt: null,
    touchPrice: null,
    maximumPenetrationPct: 0,
    outsideSince: null,
    lastPrice: Number(candidate.currentPrice) || null,
    lastEventAt: 0,
  };
}

function penetrationPct(price, candidate) {
  if (candidate.side === "support" && price < candidate.zoneLow) {
    return ((candidate.zoneLow - price) / candidate.zoneLow) * 100;
  }
  if (candidate.side === "resistance" && price > candidate.zoneHigh) {
    return ((price - candidate.zoneHigh) / candidate.zoneHigh) * 100;
  }
  return 0;
}

function event(runtime, type, price, at, extra = {}) {
  runtime.lastEventAt = at;
  return {
    type,
    symbol: runtime.candidate.symbol,
    side: runtime.candidate.side,
    price,
    time: at,
    zoneLow: runtime.candidate.zoneLow,
    zoneHigh: runtime.candidate.zoneHigh,
    originTime: runtime.candidate.originTime,
    tradingViewSymbol: runtime.candidate.tradingViewSymbol,
    chartUrl: runtime.candidate.chartUrl,
    ...extra,
  };
}

export function processZonePrice(runtime, rawPrice, at = Date.now()) {
  const price = Number(rawPrice);
  if (!Number.isFinite(price) || price <= 0) return [];
  const candidate = runtime.candidate;
  const distancePct = distanceFromZonePct(price, candidate);
  runtime.closestDistancePct = Math.min(runtime.closestDistancePct, distancePct);
  runtime.lastPrice = price;
  const events = [];

  if (runtime.phase === "armed" && distancePct <= 1.2) {
    runtime.phase = "approaching";
    runtime.approachAt = at;
    events.push(event(runtime, "approaching", price, at, { distancePct }));
  }

  const inside = price >= candidate.zoneLow && price <= candidate.zoneHigh;
  const penetration = penetrationPct(price, candidate);
  if (["armed", "approaching"].includes(runtime.phase) && (inside || penetration > 0)) {
    runtime.phase = penetration > 0 ? "swept" : "touched";
    runtime.touchAt = at;
    runtime.touchPrice = price;
    runtime.maximumPenetrationPct = penetration;
    events.push(event(runtime, runtime.phase, price, at, { distancePct: 0, penetrationPct: penetration }));
  } else if (["touched", "swept"].includes(runtime.phase)) {
    const previousPhase = runtime.phase;
    runtime.maximumPenetrationPct = Math.max(runtime.maximumPenetrationPct, penetration);
    if (penetration > 0) {
      runtime.phase = "swept";
      if (previousPhase === "touched") {
        events.push(event(runtime, "swept", price, at, { penetrationPct: penetration }));
      }
    }
  }

  const reclaimBuffer = 0.001;
  const reclaimed = runtime.touchAt && (
    (candidate.side === "support" && price >= candidate.zoneHigh * (1 + reclaimBuffer))
    || (candidate.side === "resistance" && price <= candidate.zoneLow * (1 - reclaimBuffer))
  );
  if (["touched", "swept"].includes(runtime.phase) && reclaimed) {
    const reclaimSeconds = Math.round((at - runtime.touchAt) / 1000);
    runtime.phase = "reclaimed";
    events.push(event(runtime, "reclaimed", price, at, {
      reclaimSeconds,
      penetrationPct: runtime.maximumPenetrationPct,
    }));
  }

  const acceptedBeyond = candidate.side === "support"
    ? price <= candidate.zoneLow * (1 - ACCEPTANCE_BUFFER)
    : price >= candidate.zoneHigh * (1 + ACCEPTANCE_BUFFER);
  if (runtime.phase === "swept") {
    if (acceptedBeyond) runtime.outsideSince ||= at;
    else runtime.outsideSince = null;
    if (runtime.outsideSince && at - runtime.outsideSince >= ACCEPTANCE_HOLD_MS) {
      runtime.phase = "accepted";
      events.push(event(runtime, "accepted", price, at, {
        holdSeconds: Math.round((at - runtime.outsideSince) / 1000),
        penetrationPct: runtime.maximumPenetrationPct,
      }));
    }
  }

  const movedAway = distancePct >= runtime.closestDistancePct + 1;
  const recentApproach = runtime.approachAt && at - runtime.approachAt <= 15 * MINUTE_MS;
  if (runtime.phase === "approaching" && runtime.closestDistancePct <= 0.6 && movedAway && recentApproach) {
    runtime.phase = "front-run";
    events.push(event(runtime, "front-run", price, at, {
      closestDistancePct: runtime.closestDistancePct,
    }));
  }

  return events;
}

export function summarizeEvidence(runtime, context = {}, eventType = runtime.phase) {
  if (eventType === "approaching") {
    return { score: 0, level: "watch", stage: "watching", reasons: ["等待触及或转向"] };
  }
  if (eventType === "front-run") {
    return { score: 0, level: "separate", stage: "front-run", reasons: ["未触及区域，单独统计"] };
  }
  if (eventType === "accepted") {
    return { score: 0, level: "invalidated", stage: "invalidated", reasons: ["持续运行在区域外侧，原区域失效"] };
  }
  const reclaimSeconds = Number(context.reclaimSeconds);
  const penetrationPct = Number(context.penetrationPct ?? runtime.maximumPenetrationPct);
  const oiChangePct = Number(context.oiChangePct);
  const liquidationUsd = Number(runtime.candidate.side === "support"
    ? context.longLiquidationUsd
    : context.shortLiquidationUsd) || 0;
  const tradeVolumeUsd = Number(context.tradeVolumeUsd || 0);
  let score = 0;
  const reasons = [];

  if (eventType === "reclaimed" && reclaimSeconds <= 120) { score += 2; reasons.push("快速收回"); }
  else if (eventType === "reclaimed" && reclaimSeconds <= 600) { score += 1; reasons.push("完成收回"); }
  if (penetrationPct >= 0.1 && penetrationPct <= 3) { score += 1; reasons.push("有效穿透"); }
  if (oiChangePct <= -1) { score += 2; reasons.push("持仓量下降"); }
  if (liquidationUsd > 0 && liquidationUsd / Math.max(tradeVolumeUsd, 1) >= 0.03) {
    score += 2;
    reasons.push("出现强平");
  }
  const sweepAggressor = runtime.candidate.side === "support" ? "sell" : "buy";
  if (Number(context.tradeImbalancePct) >= 25 && context.aggressiveSide === sweepAggressor) {
    score += 1;
    reasons.push("扫单方向成交偏斜");
  }

  return {
    score,
    level: score >= 5 ? "high" : score >= 3 ? "medium" : "low",
    stage: eventType === "reclaimed" ? "confirmed" : "developing",
    reasons,
  };
}
