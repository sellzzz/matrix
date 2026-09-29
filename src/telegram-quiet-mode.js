export function signalSetFingerprint(rows = []) {
  const keys = rows.map((row) => {
    const symbol = String(row?.symbol || "").trim().toUpperCase();
    const direction = Number(row?.changePct) < 0 ? "down" : "up";
    return symbol ? `${symbol}:${direction}` : "";
  }).filter(Boolean);
  return [...new Set(keys)].sort().join("|") || "none";
}

export function shouldNotifyRealtimeEvent(event, quietMode = true) {
  if (!quietMode) return true;
  return event?.type === "touched" || event?.type === "reclaimed";
}
