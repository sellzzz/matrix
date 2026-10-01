import { createHash } from "node:crypto";

export function realtimeZoneKey(event = {}) {
  return event.zoneKey || [event.symbol, event.side, event.originTime, event.zoneLow, event.zoneHigh].join(":");
}

export function mergeRealtimeLifecycle(current, event) {
  const stages = [];
  for (const type of [...(current?.stages || (current?.type ? [current.type] : [])), ...(event?.stages || (event?.type ? [event.type] : []))]) {
    if (type && !stages.includes(type)) stages.push(type);
  }
  return { ...(current || {}), ...(event || {}), stages };
}

export function canSendAutomatedPush(lastSentAt, minimumIntervalMs, now = Date.now()) {
  const previous = new Date(lastSentAt || 0).getTime();
  return !Number.isFinite(previous) || now - previous >= minimumIntervalMs;
}

export function periodicSummaryFingerprint(signalData = {}, smallCapData = {}) {
  const identity = (row) => [
    String(row?.symbol || "").toUpperCase(),
    Number(row?.changePct) >= 0 ? "up" : "down",
  ].join(":");
  const payload = {
    position: (Array.isArray(signalData.alerts) ? signalData.alerts : []).map(identity).sort(),
    lowCap: (Array.isArray(smallCapData.smallCaps) ? smallCapData.smallCaps : []).map(identity).sort(),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
