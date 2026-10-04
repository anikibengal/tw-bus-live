// 核心邏輯測試：node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../web/core.js");

// 合成路線：往東 10 km 的直線，每 1 km 一站，末班 22:10
const LON0 = 121.5, LAT0 = 25.05, KX = 111320 * Math.cos(LAT0 * Math.PI / 180);
const lonAt = (km) => LON0 + (km * 1000) / KX;
const VARIANT = {
  subRouteId: "900", routeId: "90", direction: 0, label: "測試",
  lastDeparture: { sun: "22:10", mon: "22:10", tue: "22:10", wed: "22:10", thu: "22:10", fri: "22:10", sat: "22:10" },
  shape: [[LON0, LAT0], [lonAt(10), LAT0]],
  stops: Array.from({ length: 11 }, (_, i) => ({ id: String(1000 + i), name: `站${i}`, km: i })),
};
const T = (hhmm, day = "2026-10-03") => C.parseTpe(`${day} ${hhmm}:00`);   // 2026-10-03 是週六
const fix = (id, km, hhmm, extra = {}) => ({
  BusID: id, RouteID: "900", GoBack: "0", Longitude: String(lonAt(km)), Latitude: String(LAT0 + (extra.offDeg || 0)),
  Speed: "20", DataTime: `2026-10-03 ${hhmm}:00`, DutyStatus: extra.duty || "1", BusStatus: "0",
});
function trackerWith(fixesByTime) {
  const tr = C.createTracker([VARIANT]);
  for (const [hhmm, fixes] of fixesByTime) C.ingestBusData(tr, { BusInfo: fixes }, T(hhmm));
  return tr;
}

test("營運日：凌晨 00:30 算前一天（週六）", () => {
  const sd = C.serviceDay(T("00:30", "2026-10-04"));
  assert.equal(sd.dayKey, "sat");
  assert.equal(C.fmtTime(sd.start), "00:00");
  assert.equal(C.lastDepartureMs(VARIANT, T("00:30", "2026-10-04")), T("22:10"));
  assert.equal(C.lastDepartureMs({ lastDeparture: { sat: "24:20" } }, T("23:00")), T("00:20", "2026-10-04"));
  assert.equal(C.lastDepartureMs(VARIANT, T("09:00"), "09:30"), T("09:30"));
});

test("兩種時間格式都解析成台北時間", () => {
  assert.equal(C.parseTpe("2026/10/03 22:10:00"), C.parseTpe("2026-10-03 22:10:00"));
  assert.equal(C.fmtTime(C.parseTpe("2026-10-03 22:10:00")), "22:10");
});

test("末班時刻前：尚未發車", () => {
  const tr = trackerWith([["21:50", [fix("A", 3, "21:50")]]]);
  assert.equal(C.identifyLastBus(tr, "900", T("21:50")).state, "not_departed");
});

test("寬限期內，最後面那台在 21:58 就離站 → 末班車還沒出發", () => {
  const tr = trackerWith([["21:57", [fix("A", 0.1, "21:57")]], ["21:58", [fix("A", 0.5, "21:58")]], ["22:12", [fix("A", 4, "22:12")]]]);
  const r = C.identifyLastBus(tr, "900", T("22:12"));
  assert.equal(r.state, "not_departed");
});

test("寬限期內，看到 22:11 離站的車 → 行駛中、高信心", () => {
  const tr = trackerWith([["22:10", [fix("B", 0.1, "22:10")]], ["22:11", [fix("B", 0.6, "22:11")]], ["22:13", [fix("B", 1.5, "22:13")]]]);
  const r = C.identifyLastBus(tr, "900", T("22:13"));
  assert.equal(r.state, "running");
  assert.equal(r.bus, "B");
  assert.equal(r.confidence, "high");
});

test("開頁太晚沒看到離站，但位置合理 → 行駛中、中信心", () => {
  const tr = trackerWith([["22:15", [fix("B", 2, "22:15")]]]);
  const r = C.identifyLastBus(tr, "900", T("22:15"));
  assert.equal(r.state, "running");
  assert.equal(r.confidence, "medium");
});

test("寬限期後，最後面那台早就離站 → 仍採用但標低信心", () => {
  const tr = trackerWith([["21:57", [fix("A", 0.1, "21:57")]], ["21:58", [fix("A", 0.5, "21:58")]], ["22:30", [fix("A", 7, "22:30")]]]);
  const r = C.identifyLastBus(tr, "900", T("22:30"));
  assert.equal(r.state, "running");
  assert.equal(r.confidence, "low");
});

test("之前認定的車開到終點，但後面還有營運車 → 不能宣告收班", () => {
  const tr = trackerWith([["22:40", [fix("A", 9.8, "22:40"), fix("B", 5, "22:40")]]]);
  const memo = { busId: "A", maxKm: 9.8, lastKm: 9.8 };
  const r = C.identifyLastBus(tr, "900", T("22:40"), null, memo);
  assert.equal(r.state, "running");
  assert.equal(r.bus, "B");
});

test("認定的末班車開到終點、路上沒別的車 → 收班", () => {
  const tr = trackerWith([["22:40", [fix("B", 9.8, "22:40")]]]);
  const r = C.identifyLastBus(tr, "900", T("22:40"), null, { busId: "B", maxKm: 9.8, lastKm: 9.8 });
  assert.equal(r.state, "finished");
});

test("末班車在路線中段失去定位 → 定位中斷，不宣告收班", () => {
  const tr = trackerWith([["22:20", [fix("B", 4, "22:20")]]]);
  const r = C.identifyLastBus(tr, "900", T("22:40"), null, { busId: "B", maxKm: 4, lastKm: 4 });
  assert.equal(r.state, "unknown");
  assert.equal(r.km, 4);
  const est = C.estimateStops(tr, "900", r, null, T("22:40"));
  assert.ok(est[3].passed && !est[6].passed);
  assert.equal(est[6].best, null, "定位中斷時不硬算到站時刻");
});

test("候選車排除：結束勤務、偏離路線、定位過期、在終點區", () => {
  const tr = trackerWith([["22:30", [
    fix("D2", 3, "22:30", { duty: "2" }),
    fix("OFF", 4, "22:30", { offDeg: 0.003 }),         // 約 330 m 外
    fix("END", 9.9, "22:30"),
    fix("OLD", 2, "22:20"),
    fix("OK", 6, "22:30"),
  ]]]);
  const r = C.identifyLastBus(tr, "900", T("22:30"));
  assert.equal(r.bus, "OK");
});

test("均速推估：沒有任何速度資料時用預設 18 km/h", () => {
  const tr = trackerWith([["22:30", [fix("B", 3, "22:30")]]]);
  const r = C.identifyLastBus(tr, "900", T("22:30"));
  const est = C.estimateStops(tr, "900", r, null, T("22:30"));
  assert.ok(est[2].passed && !est[4].passed);
  assert.equal(est[6].best.source, "預設");
  assert.equal(C.fmtTime(est[6].best.ms), "22:40");                // 3 km ÷ 18 km/h = 10 分
});

test("前車段速：前車剛以 30 km/h 跑過 → 用前車", () => {
  const tr = trackerWith([
    ["22:18", [fix("A", 3, "22:18")]], ["22:20", [fix("A", 4, "22:20")]], ["22:22", [fix("A", 5, "22:22")]],
    ["22:24", [fix("A", 6, "22:24")]], ["22:26", [fix("A", 7, "22:26"), fix("B", 3, "22:26")]],
  ]);
  const r = C.identifyLastBus(tr, "900", T("22:26"));
  assert.equal(r.bus, "B");
  const est = C.estimateStops(tr, "900", r, null, T("22:26"));
  assert.equal(est[6].best.source, "前車");
  assert.equal(C.fmtTime(est[6].best.ms), "22:32");                // 3 km × 2 分/km
  assert.equal(est[6].pace.coverage, 1);
});

test("官方預估：中間沒有別台車才採用；-3 視為已過", () => {
  const tr = trackerWith([["22:26", [fix("A", 7, "22:26"), fix("B", 3, "22:26")]]]);
  const r = C.identifyLastBus(tr, "900", T("22:26"));
  const eta = { updateMs: T("22:26"), map: new Map([
    ["90|0|1005", 300],   // 站5：B 與站5 之間沒有車 → 採用
    ["90|0|1009", 120],   // 站9：A 在中間 → 這是 A 的預估，不採用
    ["90|0|1006", -3],
  ]) };
  const est = C.estimateStops(tr, "900", r, eta, T("22:26"));
  assert.equal(est[5].best.source, "官方");
  assert.equal(C.fmtTime(est[5].best.ms), "22:31");
  assert.notEqual(est[9].best.source, "官方");
  assert.equal(est[6].passed, true);
  assert.equal(est[6].passedBy, "官方-3");
});

test("官方預估之後的站接續推算：以最後一個有效官方預估為錨點，時刻不倒退", () => {
  const tr = trackerWith([["22:26", [fix("A", 7.5, "22:26"), fix("B", 3, "22:26")]]]);
  const r = C.identifyLastBus(tr, "900", T("22:26"));
  // 官方說站4 在 22:40 才到（比預設 18 km/h 慢很多）；站8 以後被 A 擋住
  const eta = { updateMs: T("22:26"), map: new Map([["90|0|1004", 14 * 60], ["90|0|1008", 60]]) };
  const est = C.estimateStops(tr, "900", r, eta, T("22:26"));
  assert.equal(est[4].best.source, "官方");
  assert.equal(C.fmtTime(est[4].best.ms), "22:40");
  assert.equal(est[5].best.source, "官方→預設");
  assert.equal(C.fmtTime(est[5].best.ms), "22:43");                // 22:40 + 1 km ÷ 18 km/h ≈ 3.3 分
  assert.notEqual(est[8].best.source, "官方");                     // A 在中間：官方的 60 秒是 A 的
  const times = est.filter((x) => x.best).map((x) => x.best.ms);
  assert.deepEqual(times, [...times].sort((a, b) => a - b), "推估時刻沿路線不倒退");
});

test("官方預估前後矛盾（後一站比前一站早）時，時刻仍不倒退", () => {
  const tr = trackerWith([["22:26", [fix("B", 3, "22:26")]]]);
  const r = C.identifyLastBus(tr, "900", T("22:26"));
  const eta = { updateMs: T("22:26"), map: new Map([["90|0|1004", 14 * 60], ["90|0|1005", 12 * 60]]) };
  const est = C.estimateStops(tr, "900", r, eta, T("22:26"));
  assert.equal(C.fmtTime(est[4].best.ms), "22:40");
  assert.ok(est[5].best.ms >= est[4].best.ms, "站5 不能比站4 早");
});

test("熄燈前沿：依各站推估時刻內插", () => {
  const tr = trackerWith([["22:30", [fix("B", 3, "22:30")]]]);
  const r = C.identifyLastBus(tr, "900", T("22:30"));
  const est = C.estimateStops(tr, "900", r, null, T("22:30"));
  assert.ok(Math.abs(C.frontKmAt(est, r, T("22:30"), T("22:30"), 10) - 3) < 0.01);
  assert.ok(Math.abs(C.frontKmAt(est, r, T("22:30"), T("22:40"), 10) - 6) < 0.01);
  assert.equal(C.frontKmAt(est, r, T("22:30"), T("23:30"), 10), 10);
});

test("車輛換子路線就重起軌跡", () => {
  const V2 = { ...VARIANT, subRouteId: "901", direction: 1 };
  const tr = C.createTracker([VARIANT, V2]);
  C.ingestBusData(tr, { BusInfo: [fix("B", 9, "22:30")] }, T("22:30"));
  C.ingestBusData(tr, { BusInfo: [{ ...fix("B", 1, "22:35"), RouteID: "901" }] }, T("22:35"));
  const b = tr.buses.get("B");
  assert.equal(b.subRouteId, "901");
  assert.equal(b.trace.length, 1);
});
