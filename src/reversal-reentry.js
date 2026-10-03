function candleTime(candle) {
  return Number(candle?.timestamp ?? candle?.time);
}

function zoneBounds(zone) {
  return {
    low: Number(zone?.zoneLow ?? zone?.low),
    high: Number(zone?.zoneHigh ?? zone?.high),
  };
}

export function isSafeDeparture(candle, zone, rearmDistancePct = 3) {
  const close = Number(candle?.close);
  const { low, high } = zoneBounds(zone);
  const buffer = Math.max(0, Number(rearmDistancePct) || 0) / 100;
  if (!Number.isFinite(close) || !Number.isFinite(low) || !Number.isFinite(high)) return false;
  return zone.side === "support"
    ? close >= high * (1 + buffer)
    : close <= low * (1 - buffer);
}

export function hasSafeDeparture(candles, fromTime, toTime, zone, rearmDistancePct = 3) {
  return candles.some((candle) => {
    const time = candleTime(candle);
    return Number.isFinite(time)
      && time > fromTime
      && time < toTime
      && isSafeDeparture(candle, zone, rearmDistancePct);
  });
}

export function canRearmZone(candles, zone, fromTime, toTime, options = {}) {
  if (!Number.isFinite(fromTime)) return true;
  const cooldownMs = Math.max(0, Number(options.cooldownMs) || 0);
  const rearmDistancePct = Math.max(0, Number(options.rearmDistancePct) || 0);
  return Number.isFinite(toTime)
    && toTime - fromTime >= cooldownMs
    && hasSafeDeparture(candles, fromTime, toTime, zone, rearmDistancePct);
}

export function selectRearmedEntries(entries, candles, zone, options = {}) {
  const sorted = entries
    .filter((entry) => Number.isFinite(candleTime(entry)))
    .slice()
    .sort((a, b) => candleTime(a) - candleTime(b));
  const baselineTime = Number(options.baselineTime);
  let anchorTime = Number.isFinite(baselineTime) ? baselineTime : null;
  const selected = [];

  for (const entry of sorted) {
    const time = candleTime(entry);
    if (Number.isFinite(anchorTime) && time <= anchorTime) continue;
    if (Number.isFinite(anchorTime) && !canRearmZone(candles, zone, anchorTime, time, options)) continue;
    selected.push(entry);
    anchorTime = time;
  }

  return selected;
}
