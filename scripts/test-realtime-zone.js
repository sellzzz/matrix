import assert from "node:assert/strict";
import { createZoneRuntime, directionalReturnPct, groupZoneEvents, processZonePrice, summarizeEvidence, summarizeFollowUpEpisodes } from "../src/realtime-zone-engine.js";

const resistance = { symbol: "TESTUSDT", side: "resistance", zoneLow: 100, zoneHigh: 102, originTime: 1 };
const runtime = createZoneRuntime(resistance);
const approaching = processZonePrice(runtime, 98.9, 1_000)[0];
assert.equal(approaching.type, "approaching");
assert.equal(summarizeEvidence(runtime, {}, approaching.type).level, "watch");
assert.equal(processZonePrice(runtime, 101, 2_000)[0].type, "touched");
assert.equal(processZonePrice(runtime, 103, 3_000).length, 0);
const reclaimed = processZonePrice(runtime, 99.8, 20_000)[0];
assert.equal(reclaimed.type, "reclaimed");
assert.equal(summarizeEvidence(runtime, { ...reclaimed, oiChangePct: -2, shortLiquidationUsd: 10_000, tradeVolumeUsd: 100_000 }).level, "high");

const support = createZoneRuntime({ symbol: "SUPPORTUSDT", side: "support", zoneLow: 10, zoneHigh: 11, originTime: 2 });
assert.equal(processZonePrice(support, 11.1, 1_000)[0].type, "approaching");
assert.equal(processZonePrice(support, 9.9, 2_000)[0].type, "swept");
assert.equal(processZonePrice(support, 11.1, 10_000)[0].type, "reclaimed");
assert.equal(directionalReturnPct("support", 100, 105), 5);
assert.equal(directionalReturnPct("resistance", 100, 95), 5);

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

console.log("realtime zone engine tests passed");
