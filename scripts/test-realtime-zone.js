import assert from "node:assert/strict";
import { createZoneRuntime, processZonePrice, summarizeEvidence } from "../src/realtime-zone-engine.js";

const resistance = { symbol: "TESTUSDT", side: "resistance", zoneLow: 100, zoneHigh: 102, originTime: 1 };
const runtime = createZoneRuntime(resistance);
assert.equal(processZonePrice(runtime, 98.9, 1_000)[0].type, "approaching");
assert.equal(processZonePrice(runtime, 101, 2_000)[0].type, "touched");
assert.equal(processZonePrice(runtime, 103, 3_000).length, 0);
const reclaimed = processZonePrice(runtime, 99.8, 20_000)[0];
assert.equal(reclaimed.type, "reclaimed");
assert.equal(summarizeEvidence(runtime, { ...reclaimed, oiChangePct: -2, shortLiquidationUsd: 10_000, tradeVolumeUsd: 100_000 }).level, "high");

const support = createZoneRuntime({ symbol: "SUPPORTUSDT", side: "support", zoneLow: 10, zoneHigh: 11, originTime: 2 });
assert.equal(processZonePrice(support, 11.1, 1_000)[0].type, "approaching");
assert.equal(processZonePrice(support, 9.9, 2_000)[0].type, "swept");
assert.equal(processZonePrice(support, 11.1, 10_000)[0].type, "reclaimed");

console.log("realtime zone engine tests passed");
