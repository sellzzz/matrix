import assert from "node:assert/strict";
import { createZoneRuntime, directionalReturnPct, groupZoneEvents, processZonePrice, summarizeEvidence, summarizeFollowUpEpisodes } from "../src/realtime-zone-engine.js";
import { canRearmZone, isSafeDeparture, selectRearmedEntries } from "../src/reversal-reentry.js";
import { shouldNotifyRealtimeEvent } from "../src/telegram-quiet-mode.js";
import { canSendAutomatedPush, mergeRealtimeLifecycle, periodicSummaryFingerprint, realtimeZoneKey } from "../src/telegram-push-policy.js";

const resistance = { symbol: "TESTUSDT", side: "resistance", zoneLow: 100, zoneHigh: 102, originTime: 1 };
const runtime = createZoneRuntime(resistance);
const approaching = processZonePrice(runtime, 98.9, 1_000)[0];
assert.equal(approaching.type, "approaching");
assert.equal(summarizeEvidence(runtime, {}, approaching.type).level, "watch");
assert.equal(processZonePrice(runtime, 101, 2_000)[0].type, "touched");
assert.equal(processZonePrice(runtime, 103, 3_000)[0].type, "swept");
const reclaimed = processZonePrice(runtime, 99.8, 20_000)[0];
assert.equal(reclaimed.type, "reclaimed");
assert.equal(summarizeEvidence(runtime, { ...reclaimed, oiChangePct: -2, shortLiquidationUsd: 10_000, tradeVolumeUsd: 100_000 }).level, "high");

const support = createZoneRuntime({ symbol: "SUPPORTUSDT", side: "support", zoneLow: 10, zoneHigh: 11, originTime: 2 });
assert.equal(processZonePrice(support, 11.1, 1_000)[0].type, "approaching");
assert.equal(processZonePrice(support, 9.9, 2_000)[0].type, "swept");
assert.equal(processZonePrice(support, 11.1, 10_000)[0].type, "reclaimed");
assert.equal(directionalReturnPct("support", 100, 105), 5);
assert.equal(directionalReturnPct("resistance", 100, 95), 5);

const breakout = createZoneRuntime({ symbol: "BREAKUSDT", side: "resistance", zoneLow: 100, zoneHigh: 102, originTime: 3 });
assert.equal(processZonePrice(breakout, 98.9, 500)[0].type, "approaching");
assert.equal(processZonePrice(breakout, 101, 1_000)[0].type, "touched");
assert.equal(processZonePrice(breakout, 103, 2_000)[0].type, "swept");
assert.equal(processZonePrice(breakout, 103.5, 181_000).length, 0);
const accepted = processZonePrice(breakout, 104, 182_000)[0];
assert.equal(accepted.type, "accepted");
assert.equal(summarizeEvidence(breakout, accepted, accepted.type).stage, "invalidated");

const grouped = groupZoneEvents([
  { zoneKey: "zone-1", symbol: "TESTUSDT", side: "resistance", type: "touched", time: 1_000, evidence: { score: 1, level: "low" } },
  { zoneKey: "zone-1", symbol: "TESTUSDT", side: "resistance", type: "reclaimed", time: 2_000, evidence: { score: 5, level: "high" }, followUp: { maxFavorablePct: 4, maxAdversePct: 1, snapshots: { "5m": { directionalPct: 2 }, "4h": { directionalPct: -1 } } } },
]);
assert.equal(grouped.length, 1);
assert.deepEqual(grouped[0].stages, ["reclaimed", "touched"]);
assert.equal(grouped[0].followUp.snapshots["5m"].directionalPct, 2);
const followUp = summarizeFollowUpEpisodes(grouped);
assert.equal(followUp.confirmed, 1);
assert.equal(followUp.completed, 1);
assert.equal(followUp.tracking, 0);
assert.equal(followUp.legacyUntracked, 0);
assert.equal(followUp.horizons["5m"].positiveRate, 1);
assert.equal(followUp.horizons["4h"].positiveRate, 0);
assert.equal(followUp.averageMaxFavorablePct, 4);
const legacyFollowUp = summarizeFollowUpEpisodes([{ stages: ["reclaimed"] }]);
assert.equal(legacyFollowUp.tracking, 0);
assert.equal(legacyFollowUp.legacyUntracked, 1);
const invalidatedEpisode = groupZoneEvents([{ zoneKey: "zone-2", type: "accepted", time: 3_000, evidence: { score: 0, level: "separate" } }])[0];
assert.equal(invalidatedEpisode.evidence.stage, "invalidated");
assert.equal(invalidatedEpisode.evidence.level, "invalidated");

assert.equal(shouldNotifyRealtimeEvent({ type: "approaching" }), false);
assert.equal(shouldNotifyRealtimeEvent({ type: "touched" }), true);
assert.equal(shouldNotifyRealtimeEvent({ type: "swept" }), false);
assert.equal(shouldNotifyRealtimeEvent({ type: "reclaimed" }), true);
assert.equal(shouldNotifyRealtimeEvent({ type: "accepted" }), true);
assert.equal(shouldNotifyRealtimeEvent({ type: "front-run" }), false);
assert.equal(shouldNotifyRealtimeEvent({ type: "approaching" }, false), true);

const lifecycle = mergeRealtimeLifecycle(
  { zoneKey: "zone-3", type: "touched", stages: ["touched"], time: 1_000 },
  { zoneKey: "zone-3", type: "reclaimed", evidence: { level: "high" }, time: 2_000 },
);
assert.deepEqual(lifecycle.stages, ["touched", "reclaimed"]);
assert.equal(lifecycle.type, "reclaimed");
assert.equal(realtimeZoneKey(lifecycle), "zone-3");
assert.equal(canSendAutomatedPush("2026-10-01T00:00:00.000Z", 600_000, Date.parse("2026-10-01T00:09:59.999Z")), false);
assert.equal(canSendAutomatedPush("2026-10-01T00:00:00.000Z", 600_000, Date.parse("2026-10-01T00:10:00.000Z")), true);
assert.equal(canSendAutomatedPush(null, 600_000, Date.parse("2026-10-01T00:00:00.000Z")), true);
assert.equal(
  periodicSummaryFingerprint({ alerts: [{ symbol: "BTCUSDT", changePct: 10 }] }, { smallCaps: [] }),
  periodicSummaryFingerprint({ alerts: [{ symbol: "BTCUSDT", changePct: 20 }] }, { smallCaps: [] }),
);
assert.notEqual(
  periodicSummaryFingerprint({ alerts: [{ symbol: "BTCUSDT", changePct: 10 }] }, { smallCaps: [] }),
  periodicSummaryFingerprint({ alerts: [{ symbol: "ETHUSDT", changePct: 10 }] }, { smallCaps: [] }),
);

const day = 24 * 60 * 60 * 1000;
const reentryZone = { side: "support", zoneLow: 9.8, zoneHigh: 10 };
const reentryCandles = [
  { timestamp: 0, close: 10.2 },
  { timestamp: 1 * day, close: 10.1 },
  { timestamp: 2 * day, close: 10.4 },
  { timestamp: 6 * day, close: 10.2 },
  { timestamp: 8 * day, close: 10.1 },
  { timestamp: 12 * day, close: 10.5 },
  { timestamp: 16 * day, close: 10.1 },
];
const reentryOptions = { cooldownMs: 7 * day, rearmDistancePct: 3 };
assert.equal(isSafeDeparture(reentryCandles[2], reentryZone, 3), true);
assert.equal(canRearmZone(reentryCandles, reentryZone, 1 * day, 6 * day, reentryOptions), false);
assert.equal(canRearmZone(reentryCandles, reentryZone, 1 * day, 8 * day, reentryOptions), true);
assert.equal(canRearmZone([
  { timestamp: 1 * day, close: 10.1 },
  { timestamp: 5 * day, close: 10.2 },
  { timestamp: 9 * day, close: 10.1 },
], reentryZone, 1 * day, 9 * day, reentryOptions), false);
assert.deepEqual(
  selectRearmedEntries(
    [reentryCandles[1], reentryCandles[3], reentryCandles[4], reentryCandles[6]],
    reentryCandles,
    reentryZone,
    reentryOptions,
  ).map((entry) => entry.timestamp),
  [1 * day, 8 * day, 16 * day],
);
assert.deepEqual(
  selectRearmedEntries([reentryCandles[3], reentryCandles[4]], reentryCandles, reentryZone, {
    ...reentryOptions,
    baselineTime: 0,
  }).map((entry) => entry.timestamp),
  [8 * day],
);
const resistanceReentryZone = { side: "resistance", zoneLow: 100, zoneHigh: 102 };
assert.equal(isSafeDeparture({ close: 96.9 }, resistanceReentryZone, 3), true);
assert.equal(isSafeDeparture({ close: 97.1 }, resistanceReentryZone, 3), false);

console.log("realtime zone engine tests passed");
