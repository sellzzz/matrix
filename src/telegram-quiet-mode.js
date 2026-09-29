export function shouldNotifyRealtimeEvent(event, quietMode = true) {
  if (!quietMode) return true;
  return event?.type === "touched" || event?.type === "reclaimed";
}
