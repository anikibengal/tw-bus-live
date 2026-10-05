// 核心邏輯測試：node --test tests/core.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../web/core.js");
// 測試驗的是邏輯，不是調出來的數值：預設車速固定成 18 km/h（白天夜間相同），正式值改了也不用跟著改期望時刻
C.P.defaultKmh = C.P.defaultKmhDay = 18;

// 合成路線：往東 10 km 的直線，每 1 km 一站
const LON0 = 121.5, LAT0 = 25.05, KX = 111320 * Math.cos(LAT0 * Math.PI / 180);
const lonAt = (km) => LON0 + (km * 1000) / KX;
const VARIANT = {
  subRouteId: "900", routeId: "90", direction: 0, label: "測試", schedule: { type: "none" },
  shape: [[LON0, LAT0], [lonAt(10), LAT0]],
  stops: Array.from({ length: 11 }, (_, i) => ({ id: String(1000 + i), name: `站${i}`, km: i })),
};
const TT = { ...VARIANT, subRouteId: "901", routeId: "91",
  schedule: { type: "timetable", byDay: { sat: ["09:00", "09:30", "10:00"] } } };
const FQ = { ...VARIANT, subRouteId: "902", routeId: "92",
  schedule: { type: "frequency", windows: [{ start: "05:00", end: "22:10", minHeadway: 7, maxHeadway: 10, days: ["sat"] }] } };
const T = (hhmm, day = "2026-10-03") => C.parseTpe(`${day} ${hhmm}:00`);   // 2026-10-03 是週六
const fix = (id, km, hhmm, extra = {}) => ({
  BusID: id, RouteID: extra.route || "900", GoBack: "0", Longitude: String(lonAt(km)), Latitude: String(LAT0 + (extra.offDeg || 0)),
  Speed: "20", DataTime: `2026-10-03 ${hhmm}:00`, DutyStatus: extra.duty || "1", BusStatus: "0",
});
function trackerWith(fixesByTime, variants = [VARIANT]) {
  const tr = C.createTracker(variants);
  for (const [hhmm, fixes] of fixesByTime) C.ingestBusData(tr, { BusInfo: fixes }, T(hhmm));
  return tr;
}
// 預估到站：pairs 是 [站序, 秒數, 檔案裡的 GoBack（預設 0＝下一班就在去程上）]
const etaOf = (hhmm, pairs, routeId = "90") => ({ updateMs: T(hhmm),
  map: new Map(pairs.map(([stop, sec, gb = "0"]) => [`${routeId}|${gb}|${1000 + stop}`, sec])),
  byStop: new Map(pairs.map(([stop, sec, gb = "0"]) => [`${routeId}|${1000 + stop}`, [sec, String(gb)]])) });
const at = (list) => list.map((x) => [x.bus, C.fmtTime(x.ms), x.source]);
/** 只追蹤這個變體、而且它現在有一台車在跑（在第 km 公里；預設第 8 公里，前面的站都過了）。依班距那一筆只在變體有車在跑時才補。 */
function runningAt(v, hhmm, day = "2026-10-03", km = 8, extra = {}) {
  const tr = C.createTracker([v]);
  C.ingestBusData(tr, { BusInfo: [{ ...fix("跑", km, hhmm, { route: v.subRouteId, ...extra }), DataTime: `${day} ${hhmm}:00` }] }, T(hhmm, day));
  return tr;
}

test("營運日：凌晨 00:30 算前一天（週六）", () => {
  const sd = C.serviceDay(T("00:30", "2026-10-04"));
  assert.equal(sd.dayKey, "sat");
  assert.equal(C.fmtTime(sd.start), "00:00");
});

test("兩種時間格式都解析成台北時間", () => {
  assert.equal(C.parseTpe("2026/10/03 22:10:00"), C.parseTpe("2026-10-03 22:10:00"));
  assert.equal(C.fmtTime(C.parseTpe("2026-10-03 22:10:00")), "22:10");
});

test("營運中車輛：排除勤務 2、偏離路線、定位過期、已到終點", () => {
  const tr = trackerWith([["09:30", [
    fix("D2", 3, "09:30", { duty: "2" }), fix("OFF", 4, "09:30", { offDeg: 0.003 }),
    fix("END", 9.95, "09:30"), fix("OLD", 2, "09:20"), fix("OK", 6, "09:30"), fix("OK2", 1, "09:30"),
  ]]]);
  assert.deepEqual(C.activeBuses(tr, "900", T("09:30")).map((b) => b.id), ["OK", "OK2"]);   // 前面的車在前
});

test("官方預估對到該站後方最近的車；第二班以官方錨點接續", () => {
  const tr = trackerWith([["09:30", [fix("A", 7, "09:30"), fix("B", 3, "09:30")]]]);
  // 站4、站5 後方最近的是 B；站8 後方最近的是 A
  const eta = etaOf("09:30", [[4, 6 * 60], [5, 9 * 60], [8, 3 * 60]]);
  const r = C.routeArrivals(tr, "900", eta, T("09:30"));
  assert.deepEqual(at(r.perStop[4]), [["B", "09:36", "官方"]]);
  assert.deepEqual(at(r.perStop[8]), [["A", "09:33", "官方"], ["B", "09:49", "官方→預設"]]);   // 09:39 + 3 km ÷ 18 km/h
});

test("前一台車正停在站上時，該站官方預估是它的，不是後面那台", () => {
  const tr = trackerWith([["09:30", [fix("A", 5, "09:30"), fix("B", 2, "09:30")]]]);
  const r = C.routeArrivals(tr, "900", etaOf("09:30", [[5, 0]]), T("09:30"));
  const b5 = r.perStop[5].find((x) => x.bus === "B");
  assert.notEqual(b5.source, "官方");
});

test("兩車很近時，前車前方站的官方預估仍只屬於前車（物理上後車也做得到）", () => {
  const tr = trackerWith([["09:30", [fix("A", 7, "09:30"), fix("B", 6.5, "09:30")]]]);
  const r = C.routeArrivals(tr, "900", etaOf("09:30", [[8, 3 * 60]]), T("09:30"));
  assert.deepEqual(r.perStop[8].map((x) => [x.bus, x.source]), [["A", "官方"], ["B", "預設"]]);
});

test("物理檢查：官方預估快到不可能時，判定指的是別台車", () => {
  const tr = trackerWith([["09:30", [fix("B", 3, "09:30")]]]);
  const r = C.routeArrivals(tr, "900", etaOf("09:30", [[9, 60]]), T("09:30"));   // 6 km 要 1 分鐘
  const b9 = r.perStop[9].find((x) => x.bus === "B");
  assert.notEqual(b9.source, "官方");
});

test("物理檢查：官方預估慢到不合理時（車只差 0.2 km 卻說 10 分），判定指的是後面那台", () => {
  const tr = trackerWith([["09:30", [fix("B", 3.8, "09:30")]]]);
  const r = C.routeArrivals(tr, "900", etaOf("09:30", [[4, 10 * 60], [6, 30 * 60]]), T("09:30"));
  assert.notEqual(r.perStop[4].find((x) => x.bus === "B").source, "官方");
  assert.notEqual(r.perStop[6].find((x) => x.bus === "B").source, "官方");    // 2.2 km 說 30 分＝4.4 km/h
  const ok = C.routeArrivals(tr, "900", etaOf("09:30", [[4, 3 * 60]]), T("09:30"));
  assert.equal(ok.perStop[4].find((x) => x.bus === "B").source, "官方", "5 分內都還算合理");
});

test("該站後方沒有追蹤中的車，但官方有預估 → 列為未定位的車", () => {
  const tr = trackerWith([["09:30", [fix("A", 5, "09:30")]]]);
  const r = C.routeArrivals(tr, "900", etaOf("09:30", [[1, 4 * 60]]), T("09:30"));
  assert.deepEqual(at(r.perStop[1]), [[null, "09:34", "官方・未定位"]]);
});

test("前車段速：前車剛以 30 km/h 跑過 → 後車的推估往前車的速度靠，但不照抄一台車", () => {
  const tr = trackerWith([
    ["09:18", [fix("A", 3, "09:18")]], ["09:20", [fix("A", 4, "09:20")]], ["09:22", [fix("A", 5, "09:22")]],
    ["09:24", [fix("A", 6, "09:24")]], ["09:26", [fix("A", 7, "09:26"), fix("B", 3, "09:26")]],
  ]);
  const r = C.routeArrivals(tr, "900", null, T("09:26"));
  const b = r.perStop[6].find((x) => x.bus === "B"), min = (b.ms - T("09:26")) / 60e3;
  assert.equal(b.source, "前車");
  // 3 km：照抄前車（2 分/km）是 6 分、預設車速（18 km/h）是 10 分。只看過一台車，增益約 0.56，再扣掉幾分鐘的衰退 → 約 7.9 分
  assert.ok(min > 7.6 && min < 8.2, `應約 7.9 分，實得 ${min}`);
});

test("同一台車的推估時刻沿路線不倒退（官方預估前後矛盾時）", () => {
  const tr = trackerWith([["09:30", [fix("B", 3, "09:30")]]]);
  const r = C.routeArrivals(tr, "900", etaOf("09:30", [[4, 14 * 60], [5, 12 * 60]]), T("09:30"));
  assert.ok(r.perStop[5][0].ms >= r.perStop[4][0].ms);
});

test("每站依到站時刻排序", () => {
  const tr = trackerWith([["09:30", [fix("A", 1, "09:30"), fix("B", 6, "09:30")]]]);
  const r = C.routeArrivals(tr, "900", null, T("09:30"));
  const s9 = r.perStop[9];
  assert.deepEqual(s9.map((x) => x.bus), ["B", "A"]);
});

test("只推算到 90 分鐘內", () => {
  // 前車段速極慢（12 分/km）：0.5 km → 10 km 要 114 分，超過 90 分的站不列
  const tr = trackerWith([["09:30", [fix("B", 0.5, "09:30")]]]);
  const ent = C.entOf(tr, "900");
  for (let b = 0; b < 50; b++) ent.bins[b] = C.paceState(12, T("09:30"));
  const r = C.routeArrivals(tr, "900", null, T("09:30"));
  assert.equal(r.perStop[8].length, 1);                            // 7.5 km × 12 = 90 分以內
  assert.equal(r.perStop[10].length, 0);
});

test("逐班表路線：不足兩班時用起點班表補", () => {
  const tr = trackerWith([["09:20", [fix("A", 4, "09:20", { route: "901" })]]], [TT]);
  const r = C.routeArrivals(tr, "901", null, T("09:20"));
  // 站6：A 一班，再補 09:30 發車那班（09:30 + 6 km ÷ 18 km/h = 09:50）
  assert.deepEqual(at(r.perStop[6]), [["A", "09:26", "預設"], [null, "09:50", "班表"]]);
});

test("起點已有車在等時，跳過最近那班班表（避免同一班算兩次）", () => {
  // 09:20 有車停在起點（等 09:30 發車）；以「現在出發」估它到站3 約 09:30，與班表 09:30 那班估的 09:40 差 10 分，去重擋不住
  const tr = trackerWith([["09:20", [fix("W", 0.1, "09:20", { route: "901" })]]], [TT]);
  const r = C.routeArrivals(tr, "901", null, T("09:20"));
  const s3 = at(r.perStop[3]);
  assert.equal(s3[0][0], "W");
  assert.equal(s3[1][1], "10:10");                                 // 10:00 那班（09:30 被 W 代表）
});

test("合併兩變體的站：共用站對齊，分岔段依各自站序插入", () => {
  const st = (names) => names.map((n, i) => ({ station: n, name: n, km: i }));
  const A = { key: "A", stops: st(["起", "共1", "甲1", "甲2", "共2", "終"]) };
  const B = { key: "B", stops: st(["起", "共1", "乙1", "共2", "乙2", "終"]) };
  const rows = C.mergeStops([A, B]);
  assert.deepEqual(rows.map((r) => r.name), ["起", "共1", "乙1", "甲1", "甲2", "共2", "乙2", "終"]);
  const r = rows.find((x) => x.name === "共2");
  assert.deepEqual(r.by, { A: 4, B: 3 });
  assert.deepEqual(rows.find((x) => x.name === "乙2").by, { B: 4 });
});

test("剛離站的車對到剛過的班次，不會吃掉下一班", () => {
  // 09:31 有車在起點 0.2 km（就是 09:30 那班剛出發）→ 下一班 10:00 仍要列出
  const tr = trackerWith([["09:31", [fix("J", 0.2, "09:31", { route: "901" })]]], [TT]);
  const r = C.routeArrivals(tr, "901", null, T("09:31"));
  assert.deepEqual(at(r.perStop[3]).map((x) => x.slice(0, 2)), [["J", "09:40"], [null, "10:10"]]);
});

// 兩個同方向變體：共用 起→共1、共2→共3→終；中間 A 走甲、B 走乙
const mk = (sub, route, label, stops, len) => ({ subRouteId: sub, routeId: route, direction: 0, label, key: label, schedule: { type: "none" },
  shape: [[LON0, LAT0], [lonAt(len), LAT0]], stops: stops.map(([n, km], i) => ({ id: `${sub}-${i}`, station: n, name: n, km })) });
const VA = mk("910", "91A", "A", [["起", 0], ["共1", 1], ["甲", 2], ["共2", 3], ["共3", 4], ["終", 5]], 5);
const VB = mk("911", "91B", "B", [["起", 0], ["共1", 1], ["乙", 2.1], ["共2", 3.05], ["共3", 4.05], ["終", 5.05]], 5.05);

test("共用路段：兩邊都是連續兩站才算；分岔段不算", () => {
  const segs = C.sharedSegments(VA, VB).map((s) => [s.v0, s.v1]);
  assert.deepEqual(segs, [[0, 1], [3, 4], [4, 5]]);
});

test("共用路段：一邊直達、另一邊中途多停一站，不算共用（長度相同也一樣）", () => {
  const VD = mk("913", "91D", "D", [["起", 0], ["共1", 1], ["共2", 3], ["終", 4]], 4);
  const VE = mk("914", "91E", "E", [["起", 0], ["共1", 1], ["乙", 2], ["共2", 3], ["終", 4]], 4);
  assert.deepEqual(C.sharedSegments(VD, VE).map((s) => [s.v0, s.v1]), [[0, 1], [3, 4]]);
});

test("共用路段：長度差超過 10% 視為不同街道", () => {
  const VC = mk("912", "91C", "C", [["起", 0], ["共1", 1], ["乙", 2.1], ["共2", 3.05], ["共3", 4.05], ["終", 5.6]], 5.6);
  assert.deepEqual(C.sharedSegments(VA, VC).map((s) => [s.v0, s.v1]), [[0, 1], [3, 4]]);
});

test("借用段速：共用路段用另一變體剛跑過的段速，分岔段不借", () => {
  const tr = C.createTracker([VA, VB]);
  const now = T("09:30"), B = C.entOf(tr, "911");
  for (let k = 0; k < 5.05; k += 0.2) B.bins[Math.floor(k / C.P.binKm + 1e-9)] = C.paceState(3, now - 60e3);
  const A = C.entOf(tr, "910");
  const shared = C.travelMin(A, 3, 4, 1, now);
  assert.ok(Math.abs(shared.min - 3) < 0.1, `共用路段應約 3 分，實得 ${shared.min}`);
  assert.equal(shared.coverage, 1);
  assert.equal(shared.borrowed, 1);
  const fork = C.travelMin(A, 1, 3, 1, now);                       // 共1→甲→共2：A 專屬
  assert.equal(fork.coverage, 0);
  assert.ok(Math.abs(fork.min - 2) < 1e-9);
});

test("借用段速：本線與另一線都有時取較新的那筆", () => {
  const tr = C.createTracker([VA, VB]);
  const now = T("09:30"), A = C.entOf(tr, "910"), B = C.entOf(tr, "911");
  for (let k = 3; k < 4; k += 0.2) A.bins[Math.floor(k / C.P.binKm + 1e-9)] = C.paceState(2, now - 20 * 60e3);
  for (let k = 3; k < 4.1; k += 0.2) B.bins[Math.floor(k / C.P.binKm + 1e-9)] = C.paceState(4, now - 60e3);
  assert.ok(C.travelMin(A, 3, 4, 9, now).min > 3.5, "較新的 B 段速（4 分/km）應優先");
  for (let k = 3; k < 4; k += 0.2) A.bins[Math.floor(k / C.P.binKm + 1e-9)] = C.paceState(2, now);
  assert.ok(C.travelMin(A, 3, 4, 9, now).min < 2.2, "A 自己更新後改用 A");
});

test("借用段速：車少的變體在共用路段的推算來源變成前車", () => {
  const tr = C.createTracker([VA, VB]);
  const now = T("09:30"), B = C.entOf(tr, "911");
  for (let k = 3; k < 5.05; k += 0.2) B.bins[Math.floor(k / C.P.binKm + 1e-9)] = C.paceState(3, now - 60e3);
  C.ingestBusData(tr, { BusInfo: [{ ...fix("X", 3, "09:30"), RouteID: "910" }] }, now);
  const r = C.routeArrivals(tr, "910", null, now);
  assert.deepEqual(at(r.perStop[4])[0], ["X", "09:33", "前車"]);     // 共2→共3 1 km × 3 分
});

// ---------------------------------------------------------------- 前車段速（越界時刻法）
// 每個分段最後一台車花了幾分鐘（量測本身；推算用的是濾波後的值，見「段速的卡爾曼濾波」）
const binTimes = (tr, sub = "900") => C.entOf(tr, sub).bins.map((b, i) => (b ? [Number((i * 0.2).toFixed(1)), Number((b.last * 0.2).toFixed(2))] : null)).filter(Boolean);

test("段速包含停靠時間：在 0.7 km 停 2 分鐘，0.6–0.8 km 這段算 2.75 分", () => {
  const tr = trackerWith([["09:00", [fix("X", 0.5, "09:00")]], ["09:01", [fix("X", 0.7, "09:01")]], ["09:02", [fix("X", 0.7, "09:02")]],
                          ["09:03", [fix("X", 0.7, "09:03")]], ["09:04", [fix("X", 1.1, "09:04")]], ["09:05", [fix("X", 1.5, "09:05")]]]);
  assert.deepEqual(binTimes(tr), [[0.6, 2.75], [0.8, 0.5], [1, 0.5], [1.2, 0.5]]);
});

test("段速：起點 0.5 km 內不記（會含等發車時間）", () => {
  const tr = trackerWith([["09:00", [fix("X", 0.05, "09:00")]], ["09:08", [fix("X", 0.05, "09:08")]], ["09:09", [fix("X", 0.45, "09:09")]],
                          ["09:10", [fix("X", 0.85, "09:10")]]]);
  assert.ok(binTimes(tr).every(([k]) => k >= 0.5), JSON.stringify(binTimes(tr)));
});

test("段速：單一分段超過 5 分鐘不記；斷線超過 4 分鐘或倒退要重來", () => {
  const long = trackerWith([["09:00", [fix("X", 1.0, "09:00")]], ["09:01", [fix("X", 1.3, "09:01")]], ["09:04", [fix("X", 1.3, "09:04")]],
                            ["09:07", [fix("X", 1.3, "09:07")]], ["09:08", [fix("X", 1.7, "09:08")]]]);
  assert.ok(!binTimes(long).some(([k]) => k === 1.2), "停超過 5 分鐘的分段不記");
  const gap = trackerWith([["09:00", [fix("X", 1.0, "09:00")]], ["09:01", [fix("X", 1.3, "09:01")]], ["09:10", [fix("X", 3.0, "09:10")]],
                           ["09:11", [fix("X", 3.3, "09:11")]]]);
  assert.ok(!binTimes(gap).some(([k]) => k >= 1.2 && k < 3.0), "斷線 9 分鐘之間的分段不記");
});

// ---------------------------------------------------------------- 最早可能到站
const CAL = { quantile: 0.9, groups: {
  官方: [{ h0: 0, h1: 10, offsetMin: 1, n: 500 }, { h0: 10, h1: 90, offsetMin: 3, n: 500 }],
  "官方→推算": [{ h0: 0, h1: 90, offsetMin: 4, n: 500 }],
  推算: [{ h0: 0, h1: 10, offsetMin: 0.3, n: 500 }, { h0: 10, h1: 90, offsetMin: 6, n: 500 }],
} };

test("最早可能：依來源分組與「預測還有幾分鐘」取偏移", () => {
  const now = T("09:00");
  const e = (source, min) => { const x = C.earliestMs({ ms: now + min * 60e3, source }, now, CAL); return x == null ? null : (x - now) / 60e3; };
  assert.equal(e("官方", 5), 4);
  assert.equal(e("官方", 20), 17);
  assert.equal(e("官方・未定位", 20), 17);
  assert.equal(e("官方→前車", 20), 16);
  assert.equal(e("前車", 20), 14);
  assert.equal(e("預設", 5), null, "偏移不到 0.5 分不顯示");
  assert.equal(e("班表", 20), null);
  assert.equal(C.earliestMs({ ms: now + 20 * 60e3, source: "班距", upper: true }, now, CAL), null);
  assert.equal(e("官方", 0.5), 0, "最早不會早於現在");
  assert.equal(C.earliestMs({ ms: now + 5 * 60e3, source: "官方" }, now, null), null);
});

// ---------------------------------------------------------------- 點車看接下來各站
test("一台車接下來各站：只列這台車、依站序、標出它在該站是第幾班", () => {
  const tr = trackerWith([["09:30", [fix("A", 6, "09:30"), fix("B", 2.5, "09:30")]]]);
  const r = C.routeArrivals(tr, "900", null, T("09:30"));
  const b = C.upcomingForBus(r, "B");
  assert.deepEqual(b.map((x) => x.si), [3, 4, 5, 6, 7, 8, 9, 10], "已過的站（0～2）不列");
  assert.ok(b.every((x, i) => i === 0 || x.ms >= b[i - 1].ms), "時刻沿站序不倒退");
  assert.deepEqual(b.filter((x) => x.rank === 1).map((x) => x.si), [3, 4, 5, 6], "A 還沒過的站，B 是第 2 班");
  assert.deepEqual(b.filter((x) => x.rank === 2).map((x) => x.si), [7, 8, 9, 10]);
  assert.deepEqual(C.upcomingForBus(r, "A").map((x) => x.si), [7, 8, 9, 10]);
});

test("一台車接下來各站：車不在營運中回傳 null", () => {
  const tr = trackerWith([["09:30", [fix("A", 6, "09:30"), fix("Z", 3, "09:30", { duty: "2" })]]]);
  const r = C.routeArrivals(tr, "900", null, T("09:30"));
  assert.equal(C.upcomingForBus(r, "Z"), null);
  assert.equal(C.upcomingForBus(r, "不存在"), null);
  assert.equal(C.upcomingForBus(null, "A"), null);
});

// ---------------------------------------------------------------- 地圖上的平滑移動
test("平滑移動：第一次出現直接定位，不做動畫", () => {
  const tw = C.planTween(null, 3, 1000, 5000);
  assert.deepEqual([tw.k0, tw.k1, tw.dur], [3, 3, 0]);
  assert.equal(C.tweenKm(tw, 9999), 3);
});

test("平滑移動：往前時，用兩筆定位的時間差從目前顯示位置滑到新位置", () => {
  const a = C.planTween(null, 3, 0, 0);
  const b = C.planTween(a, 3.2, 20000, 21000);                    // 新定位比前一筆晚 20 秒
  assert.deepEqual([b.k0, b.k1, b.dur], [3, 3.2, 20000]);
  assert.ok(Math.abs(C.tweenKm(b, 21000 + 10000) - 3.1) < 1e-9);   // 跑到一半
  assert.equal(C.tweenKm(b, 21000 + 30000), 3.2);                  // 跑完停在新位置
  // 動畫跑到一半又來一筆：從「目前顯示的位置」接續，不跳
  const c = C.planTween(b, 3.5, 40000, 31000);
  assert.ok(Math.abs(c.k0 - 3.1) < 1e-9);
  assert.equal(c.k1, 3.5);
});

test("平滑移動：定位時刻沒變就照舊；時間差夾在 3～25 秒", () => {
  const a = C.planTween(null, 3, 1000, 0);
  assert.equal(C.planTween(a, 3.4, 1000, 5000), a);
  assert.equal(C.planTween(a, 3.4, 1500, 5000).dur, 3000);
  assert.equal(C.planTween(a, 3.4, 90000, 5000).dur, 25000);
});

test("平滑移動：小幅倒退停在原地；大幅倒退或跳太遠就直接跳", () => {
  const a = C.planTween(null, 3, 0, 0);
  const jitter = C.planTween(a, 2.97, 20000, 20000);
  assert.deepEqual([jitter.k0, jitter.k1, jitter.dur], [3, 3, 0], "倒退 30 m 是抖動，不往回走");
  const back = C.planTween(a, 0.2, 20000, 20000);
  assert.deepEqual([back.k0, back.k1, back.dur], [0.2, 0.2, 0], "回到起點＝新的一趟");
  const jump = C.planTween(a, 6, 20000, 20000);
  assert.deepEqual([jump.k0, jump.k1, jump.dur], [6, 6, 0], "一次跳 3 km 不拖著跑");
});

test("班距表路線：回傳目前時段的班距", () => {
  assert.deepEqual(C.headwayNow(FQ, T("09:30")), { min: 7, max: 10 });
  assert.equal(C.headwayNow(FQ, T("23:00")), null);
});

// 末班在凌晨的路線（棕2、藍29：首班 05:40、末班 00:00）：建置時把時段的 end 寫成 24 時以後（build_city.py 的 window_end）
const NIGHT = (windows) => ({ ...FQ, subRouteId: "903", routeId: "93", schedule: { type: "frequency", windows } });
const SAT = { min: 12, max: 20 }, SUN = { min: 15, max: 30 };
const win = (start, end, days, hw) => ({ start, end, minHeadway: hw.min, maxHeadway: hw.max, days });

test("班距表路線：跨午夜的時段到隔天凌晨還算同一個營運日", () => {
  // 週六 05:40–00:30（寫成 24:30）、週日 06:00–00:00（寫成 24:00）
  const v = NIGHT([win("05:40", "24:30", ["sat"], SAT), win("06:00", "24:00", ["sun"], SUN)]);
  const D4 = "2026-10-04", D5 = "2026-10-05";                     // 週日、週一
  for (const [hhmm, day, want, why] of [
    ["05:39", undefined, null, "週六首班前"],
    ["05:40", undefined, SAT, "含起"],
    ["23:30", undefined, SAT, "午夜前"],
    ["23:59", undefined, SAT, ""],
    ["00:00", D4, SAT, "過了午夜，末班 00:30 還沒發"],
    ["00:10", D4, SAT, "週日凌晨用的是週六的時段"],
    ["00:29", D4, SAT, ""],
    ["00:30", D4, null, "末班時刻已到（不含迄）"],
    ["02:59", D4, null, "週六的營運日還沒結束，但末班已發"],
    ["03:00", D4, null, "換成週日的營運日：還沒到首班"],
    ["06:00", D4, SUN, "週日的時段"],
    ["23:30", D4, SUN, "週日午夜前"],
    ["00:00", D5, null, "週日末班 00:00（寫成 24:00）：午夜一到就結束"],
    ["00:10", D5, null, "週一凌晨不會撿到週六的時段"],
  ]) assert.deepEqual(C.headwayNow(v, T(hhmm, day)), want, `${day || "2026-10-03"} ${hhmm} ${why}`);
});

test("班距表路線：營運日 03:00 換日，凌晨的時段不會算到當天的星期", () => {
  // 只有週日有時段：週日凌晨 00:10 屬於週六的營運日，不適用；週一凌晨 00:10 才是週日深夜
  const sunOnly = NIGHT([win("06:00", "24:30", ["sun"], SUN)]);
  assert.equal(C.headwayNow(sunOnly, T("00:10", "2026-10-04")), null);
  assert.deepEqual(C.headwayNow(sunOnly, T("00:10", "2026-10-05")), SUN);
  // 換日點本身（人工的時段，建置不會產生 27:00）：02:59 還是週六、03:00 起是週日
  const edge = NIGHT([win("05:40", "27:00", ["sat"], SAT), win("03:00", "22:00", ["sun"], SUN)]);
  assert.deepEqual(C.headwayNow(edge, T("02:59", "2026-10-04")), SAT);
  assert.deepEqual(C.headwayNow(edge, T("03:00", "2026-10-04")), SUN);
  assert.equal(C.hhmmToMin("24:30"), 1470);
  assert.equal(C.hhmmToMin("26:59"), 1619);
});

test("跨午夜的時段：凌晨起點還沒發車的站照樣補一筆依班距的上限", () => {
  const v = NIGHT([win("05:40", "24:30", ["sat"], SAT)]);
  const at2 = (hhmm, day) => at(C.routeArrivals(runningAt(v, hhmm, day), "903", null, T(hhmm, day)).perStop[3]);
  assert.deepEqual(at2("23:30"), [[null, "00:00", "班距"]]);              // 23:30 + 班距上限 20 + 3 km ÷ 18 km/h
  assert.deepEqual(at2("00:10", "2026-10-04"), [[null, "00:40", "班距"]]);
  assert.deepEqual(at2("00:30", "2026-10-04"), [], "末班已發：不再補");
  assert.deepEqual(at2("02:59", "2026-10-04"), []);
  assert.deepEqual(at2("03:00", "2026-10-04"), []);
});

test("只有班距的路線：沒車的站補一筆依班距的上限", () => {
  const r = C.routeArrivals(runningAt(FQ, "09:30"), "902", null, T("09:30"));
  assert.deepEqual(at(r.perStop[3]), [[null, "09:50", "班距"]]);       // 09:30 + 班距上限 10 + 3 km ÷ 18 km/h
  assert.equal(r.perStop[3][0].upper, true);
});

test("依班距那一筆只在這個變體現在有車在跑時才補", () => {
  const stop3 = (tr, hhmm = "09:30") => at(C.routeArrivals(tr, "902", null, T(hhmm)).perStop[3]);
  // 班距欄位只是登記的數字：整個變體沒有任何一台車在路上（調度站發車、只跑尖峰的區間車、已經收班），補出來的多半是不存在的車
  assert.deepEqual(stop3(C.createTracker([FQ])), [], "沒有車在跑：不補");
  assert.deepEqual(stop3(runningAt(FQ, "09:30")), [[null, "09:50", "班距"]], "有一台在跑（已經過了這一站）：補");
  // 要是「營運中」的車才算：非營運狀態、定位過期（超過 3 分鐘）、已經到終點的都不算
  assert.deepEqual(stop3(runningAt(FQ, "09:30", undefined, 8, { duty: "0" })), [], "非營運中的車不算");
  assert.deepEqual(stop3(runningAt(FQ, "09:26"), "09:30"), [], "定位是 4 分鐘前的：不算在跑");
  assert.deepEqual(stop3(runningAt(FQ, "09:30", undefined, 9.95)), [], "已經到終點的車不算");
  // 看的是這個變體自己：同一個追蹤器裡別的變體有車，不算數
  const other = { ...FQ, subRouteId: "905", routeId: "95" };
  const tr = C.createTracker([FQ, other]);
  C.ingestBusData(tr, { BusInfo: [fix("別線", 8, "09:30", { route: "905" })] }, T("09:30"));
  assert.deepEqual(stop3(tr), []);
  assert.deepEqual(at(C.routeArrivals(tr, "905", null, T("09:30")).perStop[3]), [[null, "09:50", "班距"]]);
});

test("班距只是登記數字的路線（nominal）不補依班距那一筆；班距與末班時刻照樣查得到", () => {
  // 全市路線檔的班距表：只有路線登記的尖峰／離峰班距，驗證過不可靠，所以不拿來補班次
  const nominal = { ...FQ, schedule: { ...FQ.schedule, nominal: true } };
  const r = C.routeArrivals(runningAt(nominal, "09:30"), "902", null, T("09:30"));
  assert.deepEqual(r.perStop.map((l) => l.filter((a) => a.source === "班距").length), Array(11).fill(0), "每一站都不補");
  assert.deepEqual(at(r.perStop[9]), [["跑", "09:33", "預設"]], "有車牌的推估照常");
  assert.deepEqual(r.headway, { min: 7, max: 10 });
  assert.deepEqual(C.headwayNow(nominal, T("09:30")), { min: 7, max: 10 });
  assert.equal(C.fmtTime(C.serviceEndMs(nominal, T("09:30"))), "22:10");
  // 對照：同一個情況、沒有標 nominal（內建路線的班距表）→ 照補
  const trusted = C.routeArrivals(runningAt(FQ, "09:30"), "902", null, T("09:30"));
  assert.deepEqual(at(trusted.perStop[3]), [[null, "09:50", "班距"]]);
  assert.deepEqual(C.routeArrivals(runningAt({ ...FQ, schedule: { ...FQ.schedule, nominal: false } }, "09:30"), "902", null, T("09:30")).perStop[3].map((a) => a.source), ["班距"]);
});

test("這一段營運時段的末班發車時刻：時段相連就接到最後一個的結束，有空檔就停在空檔之前", () => {
  assert.equal(C.fmtTime(C.serviceEndMs(FQ, T("09:30"))), "22:10");
  assert.equal(C.serviceEndMs(FQ, T("22:10")), null, "末班時刻已到（不含迄）");
  assert.equal(C.serviceEndMs(FQ, T("04:59")), null, "首班之前");
  assert.equal(C.serviceEndMs(VARIANT, T("09:30")), null, "沒有班距表");
  assert.equal(C.serviceEndMs(TT, T("09:30")), null, "逐班表路線");
  assert.equal(C.serviceEndMs({ ...FQ, schedule: { ...FQ.schedule, type: "none" } }, T("09:30")), null, "只認班距表（和 headwayNow 同一個判斷）");
  // 307 的寫法：05:00–21:00、21:00–22:10 兩個時段相連 → 21:00 不是收班
  const two = NIGHT([win("05:00", "21:00", ["sat"], SAT), win("21:00", "22:10", ["sat"], SUN)]);
  assert.equal(C.fmtTime(C.serviceEndMs(two, T("20:55"))), "22:10");
  assert.equal(C.fmtTime(C.serviceEndMs(two, T("21:30"))), "22:10");
  // 順序顛倒、三段相連也一樣
  const three = NIGHT([win("21:00", "22:10", ["sat"], SUN), win("09:00", "21:00", ["sat"], SAT), win("05:00", "09:00", ["sat"], SAT)]);
  assert.equal(C.fmtTime(C.serviceEndMs(three, T("05:30"))), "22:10");
  // 中間有空檔（上午一段、下午一段）：上午那一段的末班是 10:00
  const gap = NIGHT([win("05:00", "10:00", ["sat"], SAT), win("16:00", "22:00", ["sat"], SAT)]);
  assert.equal(C.fmtTime(C.serviceEndMs(gap, T("09:55"))), "10:00");
  assert.equal(C.serviceEndMs(gap, T("12:00")), null);
  assert.equal(C.fmtTime(C.serviceEndMs(gap, T("16:00"))), "22:00");
  // 別的星期的時段不能接上來
  const days = NIGHT([win("05:00", "21:00", ["sat"], SAT), win("21:00", "23:00", ["sun"], SUN)]);
  assert.equal(C.fmtTime(C.serviceEndMs(days, T("20:55"))), "21:00");
  // 跨午夜的時段（24:30）：末班是隔天 00:30，凌晨問也一樣
  const night = NIGHT([win("05:40", "24:30", ["sat"], SAT)]);
  assert.equal(C.serviceEndMs(night, T("23:30")), T("00:30", "2026-10-04"));
  assert.equal(C.serviceEndMs(night, T("00:10", "2026-10-04")), T("00:30", "2026-10-04"));
});

test("收班前：站上那一班對不到車（官方說未發車、未定位）時，離末班不到一個班距上限就不再補下一班", () => {
  // FQ：班距 7～10 分，末班 22:10。一台車在第 8 公里跑（讓變體算有在跑），第 3 站只有官方的預估
  const stop3 = (hhmm, pairs) => C.routeArrivals(runningAt(FQ, hhmm), "902", etaOf(hhmm, pairs, "92"), T(hhmm)).perStop[3].map((x) => x.source);
  const notYet = [[3, 300, "1"]], noFix = [[3, 300]];              // 官方說那班車還在對向（未發車）／就在這個方向上但我們沒定位到
  assert.deepEqual(stop3("21:30", notYet), ["官方・未發車", "班距"], "離末班還有 40 分：照補");
  assert.deepEqual(stop3("21:59", notYet), ["官方・未發車", "班距"], "還有 11 分，超過班距上限 10 分：至少還有兩班");
  assert.deepEqual(stop3("22:00", notYet), ["官方・未發車"], "剛好一個班距上限：那一班可能就是末班，不補");
  assert.deepEqual(stop3("22:09", notYet), ["官方・未發車"]);
  assert.deepEqual(stop3("21:59", noFix), ["官方・未定位", "班距"]);
  assert.deepEqual(stop3("22:00", noFix), ["官方・未定位"]);
  // 站上沒有任何一班：補的那一筆就是還沒發的末班，照補
  assert.deepEqual(stop3("22:09", []), ["班距"]);
  // 時段相連的路線（05:00–21:00、21:00–22:10）：20:55 不是收班前
  const two = { ...FQ, schedule: { type: "frequency", windows: [{ ...FQ.schedule.windows[0], end: "21:00" }, { ...FQ.schedule.windows[0], start: "21:00" }] } };
  const r = C.routeArrivals(runningAt(two, "20:55"), "902", etaOf("20:55", notYet, "92"), T("20:55"));
  assert.deepEqual(r.perStop[3].map((x) => x.source), ["官方・未發車", "班距"]);
});

test("收班前：站上那一班是還停在起點的車時，離末班不到一個最短班距就不再補；已經在路上的車後面照補", () => {
  // 起點附近＝0.5 km 以內。FQ 最短班距 7 分、末班 22:10
  const stop3 = (hhmm, km) => C.routeArrivals(runningAt(FQ, hhmm, undefined, km), "902", null, T(hhmm)).perStop[3].map((x) => x.source);
  assert.deepEqual(stop3("21:30", 0.2), ["預設", "班距"], "平常：起點那台後面還有下一班");
  assert.deepEqual(stop3("22:03", 0.2), ["預設", "班距"], "離末班剛好 7 分：還排得下一班");
  assert.deepEqual(stop3("22:04", 0.2), ["預設"], "只剩 6 分：起點那台就是末班");
  assert.deepEqual(stop3("22:09", 0.2), ["預設"]);
  assert.deepEqual(stop3("22:09", 0.45), ["預設"]);
  // 已經開出去的車（0.5 km 以外）：它後面那一筆就是還沒發的末班
  assert.deepEqual(stop3("22:09", 0.55), ["預設", "班距"]);
  assert.deepEqual(stop3("22:09", 2), ["預設", "班距"]);
  // 上限的算法沒變：現在 + 班距上限 + 開到這一站的時間，不早於前一班 + 最短班距
  const r = C.routeArrivals(runningAt(FQ, "22:09", undefined, 2), "902", null, T("22:09")).perStop[3];
  assert.deepEqual(at(r), [["跑", "22:12", "預設"], [null, "22:29", "班距"]]);
});

test("依班距那一筆排在已知車輛之後", () => {
  const tr = trackerWith([["09:30", [fix("K", 2, "09:30", { route: "902" })]]], [FQ]);
  const r = C.routeArrivals(tr, "902", null, T("09:30"));
  const s3 = r.perStop[3];
  assert.deepEqual(s3.map((x) => x.source), ["預設", "班距"]);
  assert.ok(s3[1].ms >= s3[0].ms + 7 * 60e3);
});

test("車輛換子路線就重起軌跡；斷線很久也追得回來", () => {
  const V2 = { ...VARIANT, subRouteId: "902", direction: 1 };
  const tr = C.createTracker([VARIANT, V2]);
  C.ingestBusData(tr, { BusInfo: [fix("B", 9, "09:30")] }, T("09:30"));
  C.ingestBusData(tr, { BusInfo: [{ ...fix("B", 1, "09:35"), RouteID: "902" }] }, T("09:35"));
  assert.equal(tr.buses.get("B").trace.length, 1);
  const tr2 = trackerWith([["09:00", [fix("G", 0.5, "09:00")]], ["09:32", [fix("G", 7, "09:32")]]]);
  const p = tr2.buses.get("G").trace.pop();
  assert.ok(Math.abs(p.km - 7) < 0.01, `斷線 32 分鐘後應追到 7 km，實得 ${p.km}`);
});

// ---------------------------------------------------------------- 多路線：子路線編號與方向
test("同一個子路線編號涵蓋去返兩向（265區）時，用方向欄位分到正確的變體", () => {
  const OUT = { ...VARIANT, subRouteId: "500", direction: 0, tid: "500|0", key: "去" };
  const BACK = { ...VARIANT, subRouteId: "500", direction: 1, tid: "500|1", key: "返" };
  const tr = C.createTracker([OUT, BACK]);
  C.ingestBusData(tr, { BusInfo: [{ ...fix("X", 3, "09:30"), RouteID: "500", GoBack: "0" }, { ...fix("Y", 6, "09:30"), RouteID: "500", GoBack: "1" }] }, T("09:30"));
  assert.deepEqual(C.activeBuses(tr, "500|0", T("09:30")).map((b) => b.id), ["X"]);
  assert.deepEqual(C.activeBuses(tr, "500|1", T("09:30")).map((b) => b.id), ["Y"]);
  // 同一台車換方向（到終點折返）→ 重起軌跡
  C.ingestBusData(tr, { BusInfo: [{ ...fix("X", 1, "09:40"), RouteID: "500", GoBack: "1" }] }, T("09:40"));
  assert.equal(tr.buses.get("X").tid, "500|1");
  assert.equal(tr.buses.get("X").trace.length, 1);
});

test("每個方向各有一個子路線編號（307）時，方向欄位對不上也照編號歸類", () => {
  const tr = C.createTracker([VARIANT]);                              // 子路線 900、方向 0
  C.ingestBusData(tr, { BusInfo: [{ ...fix("X", 3, "09:30"), GoBack: "1" }] }, T("09:30"));
  assert.deepEqual(C.activeBuses(tr, "900", T("09:30")).map((b) => b.id), ["X"]);
});

test("借用段速不限同一條路線：方向編號不同但連續兩站相同就算共用", () => {
  const P1 = mk("920", "92A", "甲線", [["起", 0], ["共1", 1], ["共2", 2], ["終甲", 3]], 3);
  const P2 = { ...mk("921", "92B", "乙線", [["乙起", 0], ["共1", 1.5], ["共2", 2.5], ["乙終", 4]], 4), direction: 1 };
  const tr = C.createTracker([P1, P2]);
  const a = C.entOf(tr, "920");
  assert.deepEqual(a.shared.map((x) => x.segs.map((g) => [g.v0, g.v1, g.w0, g.w1])), [[[1, 2, 1.5, 2.5]]]);
});

test("營運中車輛帶出定位年齡", () => {
  const tr = trackerWith([["09:29", [fix("X", 3, "09:29")]]]);
  assert.equal(Math.round(C.activeBuses(tr, "900", T("09:30"))[0].ageS), 60);
});

// ---------------------------------------------------------------- 站牌前方路況
test("前方路況：只就量到的分段算均速，並回報量到的比例", () => {
  const tr = C.createTracker([VARIANT]);
  const ent = C.entOf(tr, "900"), now = T("09:30");
  // 站6 前方 2 km（4–6 km）：只有 5–6 km 有資料，每公里 6 分鐘＝10 km/h
  for (let b = 25; b < 30; b++) ent.bins[b] = C.paceState(6, now);
  const r = C.roadAhead(tr, "900", 6, now);
  assert.ok(Math.abs(r.coverage - 0.5) < 1e-9);
  assert.ok(Math.abs(r.kmh - 10) < 1e-6, `應為 10 km/h，實得 ${r.kmh}`);
  assert.deepEqual(C.roadAhead(tr, "900", 3, now), { coverage: 0, kmh: null }, "完全沒量到：不給速度");
  assert.equal(C.roadAhead(tr, "900", 0.2, now), null, "起點附近沒有前方");
  // 很久沒有車經過：不是一刀切丟掉，而是慢慢退回預設車速（18 km/h）。50 分鐘前量到 10 km/h → 現在當成約 13.4 km/h
  for (let b = 25; b < 30; b++) ent.bins[b] = C.paceState(6, now - 50 * 60e3);
  const old = C.roadAhead(tr, "900", 6, now);
  assert.ok(Math.abs(old.kmh - 60 / (60 / 18 + (6 - 60 / 18) * Math.exp(-50 / 60))) < 1e-6 && old.kmh > 13.3 && old.kmh < 13.4, `實得 ${old.kmh}`);
  for (let b = 25; b < 30; b++) ent.bins[b] = C.paceState(6, now - 600 * 60e3);
  assert.ok(Math.abs(C.roadAhead(tr, "900", 6, now).kmh - 18) < 0.01, "十小時前的：等於預設車速");
  // 升級前存在瀏覽器裡的舊格式（沒有變異數）：不用
  for (let b = 25; b < 30; b++) ent.bins[b] = { pace: 6, at: now };
  assert.deepEqual(C.roadAhead(tr, "900", 6, now), { coverage: 0, kmh: null });
});

// ---------------------------------------------------------------- 段速的卡爾曼濾波
test("段速的卡爾曼更新：第一台車的增益是 S/(S+R)，看過越多台越接近它們的平均，不是只信最新一台", () => {
  const t0 = T("09:00"), prior = 60 / 18, S = C.P.paceVar, R = C.P.paceNoise, near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg || ""} ${a} vs ${b}`);
  // 第一台：每公里 6 分鐘（預設 3.33）
  const a = C.paceUpdate(undefined, 6, t0), K1 = S / (S + R);
  near(a.dev, K1 * (6 - prior)); near(a.var, S * (1 - K1));
  assert.deepEqual([a.at, a.last], [t0, 6]);
  near(C.paceNow(a, t0), prior + K1 * (6 - prior), "當下的步調＝預設＋偏差");
  // 同一時刻第二台也是 6：變異數已經變小，增益跟著變小；估計更靠近 6
  const b = C.paceUpdate(a, 6, t0), K2 = a.var / (a.var + R);
  near(b.dev, a.dev + K2 * (6 - prior - a.dev)); near(b.var, a.var * (1 - K2));
  assert.ok(K2 < K1 && b.dev > a.dev && b.dev < 6 - prior);
  // 連續 30 台都是 6：收斂到 6（差不到 2%）
  let x; for (let i = 0; i < 30; i++) x = C.paceUpdate(x, 6, t0);
  assert.ok(Math.abs(C.paceNow(x, t0) - 6) < 0.12, `${C.paceNow(x, t0)}`);
  // 一快一慢輪流（2、6、2、6…）：落在中間，不是跟著最後一台跑
  let y; for (let i = 0; i < 20; i++) y = C.paceUpdate(y, i % 2 ? 6 : 2, t0);
  assert.ok(C.paceNow(y, t0) > 3.7 && C.paceNow(y, t0) < 4.3, `${C.paceNow(y, t0)}`);
  assert.equal(y.last, 6, "last 記的是最後那一台自己的步調");
  // 舊格式（沒有 var）當成沒有：從頭開始
  assert.deepEqual(C.paceUpdate({ pace: 9, at: t0 }, 6, t0), a);
  // 參數要真的用到：雜訊越大越不信單一台車；分段差異越大越信
  const keep = { ...C.P };
  try {
    C.P.paceNoise = 47; assert.ok(C.paceUpdate(undefined, 6, t0).dev < a.dev / 3);
    C.P.paceNoise = keep.paceNoise; C.P.paceVar = 60; assert.ok(C.paceUpdate(undefined, 6, t0).dev > a.dev * 1.5);
  } finally { Object.assign(C.P, keep); }
});

test("段速的衰退：沒有新的車經過，偏差以時間常數退回預設車速，下一台車的增益跟著回升", () => {
  const t0 = T("09:00"), prior = 60 / 18, tau = C.P.paceTauMin, S = C.P.paceVar, R = C.P.paceNoise;
  const a = C.paceState(6, t0);
  assert.deepEqual(a, { at: t0, dev: 6 - prior, var: 0, last: 6 });
  const after = (min) => C.paceNow(a, t0 + min * 60e3) - prior;
  assert.ok(Math.abs(after(0) - (6 - prior)) < 1e-9);
  assert.ok(Math.abs(after(tau) - (6 - prior) / Math.E) < 1e-9, "過了一個時間常數：剩 1/e");
  assert.ok(Math.abs(after(tau / 2) - (6 - prior) * Math.exp(-0.5)) < 1e-9);
  assert.ok(Math.abs(after(600)) < 0.001, "十小時後等於預設車速");
  // 比預設快的也一樣退回來；而且不會快過 maxKmh（40 km/h＝1.5 分/km）
  assert.ok(Math.abs(C.paceNow(C.paceState(2, t0), t0 + tau * 60e3) - (prior + (2 - prior) / Math.E)) < 1e-9);
  assert.equal(C.paceNow(C.paceState(0.5, t0), t0), 60 / C.P.maxKmh);
  // 更新時先把舊狀態衰退到現在：隔了一個時間常數，變異數回升到 S(1 − e⁻²)，增益也跟著變大
  const sure = C.paceState(6, t0);                                  // 變異數 0：當下再來一台完全不動
  assert.ok(Math.abs(C.paceUpdate(sure, 2, t0).dev - (6 - prior)) < 1e-9);
  const later = C.paceUpdate(sure, 2, t0 + tau * 60e3), v = S * (1 - Math.exp(-2)), K = v / (v + R), d0 = (6 - prior) / Math.E;
  assert.ok(Math.abs(later.dev - (d0 + K * (2 - prior - d0))) < 1e-9);
  assert.ok(Math.abs(later.var - v * (1 - K)) < 1e-9);
  // 很久以後的第一台車，增益回到 S/(S+R)
  const fresh = C.paceUpdate(sure, 2, t0 + 3000 * 60e3);
  assert.ok(Math.abs(fresh.dev - (S / (S + R)) * (2 - prior)) < 1e-6);
  // 預設車速分白天夜間：偏差是相對於「當時那個時段」的預設車速
  const keep = { ...C.P };
  try {
    Object.assign(C.P, { defaultKmhDay: 12, defaultKmh: 20, dayStartH: 7, dayEndH: 21 });
    assert.ok(Math.abs(C.paceState(6, T("09:00")).dev - (6 - 5)) < 1e-9);
    assert.ok(Math.abs(C.paceState(6, T("22:00")).dev - (6 - 3)) < 1e-9);
    assert.ok(Math.abs(C.paceUpdate(undefined, 6, T("22:00")).dev - (S / (S + R)) * 3) < 1e-9);
    assert.ok(Math.abs(C.paceUpdate(undefined, 6, T("09:00")).dev - (S / (S + R)) * 1) < 1e-9, "白天的更新相對於白天的預設車速");
    // 白天量到比預設慢 1 分/km 的分段，到了夜間（沒有衰退時）是夜間的預設 3 ＋ 1
    C.P.paceTauMin = 1e9;
    assert.ok(Math.abs(C.paceNow(C.paceState(6, T("20:59")), T("21:00")) - 4) < 1e-6);
  } finally { Object.assign(C.P, keep); }
});

test("從來沒有車跑過的分段用後備車速；跑過的分段用濾波後的段速", () => {
  const tr = C.createTracker([VARIANT]), ent = C.entOf(tr, "900"), now = T("09:30");
  // 3–4 km 有段速（每公里 6 分），4–5 km 沒有：後備給每公里 2 分
  for (let b = 15; b < 20; b++) ent.bins[b] = C.paceState(6, now);
  const r = C.travelMin(ent, 3, 5, 2, now);
  assert.ok(Math.abs(r.min - 8) < 1e-9, `${r.min}`);
  assert.ok(Math.abs(r.coverage - 0.5) < 1e-9);
  // 30 分鐘前量的：涵蓋照算（有車跑過），步調往預設退
  for (let b = 15; b < 20; b++) ent.bins[b] = C.paceState(6, now - 30 * 60e3);
  const old = C.travelMin(ent, 3, 4, 2, now);
  assert.equal(old.coverage, 1);
  assert.ok(Math.abs(old.min - (60 / 18 + (6 - 60 / 18) * Math.exp(-0.5))) < 1e-9);
});


test("站序相同的不同營運業者併成一條：官方預估只分給整條路線最近的那台，不重複", () => {
  // 兩家業者的車回報不同編號（600、601），但跑同一條路線、共用同一個官方預估
  const MERGED = { ...VARIANT, subRouteId: "600", routeId: "60", tid: "600|0", tids: ["600|0", "601|0"], key: "合併" };
  const tr = C.createTracker([MERGED]);
  C.ingestBusData(tr, { BusInfo: [{ ...fix("甲", 2, "09:30"), RouteID: "600" }, { ...fix("乙", 4, "09:30"), RouteID: "601" }] }, T("09:30"));
  assert.deepEqual(C.activeBuses(tr, "600|0", T("09:30")).map((b) => b.id), ["乙", "甲"], "兩家的車排在同一條路線上");
  const r = C.routeArrivals(tr, "600|0", etaOf("09:30", [[6, 8 * 60]], "60"), T("09:30"));
  const s6 = r.perStop[6];
  assert.deepEqual(s6.map((x) => [x.bus, x.source]), [["乙", "官方"], ["甲", "預設"]], "站6 後方最近的是乙；甲不能也拿到官方");
  assert.equal(s6.filter((x) => x.bus == null).length, 0, "不會多出一筆未定位");
  assert.equal(tr.ents.length, 1);
});

test("預設車速依時段：白天與夜間各用各的，分界含起不含迄", () => {
  const keep = { ...C.P };
  try {
    Object.assign(C.P, { defaultKmhDay: 12, defaultKmh: 20, dayStartH: 7, dayEndH: 21 });
    assert.deepEqual(["06:59", "07:00", "20:59", "21:00", "23:30", "00:10"].map((t) => C.defaultKmhAt(T(t))), [20, 12, 12, 20, 20, 20]);
    // 接到推估裡：同一台車、沒有前車資料也沒有自身均速，白天 3 km ÷ 12 = 15 分、夜間 3 km ÷ 20 = 9 分
    for (const [hhmm, want] of [["09:30", "09:45"], ["22:30", "22:39"]]) {
      const tr = trackerWith([[hhmm, [{ ...fix("A", 2, hhmm), DataTime: `2026-10-03 ${hhmm}:00` }]]]);
      const r = C.routeArrivals(tr, "900", null, T(hhmm));
      assert.deepEqual(at(r.perStop[5]), [["A", want, "預設"]], hhmm);
    }
    // 班距補的那一筆也跟著時段走：班距上限 10 分 + 3 km 的行車時間
    for (const [hhmm, want] of [["09:30", "09:55"], ["21:30", "21:49"]]) {
      const r = C.routeArrivals(runningAt(FQ, hhmm), "902", null, T(hhmm));
      assert.deepEqual(at(r.perStop[3]), [[null, want, "班距"]], hhmm);
    }
  } finally { Object.assign(C.P, keep); }
});

test("校準表的挑法：路線|時段 → 該時段合併表 → 沒有就不給；舊格式原樣使用", () => {
  const t = (tag) => ({ tag, groups: {} });
  const cal = { cells: { "307|day": t("307白天"), "307|night": t("307夜間") }, fallback: { day: t("白天合併") } };
  const pick = (fam, hhmm) => { const x = C.calibFor(cal, fam, T(hhmm)); return x && x.tag; };
  assert.deepEqual([pick("307", "10:00"), pick("307", "22:00"), pick("265區", "10:00"), pick("265區", "22:00"), pick(undefined, "10:00")],
    ["307白天", "307夜間", "白天合併", null, "白天合併"]);
  assert.equal(C.calibFor(null, "307", T("10:00")), null);
  assert.equal(C.calibFor(CAL, "307", T("10:00")), CAL, "舊格式：整份只有一張表");
  assert.equal(C.calibFor({}, "307", T("10:00")), null);
});

// ---------------------------------------------------------------- 多來源、站牌看板、附近站牌、搜尋
test("預估到站：不指定路線就全部收；指定就只收那些路線", () => {
  const blob = { EssentialInfo: { UpdateTime: "2026-10-03 09:30:00" }, BusInfo: [
    { RouteID: 90, StopID: 1001, GoBack: "0", EstimateTime: "120" }, { RouteID: 77, StopID: 5, GoBack: "1", EstimateTime: "-3" }] };
  assert.equal(C.indexEta(blob, null).map.size, 2);
  assert.deepEqual([...C.indexEta(blob, ["90"]).map.keys()], ["90|0|1001"]);
  // 另一份索引不含 GoBack：這個欄位是「下一班車的狀態」，不是站牌的方向
  assert.deepEqual([...C.indexEta(blob, null).byStop.entries()], [["90|1001", [120, "0"]], ["77|5", [-3, "1"]]]);
});

test("兩個來源的預估到站併成一份：秒數換算到最新那份的時刻，代碼原樣保留", () => {
  const a = { updateMs: T("09:30"), map: new Map([["90|0|1", 120], ["90|0|2", -1], ["90|0|3", 5]]),
              byStop: new Map([["90|1", [120, "0"]], ["90|2", [-1, "2"]], ["90|3", [5, "1"]]]) };
  const b = { updateMs: T("09:30") + 10e3, map: new Map([["77|0|9", 60]]), byStop: new Map([["77|9", [60, "2"]]]) };
  const m = C.mergeEta([a, null, b]);
  assert.equal(m.updateMs, T("09:30") + 10e3);
  assert.deepEqual([...m.map.entries()], [["90|0|1", 110], ["90|0|2", -1], ["90|0|3", 0], ["77|0|9", 60]]);
  assert.deepEqual([...m.byStop.entries()], [["90|1", [110, "0"]], ["90|2", [-1, "2"]], ["90|3", [0, "1"]], ["77|9", [60, "2"]]]);
  // 換算前後指的是同一個到站時刻
  assert.equal(m.updateMs + m.map.get("90|0|1") * 1000, a.updateMs + 120e3);
  assert.equal(C.mergeEta([null, { updateMs: NaN, map: new Map() }]), null);
});

test("站牌上某條路線的官方下一班：有分鐘數給時刻，代碼原樣回傳，沒資料回傳 null", () => {
  const eta = { updateMs: T("09:30"), byStop: new Map([["90|1001", [180, "0"]], ["90|1002", [0, "0"]], ["90|2001", [-3, "3"]],
                                                         ["90|1003", [600, "2"]], ["90|2002", [240, "0"]], ["90|1004", [-1, "2"]]]) };
  assert.deepEqual(C.officialNext(eta, 90, 1001, 0), { ms: T("09:33"), onLeg: true });
  assert.deepEqual(C.officialNext(eta, 90, 1002, 0), { ms: T("09:30"), onLeg: true });
  assert.deepEqual(C.officialNext(eta, 90, 2001, 1), { code: -3 });
  assert.deepEqual(C.officialNext(eta, 90, 1004, 0), { code: -1 });
  // 有預估秒數，但那班車還沒開始跑這個方向：尚未發車（2），或還在對向那一趟（返程站牌、車在去程）
  assert.deepEqual(C.officialNext(eta, 90, 1003, 0), { ms: T("09:40"), onLeg: false });
  assert.deepEqual(C.officialNext(eta, 90, 2002, 1), { ms: T("09:34"), onLeg: false });
  assert.equal(C.officialNext(eta, 91, 1001, 0), null, "別條路線");
  assert.equal(C.officialNext(null, 90, 1001, 0), null);
});

test("官方有預估但那班車還沒開始跑這個方向：車不足兩班的站補一筆「官方・未發車」", () => {
  // 站 2：尚未發車（GoBack 2）10 分後到；站 4：車還在對向那一趟（GoBack 1）；站 6：下一班就在這個方向上、但沒追蹤到（未定位）
  const eta = etaOf("09:30", [[2, 600, "2"], [4, 720, "1"], [6, 300, "0"], [8, -1, "2"]]);
  const r = C.routeArrivals(C.createTracker([VARIANT]), "900", eta, T("09:30"));
  assert.deepEqual(at(r.perStop[2]), [[null, "09:40", "官方・未發車"]]);
  assert.deepEqual(at(r.perStop[4]), [[null, "09:42", "官方・未發車"]]);
  assert.deepEqual(at(r.perStop[6]), [[null, "09:35", "官方・未定位"]], "方向相同的照舊，不重複列");
  assert.deepEqual(r.perStop[8], [], "代碼（沒有秒數）不列");
  // 沒有可驗證的車：不給最早時間
  assert.equal(C.calibGroup("官方・未發車"), null);
  assert.equal(C.earliestMs({ ms: T("09:40"), source: "官方・未發車" }, T("09:30"), CAL), null);
  // 這一站已經有兩班車就不補
  const busy = trackerWith([["09:30", [fix("A", 0.6, "09:30"), fix("B", 1.2, "09:30")]]]);
  assert.deepEqual(C.routeArrivals(busy, "900", eta, T("09:30")).perStop[2].map((x) => x.bus), ["B", "A"]);
  // 逐班表路線：官方的未發車預估與班表推出來的是同一班（3 分內），不重複列
  const tt = C.routeArrivals(C.createTracker([TT]), "901", etaOf("09:20", [[3, 21 * 60, "2"]], "91"), T("09:20"));
  assert.deepEqual(at(tt.perStop[3]), [[null, "09:41", "官方・未發車"], [null, "10:10", "班表"]]);
});

test("線型是直線近似的路線：車離折線較遠也算在路線上（由變體自己帶容許距離）", () => {
  const far = 0.0027;                                   // 約 300 m
  const strict = trackerWith([["09:30", [fix("A", 2, "09:30", { offDeg: far })]]]);
  assert.equal(C.activeBuses(strict, "900", T("09:30")).length, 0, "一般路線：超過 150 m 不採用");
  const loose = trackerWith([["09:30", [fix("A", 2, "09:30", { offDeg: far })]]], [{ ...VARIANT, maxOffsetM: 400 }]);
  assert.deepEqual(C.activeBuses(loose, "900", T("09:30")).map((b) => b.id), ["A"]);
  const tooFar = trackerWith([["09:30", [fix("A", 2, "09:30", { offDeg: 0.0045 })]]], [{ ...VARIANT, maxOffsetM: 400 }]);
  assert.equal(C.activeBuses(tooFar, "900", T("09:30")).length, 0, "約 500 m：放寬後仍不採用");
});

test("附近站牌：依距離排序，超過範圍不列，對向站牌都列", () => {
  const me = { lat: 25.05, lon: 121.5 };
  const at = (north, east) => [me.lat + north / 110540, me.lon + east / (111320 * Math.cos(me.lat * Math.PI / 180))];
  const plats = [[1, "甲（對向）", ...at(120, 0), []], [2, "甲", ...at(90, 0), []], [3, "乙", ...at(0, 300), []],
                 [4, "太遠", ...at(0, 900), []], [5, "非常遠", me.lat + 0.5, me.lon, []]];
  const near = C.nearestPlatforms(plats, me, 500, 10);
  assert.deepEqual(near.map((x) => [x.plat[0], Math.round(x.d)]), [[2, 90], [1, 120], [3, 300]]);
  assert.deepEqual(C.nearestPlatforms(plats, me, 500, 2).map((x) => x.plat[0]), [2, 1]);
  assert.equal(Math.round(C.distM(me, { lat: at(300, 400)[0], lon: at(300, 400)[1] })), 500);
});

test("搜尋路線：完全相符最前、開頭相符其次、名稱短的優先；空字串不回傳", () => {
  const routes = [["a", "紅57"], ["b", "577"], ["c", "57"], ["d", "657"], ["e", "57區"], ["f", "265"]];
  assert.deepEqual(C.searchRoutes(routes, "57", 10).map((r) => r[1]), ["57", "577", "57區", "657", "紅57"]);
  assert.deepEqual(C.searchRoutes(routes, " 57 ", 2).map((r) => r[1]), ["57", "577"]);
  assert.deepEqual(C.searchRoutes(routes, "", 10), []);
  assert.deepEqual(C.searchRoutes(routes, "999", 10), []);
  // 開頭相符的排在「只是包含」的前面，即使名稱比較長
  assert.deepEqual(C.searchRoutes([["a", "157"], ["b", "57區間"], ["c", "57"]], "57", 10).map((r) => r[1]), ["57", "57區間", "157"]);
  // 同樣是開頭相符，名稱短的優先（572 排在 5710 前面）
  assert.deepEqual(C.searchRoutes([["a", "5710"], ["b", "572"]], "57", 10).map((r) => r[1]), ["572", "5710"]);
});

test("搜尋站名：同名站牌歸在一起", () => {
  const plats = [[1, "國泰街口", 25, 121.5, []], [2, "國泰街口", 25.0002, 121.5, []], [3, "國泰醫院", 25.03, 121.55, []], [4, "海山國小", 25, 121.47, []]];
  const r = C.searchStops(plats, "國泰", 10);
  assert.deepEqual(r.map((x) => [x.name, x.plats.map((p) => p[0])]), [["國泰街口", [1, 2]], ["國泰醫院", [3]]]);
  assert.deepEqual(C.searchStops(plats, "國泰街口", 10).map((x) => x.name), ["國泰街口"]);
  assert.deepEqual(C.searchStops(plats, "", 10), []);
  const more = [[1, "新北板橋公車站", 25, 121.46, []], [2, "板橋公車站前", 25, 121.46, []], [3, "板橋", 25, 121.46, []]];
  assert.deepEqual(C.searchStops(more, "板橋", 10).map((x) => x.name), ["板橋", "板橋公車站前", "新北板橋公車站"]);
  assert.deepEqual(C.searchStops([[1, "後板橋", 25, 121.46, []], [2, "板橋公車站前", 25, 121.46, []]], "板橋", 10).map((x) => x.name),
    ["板橋公車站前", "後板橋"], "開頭相符的排前面，即使比較長");
});

// 同一條路線、同方向的兩個變體：主線停站 0～10，繞駛線少停站 3、4（其餘站牌相同），兩者共用同一組官方預估
const MAIN = { ...VARIANT, subRouteId: "700", routeId: "70", tid: "700|0", key: "主線", display: "主線" };
const DETOUR = { ...VARIANT, subRouteId: "701", routeId: "70", tid: "701|0", key: "繞駛", display: "繞駛",
  stops: VARIANT.stops.filter((s) => s.km !== 3 && s.km !== 4) };
const sibFix = (id, km, route) => ({ ...fix(id, km, "09:30"), RouteID: route });
const srcAt = (r, si) => r.perStop[si].map((x) => [x.bus, x.source]);

test("多個變體共用官方預估：只有一個變體有車時，另一個變體不會多出一筆未定位", () => {
  const tr = C.createTracker([MAIN, DETOUR]);
  C.ingestBusData(tr, { BusInfo: [sibFix("甲", 2, "700")] }, T("09:30"));
  const eta = etaOf("09:30", [[6, 8 * 60]], "70");
  assert.deepEqual(srcAt(C.routeArrivals(tr, "700|0", eta, T("09:30")), 6), [["甲", "官方"]]);
  const d = C.routeArrivals(tr, "701|0", eta, T("09:30"));
  assert.deepEqual(d.perStop[DETOUR.stops.findIndex((s) => s.km === 6)], [], "繞駛線沒有車；這個數字說的是主線的甲");
});

test("多個變體共用官方預估：兩個變體都有車時，分給離那一站最近的那台，另一台改用推算", () => {
  const tr = C.createTracker([MAIN, DETOUR]);
  C.ingestBusData(tr, { BusInfo: [sibFix("甲", 2, "700"), sibFix("乙", 5, "701")] }, T("09:30"));
  const eta = etaOf("09:30", [[6, 3 * 60], [8, 9 * 60]], "70");
  const m = C.routeArrivals(tr, "700|0", eta, T("09:30")), d = C.routeArrivals(tr, "701|0", eta, T("09:30"));
  const di = (km) => DETOUR.stops.findIndex((s) => s.km === km);
  assert.deepEqual(srcAt(d, di(6)), [["乙", "官方"]], "乙離站 6 只有 1 km");
  assert.deepEqual(srcAt(m, 6), [["甲", "預設"]], "甲離站 6 有 4 km：官方說的不是它");
  assert.deepEqual(srcAt(d, di(8)), [["乙", "官方"]]);
  assert.equal(m.perStop[6].filter((x) => x.bus == null).length + d.perStop[di(6)].filter((x) => x.bus == null).length, 0);
  // 只有主線停的站 3：沒有別的變體來搶
  const eta3 = etaOf("09:30", [[3, 2 * 60]], "70");
  assert.deepEqual(srcAt(C.routeArrivals(tr, "700|0", eta3, T("09:30")), 3), [["甲", "官方"]]);
});

test("多個變體共用官方預估：都沒有車時，未定位只列一次", () => {
  const tr = C.createTracker([MAIN, DETOUR]);
  const eta = etaOf("09:30", [[6, 8 * 60]], "70");
  const m = C.routeArrivals(tr, "700|0", eta, T("09:30")), d = C.routeArrivals(tr, "701|0", eta, T("09:30"));
  const all = [...m.perStop[6], ...d.perStop[DETOUR.stops.findIndex((s) => s.km === 6)]];
  assert.deepEqual(all.map((x) => [x.bus, x.source]), [[null, "官方・未定位"]]);
  // 不同路線（主路線編號不同）或不同方向不算同一組：各自照舊
  const other = C.createTracker([MAIN, { ...DETOUR, routeId: "71" }]);
  assert.equal(C.routeArrivals(other, "700|0", eta, T("09:30")).perStop[6].length, 1);
});

test("多個變體共用官方預估：別條路線的車、已經過站的車都不算", () => {
  const eta = etaOf("09:30", [[6, 8 * 60]], "70");
  // 乙離站 6 比較近，但它是別條路線（主路線編號 71）：路線 70 的預估說的還是甲
  const a = C.createTracker([{ ...DETOUR, routeId: "71" }, MAIN]);
  C.ingestBusData(a, { BusInfo: [sibFix("甲", 2, "700"), sibFix("乙", 5, "701")] }, T("09:30"));
  assert.deepEqual(srcAt(C.routeArrivals(a, "700|0", eta, T("09:30")), 6), [["甲", "官方"]]);
  // 同一條路線的另一個變體有車，但它已經過了站 6：輪到後面的甲
  const b = C.createTracker([MAIN, DETOUR]);
  C.ingestBusData(b, { BusInfo: [sibFix("甲", 2, "700"), sibFix("乙", 7, "701")] }, T("09:30"));
  assert.deepEqual(srcAt(C.routeArrivals(b, "700|0", eta, T("09:30")), 6), [["甲", "官方"]]);
  // 反方向的變體也不算
  const c = C.createTracker([MAIN, { ...DETOUR, direction: 1, tid: "701|1" }]);
  C.ingestBusData(c, { BusInfo: [sibFix("甲", 2, "700"), { ...sibFix("乙", 5, "701"), GoBack: "1" }] }, T("09:30"));
  assert.deepEqual(srcAt(C.routeArrivals(c, "700|0", eta, T("09:30")), 6), [["甲", "官方"]]);
});

test("後車在同一站不會顯示得比前車早", () => {
  // 前車在 5 km，官方說 10 分後到站 6（很慢）；後車在 4.5 km，照預設車速 5 分就到——畫面上會變成遠的比近的早到
  const tr = trackerWith([["09:30", [fix("前", 5, "09:30"), fix("後", 4.5, "09:30")]]]);
  const r = C.routeArrivals(tr, "900", etaOf("09:30", [[6, 10 * 60]]), T("09:30"));
  assert.deepEqual(at(r.perStop[6]), [["前", "09:40", "官方"], ["後", "09:40", "預設"]], "後車被拉到和前車同時，順序照實際前後");
  // 下一站也一樣：前車 09:40 + 1 km ÷ 18 km/h ≈ 09:43，後車自己算是 09:38
  assert.deepEqual(at(r.perStop[7]), [["前", "09:43", "官方→預設"], ["後", "09:43", "預設"]]);
  // 前車已經過的站不受限：後車照自己的推算（0.5 km ÷ 18 km/h）
  assert.deepEqual(at(r.perStop[5]), [["後", "09:31", "預設"]]);
  // 後車本來就比較晚的時候不動
  const far = trackerWith([["09:30", [fix("前", 5, "09:30"), fix("後", 1, "09:30")]]]);
  const f = C.routeArrivals(far, "900", etaOf("09:30", [[6, 2 * 60]]), T("09:30"));
  assert.deepEqual(at(f.perStop[6]), [["前", "09:32", "官方"], ["後", "09:46", "預設"]]);
});

test("後車不早於前車只看同一個變體：別條路線的車不互相限制", () => {
  const OTHER = { ...VARIANT, subRouteId: "950", routeId: "95", tid: "950|0", key: "別條" };
  const tr = C.createTracker([VARIANT, OTHER]);
  C.ingestBusData(tr, { BusInfo: [fix("前", 5, "09:30"), { ...fix("別", 4.5, "09:30"), RouteID: "950" }] }, T("09:30"));
  const eta = etaOf("09:30", [[6, 10 * 60]]);
  assert.deepEqual(at(C.routeArrivals(tr, "950|0", eta, T("09:30")).perStop[6]), [["別", "09:35", "預設"]]);
});

test("後車不早於前車：三台車時逐台往後傳；前車超出推估範圍的站，後車也不會倒退", () => {
  // 最前面的車已過站 6；中間的車官方說 10 分後到站 6；最後一台照預設車速 5 分就到
  const tr = trackerWith([["09:30", [fix("甲", 7, "09:30"), fix("乙", 5, "09:30"), fix("丙", 4.5, "09:30")]]]);
  const r = C.routeArrivals(tr, "900", etaOf("09:30", [[6, 10 * 60]]), T("09:30"));
  assert.deepEqual(at(r.perStop[6]), [["乙", "09:40", "官方"], ["丙", "09:40", "預設"]], "丙要看它正前方的乙，不是最前面的甲");
  // 推估範圍只到 12 分鐘後：前車在站 7 已超出範圍（不列），後車在站 7 仍不能比它自己在站 6 的時刻早
  const keep = C.P.horizonMin;
  try {
    C.P.horizonMin = 12;
    const two = trackerWith([["09:30", [fix("前", 5, "09:30"), fix("後", 4.5, "09:30")]]]);
    const h = C.routeArrivals(two, "900", etaOf("09:30", [[6, 10 * 60]]), T("09:30"));
    assert.deepEqual(at(h.perStop[7]), [], "前車在站 7 已超出推估範圍：後車更不可能在範圍內到，一樣不列");
    // 中間夾一台超出範圍的車，最後面的車也不會跳過它、反而顯示得比更前面的車早
    const three = trackerWith([["09:30", [fix("前", 5, "09:30"), fix("中", 4.8, "09:30"), fix("後", 4.5, "09:30")]]]);
    const e3 = C.routeArrivals(three, "900", etaOf("09:30", [[6, 11.5 * 60]]), T("09:30"));
    assert.deepEqual(at(e3.perStop[6]).map((x) => x[0]), ["前", "中", "後"]);
    assert.deepEqual(at(e3.perStop[7]), []);
  } finally { C.P.horizonMin = keep; }
});

// ---------------------------------------------------------------- 路線在執行中加入、站牌方位、路線名稱
test("追蹤器可以之後再加路線：新路線照常收定位，重複加入不會多出一份", () => {
  const LATE = { ...VARIANT, subRouteId: "930", routeId: "93", key: "晚加" };
  const tr = C.createTracker([VARIANT]);
  assert.equal(C.entOf(tr, "930", "0"), null, "還沒加入的路線不認得");
  assert.deepEqual(C.addVariants(tr, [LATE]).map((e) => e.v.key), ["晚加"]);
  C.ingestBusData(tr, { BusInfo: [fix("新車", 2, "09:30", { route: "930" }), fix("舊車", 3, "09:30")] }, T("09:30"));
  assert.deepEqual(C.activeBuses(tr, "930", T("09:30")).map((b) => b.id), ["新車"]);
  assert.deepEqual(C.activeBuses(tr, "900", T("09:30")).map((b) => b.id), ["舊車"]);
  // 再加一次同一個變體：略過，追蹤單位不會變兩份（不然同一台車會被算兩次）
  assert.deepEqual(C.addVariants(tr, [LATE, VARIANT]), []);
  assert.equal(tr.ents.length, 2);
});

test("之後加入的路線和原有路線互相借用段速（兩個方向都要記）", () => {
  const P1 = { ...VARIANT, subRouteId: "940", routeId: "94", key: "原有" };
  const P2 = { ...VARIANT, subRouteId: "941", routeId: "95", key: "後加" };
  const P3 = { ...VARIANT, subRouteId: "942", routeId: "96", key: "再後加" };
  const tr = C.createTracker([P1]);
  C.addVariants(tr, [P2]);
  const shared = (key) => tr.ents.find((e) => e.v.key === key).shared.map((x) => x.ent.v.key).sort();
  assert.deepEqual(shared("原有"), ["後加"], "原有的路線也要能借新路線的段速");
  assert.deepEqual(shared("後加"), ["原有"]);
  C.addVariants(tr, [P3]);
  assert.deepEqual(shared("原有"), ["再後加", "後加"], "已經記過的不會再記一次");
  assert.deepEqual(shared("後加"), ["再後加", "原有"]);
  assert.deepEqual(shared("再後加"), ["原有", "後加"]);
  // 和一次建好的結果相同
  const once = C.createTracker([P1, P2, P3]);
  assert.deepEqual(once.ents.map((e) => e.shared.length), tr.ents.map((e) => e.shared.length));
});

test("八方位與方位差", () => {
  assert.deepEqual([0, 22, 23, 90, 104, 180, 291, 337, 338, 359, 360, -45].map(C.compass8),
    ["北", "北", "東北", "東", "東", "南", "西", "西北", "北", "北", "北", "西北"]);
  assert.deepEqual([[10, 350], [350, 10], [0, 180], [104, 291], [90, 90], [200, 20]].map(([a, b]) => C.headingDiff(a, b)), [20, 20, 180, 173, 0, 180]);
});

// ---------------------------------------------------------------- 候車位置
const PLAT = 25.0465, PLON = 121.52, PM = 1 / 110540;                     // 往北 1 公尺是多少緯度
/** 一根站牌：編號、行車方位、在基準點北方幾公尺；其餘欄位（bay、addr、units）放 extra。 */
const pole = (id, heading, northM = 0, extra = {}) => ({ id, heading, lat: PLAT + northM * PM, lon: PLON, ...extra });
const groupsOf = (ps) => C.positions(ps).map((x) => x.ids);
const labelsOf = (ps) => C.positions(ps).map((x) => x.label);

test("月台編號：國字與數字都認得，不是月台名回傳 null", () => {
  assert.deepEqual(["第一月台", "第三月台", "第九月台", "第十月台", "第十二月台", "第二十月台", "第二十三月台", "第9月台", "第12月台"].map(C.bayNo), [1, 3, 9, 10, 12, 20, 23, 9, 12]);
  assert.deepEqual(["", null, undefined, "下客月台", "第月台", "第一二月台", "第三月台旁", "月台", "第十十月台"].map(C.bayNo), [null, null, null, null, null, null, null, null, null]);
});

test("候車位置：馬路兩側各一個，順序照方位（北→西北），和傳入順序無關", () => {
  // 國泰街口：往東 104 度、往西 291 度
  const east = pole("6186", 104, 0, { addr: "民族路290號" }), west = pole("2688", 291, 20, { addr: "民族路261號" });
  const want = [{ id: "6186", ids: ["6186"], heading: 104, bay: "", addr: "民族路290號", label: "往東", long: "往東・民族路290號" },
                { id: "2688", ids: ["2688"], heading: 291, bay: "", addr: "民族路261號", label: "往西", long: "往西・民族路261號" }];
  assert.deepEqual(C.positions([east, west]), want);
  assert.deepEqual(C.positions([west, east]), want, "先給西也一樣：往東排前面");
  assert.deepEqual(C.positions([]), []);
  // 同一根站牌重複給：只算一次
  assert.deepEqual(groupsOf([east, east, west]), [["6186"], ["2688"]]);
  // 編號給數字也可以，回傳一律是字串（存起來的「上次看的位置」是字串，要對得上）
  assert.deepEqual(C.positions([{ ...east, id: 6186 }, { ...west, id: 2688 }]).map((x) => [x.id, x.ids]), [["6186", ["6186"]], ["2688", ["2688"]]]);
});

test("候車位置：方位差 45 度以內、相隔 80 公尺以內才併，而且要和那一組的每一根都合", () => {
  // 方位：差 45 度以內算同方向（含正北兩側 350 與 35）；差 46 度就分開
  assert.deepEqual(groupsOf([pole("1", 350), pole("2", 35)]), [["1", "2"]]);
  assert.deepEqual(groupsOf([pole("1", 350), pole("2", 36)]), [["1"], ["2"]]);
  // 距離：門檻 80 公尺
  assert.deepEqual(groupsOf([pole("1", 90, 0), pole("2", 90, 79.5)]), [["1", "2"]]);
  assert.deepEqual(groupsOf([pole("1", 90, 0), pole("2", 90, 80.5)]), [["1"], ["2"]]);
  // 行政院：往撫遠街的站牌 179 度、往板橋的 216 度，方位只差 37 度，但相隔約 250 公尺 → 兩個位置
  assert.deepEqual(groupsOf([pole("1", 179, 0), pole("2", 216, 250)]), [["1"], ["2"]]);
  // 一長排站牌（0、60、120 公尺）：第三根離第一根 120 公尺，不能因為離第二根近就一路串下去
  assert.deepEqual(groupsOf([pole("1", 90, 0), pole("2", 90, 60), pole("3", 90, 120)]), [["1", "2"], ["3"]]);
  // 方位也一樣：0、40、80 度，第三根和第一根差 80 度
  assert.deepEqual(groupsOf([pole("1", 0, 0), pole("2", 40, 5), pole("3", 80, 10)]), [["1", "2"], ["3"]]);
  // 沒給座標：只看方位（測試資料、索引讀不到時）
  assert.deepEqual(groupsOf([{ id: "1", heading: 90 }, pole("2", 90, 500)]), [["1", "2"]]);
  assert.deepEqual(groupsOf([pole("1", 90, 0), { id: "2", heading: 90 }]), [["1", "2"]], "後面那根沒座標也一樣");
});

test("候車位置：結果和傳入的順序無關（先照站牌編號排再分組）", () => {
  const ps = [pole("30", 90, 120), pole("10", 90, 0), pole("20", 90, 60), pole("40", 270, 10), pole("5", null, 0, { addr: "總站" })];
  const want = JSON.stringify(C.positions(ps));
  const perms = [[0, 1, 2, 3, 4], [4, 3, 2, 1, 0], [2, 0, 4, 1, 3], [1, 2, 0, 4, 3], [3, 4, 0, 2, 1]];
  for (const pm of perms) assert.equal(JSON.stringify(C.positions(pm.map((i) => ps[i]))), want, pm.join(""));
  assert.deepEqual(C.positions(ps).map((x) => x.ids), [["10", "20"], ["30"], ["40"], ["5"]], "編號小的先分組；方位不明的排最後");
  // 編號照數字排（9 在 10 前面），不是照字元
  assert.deepEqual(groupsOf([pole("10", 90, 0), pole("9", 90, 60), pole("100", 90, 120)]), [["9", "10"], ["100"]]);
});

test("候車位置：同一條路線去程停這根、返程停那根，方位再接近也不併", () => {
  // 折返點：兩根站牌算出來都往北、相隔 20 公尺，但 307 的去程停甲、返程停乙
  const a = pole("1", 0, 0, { units: ["tpe:16111|0", "tpe:10482|0"] }), b = pole("2", 10, 20, { units: ["tpe:16111|1"] });
  assert.deepEqual(groupsOf([a, b]), [["1"], ["2"]]);
  // 同一條路線同方向停兩根（大站同方向的兩根站牌）、或兩根沒有共同的路線：照方位與距離併
  assert.deepEqual(groupsOf([a, pole("2", 10, 20, { units: ["tpe:16111|0"] })]), [["1", "2"]]);
  assert.deepEqual(groupsOf([a, pole("2", 10, 20, { units: ["tpe:99999|1"] })]), [["1", "2"]]);
  assert.deepEqual(groupsOf([a, pole("2", 10, 20)]), [["1", "2"]], "沒給路線就不比");
  // 路線鍵要整個相同才算同一條：tpe:1611 和 tpe:16111 不是同一條
  assert.deepEqual(groupsOf([a, pole("2", 10, 20, { units: ["tpe:1611|1"] })]), [["1", "2"]]);
  // 和這一組的每一根比：第三根和第二根對向，就不能進這一組
  const c = pole("3", 5, 10, { units: ["tpe:10482|1"] });
  assert.deepEqual(groupsOf([a, pole("2", 10, 20, { units: ["tpe:500|0"] }), c]), [["1", "2"], ["3"]]);
});

test("候車位置：地址寫的月台不同就不併，順序照月台編號", () => {
  // 板橋公車站：四個月台出站都往西北、彼此相隔十幾公尺；另外兩根同站名、地址沒寫月台的站牌，一根同方位又近、一根在對面
  const ps = [pole("2673", 320, 0, { bay: "第三月台", addr: "縣民大道公車專用月台第三月台" }), pole("70620", null, 30, { bay: "第四月台" }),
              pole("70716", 326, 10, { bay: "第一月台" }), pole("70717", 337, 20, { bay: "第二月台" }),
              pole("80001", 306, 5, { addr: "月台出口" }), pole("80000", 127, 40, { addr: "月台出口對面" })];
  const pos = C.positions(ps);
  assert.deepEqual(pos.map((x) => [x.label, x.ids]), [["第一月台", ["70716"]], ["第二月台", ["70717"]], ["第三月台", ["2673", "80001"]], ["第四月台", ["70620"]], ["往東南", ["80000"]]]);
  assert.deepEqual(pos.map((x) => x.long), ["第一月台", "第二月台", "第三月台", "第四月台", "往東南・月台出口對面"]);
  assert.equal(pos[2].heading, 313, "一組的方位是各根的平均");
  assert.equal(pos[3].heading, null, "方位不明的月台照樣照編號排，不排到最後");
  // 沒有月台的站牌可以併進某個月台（同方位、夠近），那一組就叫那個月台
  assert.deepEqual(C.positions([pole("1", 90, 0, { addr: "路邊" }), pole("2", 90, 10, { bay: "第二月台" })]).map((x) => [x.label, x.ids]), [["第二月台", ["1", "2"]]]);
  // 一組的地址取第一根「有地址」的站牌，不是第一根站牌
  assert.deepEqual(C.positions([pole("1", 90, 0), pole("2", 90, 10, { addr: "乙路2號" })]).map((x) => [x.addr, x.long]), [["乙路2號", "往東・乙路2號"]]);
  // 同一個月台的兩根站牌：併
  assert.deepEqual(groupsOf([pole("1", 90, 0, { bay: "第一月台" }), pole("2", 90, 10, { bay: "第一月台" })]), [["1", "2"]]);
  // 月台編號照數字排：第 10 月台在第 2 月台後面
  assert.deepEqual(labelsOf([pole("1", 0, 0, { bay: "第10月台" }), pole("2", 0, 10, { bay: "第2月台" }), pole("3", 0, 20, { bay: "第1月台" })]), ["第1月台", "第2月台", "第10月台"]);
});

test("候車位置：站名不同的站牌不併，標籤帶上站名多出來的那一段", () => {
  // 板橋公車站（座標照實際的換算）：新府路那兩根是另一個站名的牌子，70667 離第三月台 67 公尺、方位只差 14 度
  const N = "新北板橋公車站", S = "新北板橋公車站(新府路)";
  const ps = [pole("2673", 320, 0, { name: N, bay: "第三月台" }), pole("70716", 326, 0, { name: N, bay: "第一月台" }),
              pole("70667", 306, 67, { name: S, addr: "板橋火車站西側門" }), pole("70666", 127, 52, { name: S, addr: "板橋火車站西側門對面" })];
  const want = [["第一月台", ["70716"]], ["第三月台", ["2673"]], ["新府路 往東南", ["70666"]], ["新府路 往西北", ["70667"]]];
  assert.deepEqual(C.positions(ps).map((x) => [x.label, x.ids]), want);
  assert.deepEqual(C.positions([...ps].reverse()).map((x) => [x.label, x.ids]), want, "和傳入順序無關：沒有多出一段的站名排前面");
  assert.deepEqual(C.positions(ps).map((x) => x.long), ["第一月台", "第三月台", "新府路・往東南・板橋火車站西側門對面", "新府路・往西北・板橋火車站西側門"]);
  // 差別只在站名：同一批站牌都叫同一個站名（或都沒給站名），70667 就併進第三月台
  assert.deepEqual(groupsOf(ps.map((q) => ({ ...q, name: N }))), [["70716"], ["2673", "70667"], ["70666"]]);
  assert.deepEqual(groupsOf(ps.map(({ name, ...q }) => q)), [["70716"], ["2673", "70667"], ["70666"]]);
  // 一邊有站名、一邊沒給：當成不同
  assert.deepEqual(groupsOf([pole("1", 90, 0, { name: "甲站" }), pole("2", 90, 10)]), [["1"], ["2"]]);
  // 那個站名只有一個位置：標籤就是多出來的那一段；完整寫法照樣帶方位與地址
  const one = C.positions([pole("1", 90, 0, { name: "甲站" }), pole("2", 90, 10, { name: "甲站(乙路)", addr: "乙路5號" }), pole("3", 95, 20, { name: "甲站(乙路)" })]);
  assert.deepEqual(one.map((x) => [x.label, x.long, x.ids]), [["往東", "往東", ["1"]], ["乙路", "乙路・往東・乙路5號", ["2", "3"]]]);
  // 「這個方位只有一組」是在同一個站名裡數：兩個站名各有一組往東，互不影響
  assert.deepEqual(labelsOf([pole("1", 90, 0, { name: "甲站", addr: "甲路1號" }), pole("2", 90, 300, { name: "甲站(乙路)" }), pole("3", 270, 300, { name: "甲站(乙路)" })]),
    ["往東", "乙路 往東", "乙路 往西"]);
  // 多出來的那一段：全形括號也認得；兩個站名都有括號；有月台的寫月台
  assert.deepEqual(labelsOf([pole("1", 90, 0, { name: "甲站" }), pole("2", 90, 10, { name: "甲站（乙路）" })]), ["往東", "乙路"]);
  assert.deepEqual(labelsOf([pole("1", 90, 0, { name: "甲站(乙路)" }), pole("2", 90, 10, { name: "甲站(丁街)" })]), ["丁街", "乙路"]);
  const bays = C.positions([pole("1", 0, 0, { name: "甲站" }), pole("2", 0, 10, { name: "甲站(乙路)", bay: "第二月台" }), pole("3", 0, 20, { name: "甲站(乙路)", bay: "第一月台" })]);
  assert.deepEqual(bays.map((x) => [x.label, x.long]), [["往北", "往北"], ["乙路 第一月台", "乙路・第一月台"], ["乙路 第二月台", "乙路・第二月台"]]);
  // 括號前面不一樣：整個站名當標籤
  assert.deepEqual(labelsOf([pole("1", 90, 0, { name: "甲站" }), pole("2", 90, 10, { name: "丙站(乙路)" })]), ["丙站(乙路)", "甲站"]);
  // 同一個站名、同方位、沒有地址的兩個位置：只剩那一段可以寫，加編號
  assert.deepEqual(labelsOf([pole("1", 90, 0, { name: "甲站" }), pole("2", 0, 0, { name: "甲站(乙路)" }), pole("3", 0, 300, { name: "甲站(乙路)" })]), ["往東", "乙路 1", "乙路 2"]);
  // 只有一個站名：括號不拆（一般的站都走這裡）
  assert.deepEqual(labelsOf([pole("1", 90, 0, { name: "甲站(乙路)" }), pole("2", 270, 10, { name: "甲站(乙路)" })]), ["往東", "往西"]);
  assert.deepEqual(Object.keys(C.positions(ps)[2]).sort(), ["addr", "bay", "heading", "id", "ids", "label", "long"], "回傳的欄位不變");
});

test("候車位置的標籤：方位在這個地點只有一組才寫方位，不然寫短地址；撞名的加編號", () => {
  // 捷運西門站：往北三個、往南兩個 → 都寫地址；完整寫法帶方位
  const ximen = C.positions([pole("1793", 14, 0, { addr: "中華路一段上公車專用道近寶慶路" }), pole("4608", 195, 300, { addr: "中華路一段166號" }),
                             pole("50040", 15, 600, { addr: "中華路一段台北憲兵隊前" }), pole("1000079", 195, 900, { addr: "中華路一段公車專用道" })]);
  assert.deepEqual(ximen.map((x) => x.label), ["中華路一段上公車專用道近寶慶路", "中華路一段台北憲兵隊前", "中華路一段166號", "中華路一段公車專用道"]);
  assert.equal(ximen[0].long, "往北・中華路一段上公車專用道近寶慶路");
  // 兩個往北、一個往南：往南只有一組，寫方位
  assert.deepEqual(labelsOf([pole("1", 0, 0, { addr: "甲路1號" }), pole("2", 0, 300, { addr: "乙路2號" }), pole("3", 180, 0, { addr: "丙路3號" })]), ["甲路1號", "乙路2號", "往南"]);
  // 月台不算進「這個方位有幾組」：月台往西北，另有一根往西北的站牌，後者照樣寫「往西北」
  assert.deepEqual(labelsOf([pole("1", 315, 0, { bay: "第一月台" }), pole("2", 315, 300, { addr: "路口" })]), ["第一月台", "往西北"]);
  // 350 度與 10 度的平均是正北（不是 180）
  assert.deepEqual(C.positions([pole("1", 350, 0), pole("2", 10, 10)]).map((x) => [x.heading, x.label]), [[0, "往北"]]);
  // 方位不明：寫地址；連地址也沒有：站牌 N（N＝在這個地點排第幾個）
  assert.deepEqual(labelsOf([pole("1", 90, 0), pole("2", null, 0, { addr: "總站內" }), pole("3", null, 0)]), ["往東", "總站內", "站牌 3"]);
  // 同方位、地址又相同（或都沒有地址）：加編號才分得開，短標籤與完整寫法都要分得開
  const same = C.positions([pole("1", 0, 0, { addr: "山路門口" }), pole("2", 0, 300, { addr: "山路門口" })]);
  assert.deepEqual(same.map((x) => [x.label, x.long]), [["山路門口 1", "往北・山路門口 1"], ["山路門口 2", "往北・山路門口 2"]]);
  assert.deepEqual(labelsOf([pole("1", 0, 0), pole("2", 0, 300)]), ["往北 1", "往北 2"]);
  // 回傳的欄位就這幾個（分組時用的暫存欄位不外流）
  assert.deepEqual(Object.keys(C.positions([pole("1", 90)])[0]).sort(), ["addr", "bay", "heading", "id", "ids", "label", "long"]);
});

test("候車位置那一排的排法：文字、每個位置一顆分頁、第一個有關注的做分頁＋其他、整個用選單；有關注的位置不只一個就多一顆「全部」", () => {
  const mk = (...labels) => labels.map((label, i) => ({ id: String(i + 1), label }));
  const shape = (pos, watched, allSel) => { const b = C.positionBar(pos, watched, allSel); return [b.mode + (b.all ? "+全部" : ""), b.tabs.map((p) => p.id), b.rest.map((p) => p.id)]; };
  assert.deepEqual(shape(mk("往東"), []), ["plain", [], []]);
  assert.deepEqual(shape([], []), ["plain", [], []]);
  assert.deepEqual(shape(mk("往東", "往西"), []), ["tabs", ["1", "2"], []]);
  assert.deepEqual(shape(mk("往東", "往西"), ["2"]), ["tabs", ["1", "2"], []], "分頁順序不隨關注變");
  assert.deepEqual(shape(mk("往北", "往南", "往西南"), []), ["tabs", ["1", "2", "3"], []]);
  assert.deepEqual(shape(mk("往北", "往南", "往西南"), ["3"]), ["tabs", ["1", "2", "3"], []]);
  // 有關注路線的位置不只一個：多一顆「全部」。兩個位置還排得下；三個就改成「全部＋第一個有關注的＋其他」
  assert.deepEqual(shape(mk("往東", "往西"), ["1", "2"]), ["tabs+全部", ["1", "2"], []]);
  assert.deepEqual(shape(mk("往東", "往西"), ["2", "1"]), ["tabs+全部", ["1", "2"], []]);
  assert.deepEqual(shape(mk("往北", "往南", "往西南"), ["3", "2"]), ["more+全部", ["2"], ["1", "3"]], "全部＋三個位置＋選路線排不下");
  assert.equal(C.positionBar(mk("往東", "往西"), ["2"]).all, false, "只有一個位置有關注：不出「全部」");
  assert.equal(C.positionBar(mk("往東", "往西"), ["2", "9"]).all, false, "不存在的位置不算");
  // 四個以上：沒有關注時整個用選單；第一個有關注的做成分頁，其餘收進「其他」
  assert.deepEqual(shape(mk("第一月台", "第二月台", "第三月台", "第四月台"), []), ["drop", [], ["1", "2", "3", "4"]], "四個分頁加上「選路線」排不下");
  const bays = mk("第一月台", "第二月台", "第三月台", "第四月台", "往東南");
  assert.deepEqual(shape(bays, []), ["drop", [], ["1", "2", "3", "4", "5"]]);
  assert.deepEqual(shape(bays, ["3"]), ["more", ["3"], ["1", "2", "4", "5"]]);
  assert.deepEqual(shape(bays, ["3", "1"]), ["more+全部", ["1"], ["2", "3", "4", "5"]], "照位置的固定順序，不是照關注的先後；第二個有關注的收進其他");
  assert.deepEqual(shape(bays, ["5", "3", "1"]), ["more+全部", ["1"], ["2", "3", "4", "5"]]);
  assert.deepEqual(shape(bays, ["9"]), ["drop", [], ["1", "2", "3", "4", "5"]], "不存在的位置不算有關注");
  // 標籤是地址（超過 5 個字）：分頁放不下。看的是「會做成分頁的那一個」（第一個有關注的）短不短
  assert.deepEqual(shape(mk("往西北", "中正東路35號對向"), []), ["drop", [], ["1", "2"]]);
  assert.deepEqual(shape(mk("往西北", "中正東路35號對向"), ["1"]), ["more", ["1"], ["2"]], "有關注的那個標籤短：它做分頁");
  assert.deepEqual(shape(mk("往西北", "中正東路35號對向"), ["2"]), ["drop", [], ["1", "2"]], "有關注的那個標籤是地址：整個用選單");
  assert.deepEqual(shape(mk("往西北", "中正東路35號對向"), ["1", "2"]), ["more+全部", ["1"], ["2"]]);
  assert.deepEqual(shape(mk("中正東路35號對向", "往西北"), ["1", "2"]), ["drop+全部", [], ["1", "2"]], "第一個有關注的是地址：整個用選單，「全部」放在選單裡");
  // 5 個字算短（第12月台），6 個字算長
  assert.deepEqual(shape(mk("第12月台", "往東"), [])[0], "tabs");
  assert.deepEqual(shape(mk("第123月台", "往東"), [])[0], "drop");
  // 使用者在這個站選過「全部」：之後關注剩一個位置、甚至都取消了，「全部」還在（不然選路線面板開著時清單會整個換掉）
  assert.deepEqual(shape(mk("往東", "往西"), ["1"], true), ["tabs+全部", ["1", "2"], []]);
  assert.deepEqual(shape(mk("往東", "往西"), [], true), ["tabs+全部", ["1", "2"], []]);
  assert.deepEqual(shape(mk("往北", "往南", "往西南"), ["2"], true), ["more+全部", ["2"], ["1", "3"]]);
  assert.deepEqual(shape(bays, [], true), ["drop+全部", [], ["1", "2", "3", "4", "5"]]);
  assert.deepEqual(shape(mk("往東"), ["1"], true), ["plain", [], []], "只有一個位置：沒有「全部」可言");
  assert.deepEqual(shape([], [], true), ["plain", [], []]);
});

test("關注的單位鍵對得上全市索引；路線名拆成號碼與後綴；路線名照數字排", () => {
  assert.equal(C.unitKey({ src: "ntpc", routeId: 10164, direction: 1 }), "ntpc:10164|1");
  assert.equal(C.unitKey({ routeId: "16111", direction: 0 }), "tpe:16111|0", "內建路線沒有標來源：台北市");
  assert.deepEqual(["307西藏三民", "307莒光", "265區", "57", "藍32", "920A", "紅57區間", "小巴12繞駛", "920A直達", "三峽-捷運台大醫院站", "965(台灣好行)"].map(C.splitRouteName),
    [["307", "西藏三民"], ["307", "莒光"], ["265區", ""], ["57", ""], ["藍32", ""], ["920A", ""], ["紅57", "區間"], ["小巴12", "繞駛"], ["920A", "直達"], ["三峽-捷運台大醫院站", ""], ["965", "(台灣好行)"]]);
  assert.deepEqual(["307", "57", "265區", "1000", "藍32", "57區"].sort(C.routeCompare), ["57", "57區", "265區", "307", "1000", "藍32"]);
});

test("附近的站：同名站牌歸成一個站名，照最近那根的距離排", () => {
  const me = { lat: 25.05, lon: 121.5 };
  const at = (north, east) => [me.lat + north / 110540, me.lon + east / (111320 * Math.cos(me.lat * Math.PI / 180))];
  const plats = [[1, "甲", ...at(120, 0), []], [2, "乙", ...at(90, 0), []], [3, "甲", ...at(40, 0), []], [4, "丙", ...at(0, 300), []], [5, "太遠", ...at(0, 900), []]];
  const r = C.nearestStops(plats, me, 500, 10);
  assert.deepEqual(r.map((x) => [x.name, Math.round(x.d), x.plats.map((p) => p[0])]), [["甲", 40, [3, 1]], ["乙", 90, [2]], ["丙", 300, [4]]]);
  assert.deepEqual(C.nearestStops(plats, me, 500, 2).map((x) => [x.name, x.plats.map((p) => p[0])]), [["甲", [3, 1]], ["乙", [2]]], "筆數上限是算站名，不是算站牌");
  assert.deepEqual(C.nearestStops(plats, me, 500, 1).map((x) => [x.name, x.plats.length]), [["甲", 2]]);
  assert.deepEqual(C.nearestStops(plats, me, 100, 10).map((x) => [x.name, x.plats.length]), [["甲", 1], ["乙", 1]], "範圍外的同名站牌不算進來");
});

test("打開新的站：帶入別的站已經關注、這裡也有停的路線；從路線頁選來的排最前面", () => {
  const watch = { 家: ["307|0", "265|0", "307|1"], 公司: ["57|1", "265|0", "999|0"] };
  // 這個站有停 265|0、307|1、57|1、123|0；沒人關注的 123|0 不帶，別處關注但這裡不停的 307|0、999|0 也不帶
  assert.deepEqual(C.carryOver(watch, ["123|0", "57|1", "307|1", "265|0"], null), ["265|0", "307|1", "57|1"], "順序照在別的站出現的先後，重複的只算一次");
  assert.deepEqual(C.carryOver(watch, ["123|0", "57|1", "307|1", "265|0"], "57|1"), ["57|1", "265|0", "307|1"], "從路線頁選來的排最前面，不重複");
  assert.deepEqual(C.carryOver(watch, ["265|0"], "888|0"), ["888|0", "265|0"], "選來的那一條一定放進來，即使還沒有人關注過");
  assert.deepEqual(C.carryOver(watch, [], null), []);
  assert.deepEqual(C.carryOver({}, ["265|0"], null), []);
});

// ---------------------------------------------------------------- 搭到某一站要多久
test("車程：下一班的那台車兩站都推得到時，兩站的推估時刻相減", () => {
  // 車在 1 km，預設 18 km/h（每公里 3 分 20 秒）：到第 3 站 09:06:40、到第 6 站 09:16:40
  const tr = trackerWith([["09:00", [fix("A", 1, "09:00")]]]);
  const R = C.routeArrivals(tr, "900|0", null, T("09:00"));
  const e = C.rideEstimate(tr, "900|0", R, 3, 6, T("09:00"));
  assert.equal(e.bus, "A");
  assert.ok(Math.abs(e.min - 10) < 0.01, `車程 ${e.min}`);
  assert.equal(e.boardMs, R.perStop[3][0].ms);
  assert.equal(e.arriveMs, R.perStop[6].find((a) => a.bus === "A").ms);
  assert.equal(e.coverage, 0, "還沒有前車跑過這一段");
  // 官方預估算在裡面：官方說 3 分鐘後到第 3 站（比推算的早），第 6 站從那裡接著推
  const R2 = C.routeArrivals(tr, "900|0", etaOf("09:00", [[3, 180]]), T("09:00"));
  const e2 = C.rideEstimate(tr, "900|0", R2, 3, 6, T("09:00"));
  assert.equal(C.fmtTime(e2.boardMs), "09:03");
  assert.ok(Math.abs(e2.min - 10) < 0.01);
  assert.equal(C.fmtTime(e2.arriveMs), "09:13");
});

test("車程：搭的是「下一班到上車站」的那台，不是離下車站最近的那台", () => {
  // 甲在 5 km（已過第 3 站）、乙在 1 km：從第 3 站上車搭的是乙
  const tr = trackerWith([["09:00", [fix("甲", 5, "09:00"), fix("乙", 1, "09:00")]]]);
  const R = C.routeArrivals(tr, "900|0", null, T("09:00"));
  assert.equal(R.perStop[6][0].bus, "甲", "第 6 站的下一班是甲");
  const e = C.rideEstimate(tr, "900|0", R, 3, 6, T("09:00"));
  assert.equal(e.bus, "乙");
  assert.equal(e.arriveMs, R.perStop[6].find((a) => a.bus === "乙").ms);
  assert.ok(e.arriveMs > R.perStop[6][0].ms);
});

test("車程：沒有車可以對（未發車、沒定位、超出推估範圍）時用前車段速，沒量到的分段用預設車速", () => {
  // 沒有任何車：3 km 用預設車速＝10 分；不知道幾點上車，所以也沒有幾點到
  const empty = C.createTracker([VARIANT]);
  const e = C.rideEstimate(empty, "900|0", C.routeArrivals(empty, "900|0", null, T("09:00")), 3, 6, T("09:00"));
  assert.deepEqual([e.bus, Math.round(e.min * 100) / 100, e.boardMs, e.arriveMs, e.coverage], [null, 10, null, null, 0]);
  // 前車用每公里 6 分鐘跑過 3–6 km（比預設慢）：現在沒有車，車程往前車的速度靠（濾波後的段速）
  const steps = [];
  for (let i = 0; i <= 30; i++) steps.push([`09:${String(i).padStart(2, "0")}`, [fix("前車", 2.5 + i / 6, `09:${String(i).padStart(2, "0")}`)]]);
  const tr = trackerWith(steps);
  const now = T("09:40");                                      // 前車的定位已經過期（超過 3 分鐘沒更新），不算在跑
  const R = C.routeArrivals(tr, "900|0", null, now);
  assert.equal(R.active.length, 0);
  const slow = C.rideEstimate(tr, "900|0", R, 3, 6, now);
  assert.equal(slow.bus, null);
  // 預設車速是 10 分、照抄那一台是 18 分；只看過一台、又過了二三十分鐘 → 約 12.8 分
  assert.ok(slow.min > 12.3 && slow.min < 13.3, `車程 ${slow.min}`);
  assert.ok(slow.coverage > 0.95);
  // 逐班表路線、車還沒發：上車時刻用班表推的那一班，幾點到＝上車時刻＋車程
  const tt = C.createTracker([TT]);
  const Rt = C.routeArrivals(tt, "901|0", null, T("09:10"));
  assert.equal(Rt.perStop[3][0].source, "班表");
  const et = C.rideEstimate(tt, "901|0", Rt, 3, 6, T("09:10"));
  assert.deepEqual([et.bus, C.fmtTime(et.boardMs), C.fmtTime(et.arriveMs), Math.round(et.min)], [null, "09:40", "09:50", 10]);
  // 只有班距的路線：「≤ N 分」是上限不是時刻，不拿來當上車時刻
  const fq = runningAt(FQ, "09:10");
  const Rf = C.routeArrivals(fq, "902|0", null, T("09:10"));
  assert.equal(Rf.perStop[3][0].upper, true);
  const ef = C.rideEstimate(fq, "902|0", Rf, 3, 6, T("09:10"));
  assert.deepEqual([ef.boardMs, ef.arriveMs, Math.round(ef.min)], [null, null, 10]);
  // 那台車到得了上車站、但下車站超出推估範圍：改用段速，幾點到＝上車時刻＋車程
  const keep = C.P.horizonMin;
  C.P.horizonMin = 15;
  try {
    const far = trackerWith([["09:00", [fix("A", 1, "09:00")]]]);
    const Rh = C.routeArrivals(far, "900|0", null, T("09:00"));
    assert.equal(Rh.perStop[9].length, 0, "第 9 站（26 分 40 秒後）超出 15 分鐘的範圍");
    const eh = C.rideEstimate(far, "900|0", Rh, 3, 9, T("09:00"));
    assert.deepEqual([eh.bus, Math.round(eh.min), eh.boardMs, C.fmtTime(eh.arriveMs)], [null, 20, Rh.perStop[3][0].ms, "09:26"]);
  } finally { C.P.horizonMin = keep; }
});

test("車程：下車站不在上車站之後、站序超出範圍、沒有這條路線，都回傳 null", () => {
  const tr = trackerWith([["09:00", [fix("A", 1, "09:00")]]]);
  const R = C.routeArrivals(tr, "900|0", null, T("09:00"));
  assert.equal(C.rideEstimate(tr, "900|0", R, 6, 3, T("09:00")), null);
  assert.equal(C.rideEstimate(tr, "900|0", R, 3, 3, T("09:00")), null);
  assert.equal(C.rideEstimate(tr, "900|0", R, 3, 99, T("09:00")), null);
  assert.equal(C.rideEstimate(tr, "999|0", R, 3, 6, T("09:00")), null);
  // 還沒算過這個變體（result 是空的）：照樣給得出用段速估的車程
  assert.equal(Math.round(C.rideEstimate(tr, "900|0", null, 3, 6, T("09:00")).min), 10);
});

// ---------------------------------------------------------------- 起站末班發車時刻
test("起站末班：用營運日的星期挑；幾個變體取最晚的（過午夜的算更晚）；有一個沒資料就不給", () => {
  const v = (ld) => ({ lastDeparture: ld });
  const week = { sat: "22:10", sun: "21:00" };
  assert.equal(C.lastDepartureToday([v(week)], T("09:00")), "22:10", "10/3 是週六");
  assert.equal(C.lastDepartureToday([v(week)], T("00:30", "2026-10-04")), "22:10", "週日凌晨 00:30 還算週六的營運日");
  assert.equal(C.lastDepartureToday([v(week)], T("03:00", "2026-10-04")), "21:00", "03:00 起算週日");
  // 幾個變體：取最晚的；凌晨的時刻是深夜那一班，比 23 點多的晚；00:00 是午夜的末班
  assert.equal(C.lastDepartureToday([v({ sat: "22:10" }), v({ sat: "23:00" }), v({ sat: "21:30" })], T("09:00")), "23:00");
  assert.equal(C.lastDepartureToday([v({ sat: "23:50" }), v({ sat: "00:20" })], T("09:00")), "00:20");
  assert.equal(C.lastDepartureToday([v({ sat: "00:20" }), v({ sat: "23:50" })], T("09:00")), "00:20", "和順序無關");
  assert.equal(C.lastDepartureToday([v({ sat: "23:30" }), v({ sat: "00:00" })], T("09:00")), "00:00");
  assert.equal(C.lastDepartureToday([v({ sat: "02:59" }), v({ sat: "03:00" })], T("09:00")), "02:59", "03:00 起是清晨的班次，不是深夜");
  // 資料不完整：不給
  assert.equal(C.lastDepartureToday([v({ sat: "22:10" }), v({ sun: "23:00" })], T("09:00")), null, "其中一個變體沒有今天的");
  assert.equal(C.lastDepartureToday([v({ sat: "23:00" }), v({})], T("09:00")), null);
  assert.equal(C.lastDepartureToday([v({}), v({ sat: "23:00" })], T("09:00")), null, "沒資料的排前面也一樣");
  assert.equal(C.lastDepartureToday([{}], T("09:00")), null);
  assert.equal(C.lastDepartureToday([v({ sat: "2210" })], T("09:00")), null, "格式不對");
  assert.equal(C.lastDepartureToday([v({ sat: "" })], T("09:00")), null);
  assert.equal(C.lastDepartureToday([], T("09:00")), null, "這一列還沒載入任何變體");
  assert.equal(C.lastDepartureToday(null, T("09:00")), null);
});

// ---------------------------------------------------------------- 路線的顏色
test("替新路線挑顏色：同一個站不重複，其次挑用得最少的，再照順序；用完了才重複", () => {
  const P4 = ["甲", "乙", "丙", "丁"];
  assert.equal(C.pickColor(P4, [], []), "甲", "都沒用過：照順序");
  assert.equal(C.pickColor(P4, ["甲"], ["甲"]), "乙");
  assert.equal(C.pickColor(P4, ["甲", "丙"], ["甲", "丙"]), "乙");
  // 同一個站沒用過的裡面，挑全部路線裡用得最少的：乙在別的站用過兩次、丙一次、丁沒用過
  assert.equal(C.pickColor(P4, ["甲"], ["甲", "乙", "乙", "丙"]), "丁");
  assert.equal(C.pickColor(P4, ["甲"], ["甲", "乙", "乙", "丙", "丁"]), "丙", "丙、丁各一次：照順序挑丙");
  // 別的站用得再多，只要這個站沒用過就可以用；這個站用過的，就算全部路線裡最少用也不挑
  assert.equal(C.pickColor(P4, ["乙", "丙", "丁"], ["甲", "甲", "甲", "乙", "丙", "丁"]), "甲");
  // 這個站把四個顏色都用過了：挑這個站裡用得最少的（甲、丁各一次 → 再看全部路線：丁比較少）
  assert.equal(C.pickColor(P4, ["甲", "乙", "乙", "丙", "丙", "丁"], ["甲", "甲", "乙", "乙", "丙", "丙", "丁"]), "丁");
  assert.equal(C.pickColor(P4, ["甲", "乙", "丙", "丁"], ["甲", "乙", "丙", "丁"]), "甲", "都一樣多：照順序");
  assert.equal(C.pickColor(P4, ["甲", "甲", "乙", "丙", "丁"], ["甲", "甲", "乙", "丙", "丁"]), "乙");
  // 用完之後先看這個站：甲在這個站用了兩次，就算它在全部路線裡用得最少也不挑
  assert.equal(C.pickColor(P4, ["甲", "甲", "乙", "丙", "丁"], ["甲", "甲", "乙", "乙", "乙", "丙", "丙", "丙", "丁", "丁", "丁"]), "乙");
  // 這個站用過的顏色不在候選裡（內建路線的顏色）：不影響
  assert.equal(C.pickColor(P4, ["黃", "珊瑚"], ["黃", "珊瑚"]), "甲");
  // 十條路線在同一個站：十個顏色各用一次，第十一條才重複
  const P10 = Array.from({ length: 10 }, (_, i) => "色" + i), used = [];
  for (let i = 0; i < 10; i++) used.push(C.pickColor(P10, used, used));
  assert.equal(new Set(used).size, 10);
  assert.equal(C.pickColor(P10, used, used), "色0");
});

// 路線的顏色要記住：以下的路線鍵「n:1」「n:2」…各是一條路線，「|0」「|1」是方向
const P4 = ["甲", "乙", "丙", "丁"];
const R = (n, name = String(n), dirs = [0]) => dirs.map((g) => ({ unit: `n:${n}|${g}`, display: name }));
// 別的站已經載入的六條路線，乙、丙、丁各用兩次：所以「全部路線裡用得最少的」是甲。用來確認避開甲靠的是同一個站的規則，不是剛好用得少
const ELSEWHERE = { "x:1|0": { x1: "乙" }, "x:2|0": { x2: "丙" }, "x:3|0": { x3: "丁" }, "x:4|0": { x4: "乙" }, "x:5|0": { x5: "丙" }, "x:6|0": { x6: "丁" } };

test("路線的顏色：上次用過的沿用；沒記過、或記的顏色已經不能用，才挑新的", () => {
  const W = { 站: ["n:1|0", "n:2|0"] };
  // 沒記過：和 pickColor 一樣，同一個站已經上色的要避開
  assert.deepEqual(C.routeColors(P4, R(1), W, {}, {}), { 1: "甲" });
  assert.deepEqual(C.routeColors(P4, R(2), W, { "n:1|0": { 1: "甲" }, ...ELSEWHERE }, {}), { 2: "乙" });
  // 記過：沿用，就算不是 pickColor 會挑的那一個
  assert.deepEqual(C.routeColors(P4, R(1), W, {}, { "n:1|0": { 1: "丙" } }), { 1: "丙" });
  assert.deepEqual(C.routeColors(P4, R(2), W, { "n:1|0": { 1: "甲" } }, { "n:2|0": { 2: "丁" } }), { 2: "丁" });
  // 記的顏色已經不在候選裡（之後換過色票）：重挑
  assert.deepEqual(C.routeColors(P4, R(1), W, {}, { "n:1|0": { 1: "紅" } }), { 1: "甲" });
  // 記的顏色被同一個站已經上色的路線用了：重挑，而且避開它（就算它關注得比較晚：這次打開它的顏色已經定了）
  assert.deepEqual(C.routeColors(P4, R(1), W, { "n:2|0": { 2: "甲" }, ...ELSEWHERE }, { "n:1|0": { 1: "甲" } }), { 1: "乙" });
  // 用同一個顏色的路線在別的站：不相干，沿用
  assert.deepEqual(C.routeColors(P4, R(1), { 站: ["n:1|0"], 別站: ["n:2|0"] }, { "n:2|0": { 2: "甲" } }, { "n:1|0": { 1: "甲" } }), { 1: "甲" });
  // 已經載入的路線看它現在的顏色，不看它以前記的（它這次重挑過）
  assert.deepEqual(C.routeColors(P4, R(1), W, { "n:2|0": { 2: "乙" } }, { "n:1|0": { 1: "甲" }, "n:2|0": { 2: "甲" } }), { 1: "甲" });
  assert.deepEqual(C.routeColors(P4, R(1), W, { "n:2|0": { 2: "甲" }, ...ELSEWHERE }, { "n:2|0": { 2: "乙" } }), { 1: "乙" }, "避開的是現在的甲");
  // 沒有人關注的路線（除錯時直接載入）：沒有同一個站可言，記過就沿用
  assert.deepEqual(C.routeColors(P4, R(9), W, { "n:1|0": { 1: "甲" } }, { "n:9|0": { 9: "甲" } }), { 9: "甲" });
  assert.deepEqual(C.routeColors(P4, R(9), W, { "n:1|0": { 1: "甲" } }, {}), { 9: "乙" }, "沒記過：挑全部路線裡用得最少的");
  // 資料更新後顯示名稱改了：舊名字記的顏色不算數，也不佔位子
  assert.deepEqual(C.routeColors(P4, R(1, "新名"), W, {}, { "n:1|0": { 舊名: "甲" } }), { 新名: "甲" });
  assert.deepEqual(C.routeColors(P4, R(1), { 站: ["n:1|0", "n:1|1"] }, {}, { "n:1|1": { "1返": "甲" } }), { 1: "甲" }, "已經沒有的方向也一樣");
  assert.deepEqual(C.routeColors(P4, R(9), {}, {}, {}), { 9: "甲" }, "關注清單還沒讀進來");
});

test("路線的顏色：還沒載入的路線，記住的顏色先佔著；兩條記同一個顏色時關注得早的留著", () => {
  const W = { 站: ["n:1|0", "n:2|0", "n:3|0"] };
  const both = { "n:1|0": { 1: "甲" }, "n:2|0": { 2: "甲" } };
  // 1 和 2 都記著甲，都還沒載入：不管誰先載入，1（關注得早）留著，2 換
  assert.deepEqual(C.routeColors(P4, R(1), W, {}, both), { 1: "甲" });
  assert.deepEqual(C.routeColors(P4, R(2), W, {}, both), { 2: "乙" }, "2 先載入：1 還沒來，甲也要讓給它");
  assert.deepEqual(C.routeColors(P4, R(2), W, { "n:1|0": { 1: "甲" } }, both), { 2: "乙" }, "1 先載入");
  // 先後看的是整份關注清單裡第一次出現的位置（一條路線一個位置），不是在這個站的清單裡誰排前面
  const W2 = { 前: ["n:2|0"], 後: ["n:1|0", "n:2|0"] };
  assert.deepEqual(C.routeColors(P4, R(2), W2, {}, both), { 2: "甲" });
  assert.deepEqual(C.routeColors(P4, R(1), W2, {}, both), { 1: "乙" });
  // 另一個方向也算同一條路線的位置
  const W3 = { 前: ["n:2|1"], 後: ["n:1|0", "n:2|0"] };
  assert.deepEqual(C.routeColors(P4, R(1), W3, {}, both), { 1: "乙" });
  // 沒記過顏色的新路線：同一個站還沒載入的路線記的顏色都避開，不管它排前面還是後面
  assert.deepEqual(C.routeColors(P4, R(2), W, ELSEWHERE, { "n:1|0": { 1: "甲" } }), { 2: "乙" }, "排前面的 1 記著甲");
  assert.deepEqual(C.routeColors(P4, R(2), W, ELSEWHERE, { "n:3|0": { 3: "甲" } }), { 2: "乙" }, "排後面的 3 記著甲");
  assert.deepEqual(C.routeColors(P4, R(2), W, {}, { "n:1|0": { 1: "乙" }, "n:3|0": { 3: "甲" } }), { 2: "丙" });
  // 還沒載入的路線在別的站：不用避開，但「全部路線裡用得最少的」要把它記的算進去（不然挑到哪一個又會看載入先後）
  const far = { 站: ["n:2|0"], 別站: ["n:1|0"] };
  assert.deepEqual(C.routeColors(P4, R(2), far, {}, { "n:1|0": { 1: "甲" } }), { 2: "乙" });
  assert.deepEqual(C.routeColors(P4, R(2), far, {}, { "n:1|0": { 1: "甲" }, "n:2|0": { 2: "甲" } }), { 2: "甲" }, "記著同一個顏色也沒關係");
  // 已經取消關注的路線記的顏色：不佔位子、也不算用過
  assert.deepEqual(C.routeColors(P4, R(2), W, {}, { "n:8|0": { 8: "甲" } }), { 2: "甲" });
  assert.deepEqual(C.routeColors(P4, R(2), W, {}, { "n:8|0": { 8: "甲" }, "n:2|0": { 2: "甲" } }), { 2: "甲" });
  // 別的路線剛好同名（顏色是照顯示名稱給的，當成同一個）：不算被別人用了
  assert.deepEqual(C.routeColors(P4, R(2, "同名"), W, {}, { "n:1|0": { 同名: "甲" }, "n:2|0": { 同名: "甲" } }), { 同名: "甲" });
  assert.deepEqual(C.routeColors(P4, R(2, "同名"), W, { "n:1|0": { 同名: "甲" } }, { "n:2|0": { 同名: "甲" } }), { 同名: "甲" });
  assert.deepEqual(C.routeColors(P4, R(2, "同名"), W, ELSEWHERE, { "n:3|0": { 同名: "甲" } }), { 同名: "甲" }, "排後面的同名路線記著甲：不用避開");
});

test("路線的顏色：一個顯示名稱兩個方向都有時，兩個方向所在的站都算；一條路線有幾個顯示名稱時各一個顏色", () => {
  // 897 的檔案先列往板橋（|0），但在板橋公車站搭的是往景文科大（|1）：只看第一個變體的方向會以為這個站沒有別的路線
  const r897 = R(897, "897", [0, 1]), W = { 板橋公車站: ["n:577|0", "n:897|1"] };
  assert.deepEqual(C.routeColors(P4, r897, W, { "n:577|0": { 577: "甲" }, ...ELSEWHERE }, {}), { 897: "乙" });
  assert.deepEqual(C.routeColors(P4, r897, W, { "n:577|0": { 577: "甲" } }, { "n:897|0": { 897: "甲" }, "n:897|1": { 897: "甲" } }), { 897: "乙" });
  // 兩個方向在不同的站：兩個站的路線都要避開
  const W2 = { 去程站: ["n:897|0", "n:1|0"], 返程站: ["n:897|1", "n:2|0"] };
  assert.deepEqual(C.routeColors(P4, r897, W2, { "n:1|0": { 1: "甲" }, "n:2|0": { 2: "乙" } }, {}), { 897: "丙" });
  // 記的顏色只記在其中一個方向（資料更新後另一個方向才多了這個顯示名稱）：一樣沿用
  assert.deepEqual(C.routeColors(P4, r897, W, {}, { "n:897|1": { 897: "丁" } }), { 897: "丁" });
  // 一條路線兩個顯示名稱、同一個方向：各一個顏色，排前面的先挑
  const two = [...R(5, "5"), ...R(5, "5區")], W5 = { 站: ["n:5|0"] };
  assert.deepEqual(C.routeColors(P4, two, W5, ELSEWHERE, {}), { 5: "甲", "5區": "乙" });
  assert.deepEqual(C.routeColors(P4, two, W5, {}, { "n:5|0": { 5: "丙", "5區": "乙" } }), { 5: "丙", "5區": "乙" });
  // 兩個記了同一個顏色：排前面的留著、後面的換；前面的沒記過要挑新的時，後面記著的顏色留給它
  assert.deepEqual(C.routeColors(P4, two, W5, ELSEWHERE, { "n:5|0": { 5: "甲", "5區": "甲" } }), { 5: "甲", "5區": "乙" });
  assert.deepEqual(C.routeColors(P4, two, W5, ELSEWHERE, { "n:5|0": { "5區": "甲" } }), { 5: "乙", "5區": "甲" });
  // 同一條路線的另一個顯示名稱也算「用過」：沒有同站限制時挑全部路線裡用得最少的
  const split = [...R(5, "5"), ...R(5, "5返", [1])];
  assert.deepEqual(C.routeColors(P4, split, W5, {}, {}), { 5: "甲", "5返": "乙" });
  assert.deepEqual(C.routeColors(P4, split, W5, {}, { "n:5|1": { "5返": "甲" } }), { 5: "乙", "5返": "甲" }, "還沒輪到的照它記的算");
});

test("路線的顏色：同一個站把顏色用完了，記著的重複顏色照樣沿用（不然第 11 個以後每次打開都重挑）", () => {
  const W = { 站: ["n:1|0", "n:2|0", "n:3|0", "n:4|0", "n:5|0"] };
  const four = { "n:1|0": { 1: "甲" }, "n:2|0": { 2: "乙" }, "n:3|0": { 3: "丙" }, "n:4|0": { 4: "丁" } };
  assert.deepEqual(C.routeColors(P4, R(5), W, four, { "n:5|0": { 5: "丙" } }), { 5: "丙" }, "四個顏色都有人用：沿用記著的丙");
  assert.deepEqual(C.routeColors(P4, R(5), W, {}, { ...four, "n:5|0": { 5: "丙" } }), { 5: "丙" }, "別的路線還沒載入也一樣");
  assert.deepEqual(C.routeColors(P4, R(5), W, four, {}), { 5: "甲" }, "沒記過：挑這個站用得最少的");
  // 用完了沒有，排在後面、還沒載入的路線記的顏色也要算：5 排第二，前面的 1 和它一樣記著丁，後面三條記著甲、乙、丙
  assert.deepEqual(C.routeColors(P4, R(5), { 站: ["n:1|0", "n:5|0", "n:2|0", "n:3|0", "n:4|0"] }, {},
    { "n:1|0": { 1: "丁" }, "n:5|0": { 5: "丁" }, "n:2|0": { 2: "甲" }, "n:3|0": { 3: "乙" }, "n:4|0": { 4: "丙" } }), { 5: "丁" });
  // 還有顏色沒人用（取消關注了一條）：重複的那一條換成沒人用的
  const three = { "n:1|0": { 1: "甲" }, "n:2|0": { 2: "乙" }, "n:3|0": { 3: "丙" } };
  assert.deepEqual(C.routeColors(P4, R(5), { 站: ["n:1|0", "n:2|0", "n:3|0", "n:5|0"] }, three, { "n:5|0": { 5: "丙" } }), { 5: "丁" });
});

test("記住路線的顏色：這條路線原本記的整個換掉，別的路線不動；不改原本那一份、內容沒變時順序也不變", () => {
  const r = R(897, "897", [0, 1]);
  assert.deepEqual(C.rememberColors({}, r, { 897: "甲" }), { "n:897|0": { 897: "甲" }, "n:897|1": { 897: "甲" } }, "兩個方向都記");
  const memo = { "n:1|0": { 1: "乙" }, "n:897|1": { 897: "丙", 舊名: "丁" }, "n:897|2": { 897: "丙" }, "n:8970|0": { 8970: "丁" } };
  const before = JSON.stringify(memo);
  assert.deepEqual(C.rememberColors(memo, r, { 897: "甲", 別的: "乙" }),
    { "n:1|0": { 1: "乙" }, "n:897|1": { 897: "甲" }, "n:8970|0": { 8970: "丁" }, "n:897|0": { 897: "甲" } }, "改名的顯示名稱、已經沒有的方向都不留；號碼只是開頭一樣的路線不動");
  assert.equal(JSON.stringify(memo), before, "不改原本那一份");
  assert.deepEqual(C.rememberColors(memo, r, {}), { "n:1|0": { 1: "乙" }, "n:8970|0": { 8970: "丁" } }, "這次沒有顏色的不記");
  // 一條路線兩個顯示名稱
  assert.deepEqual(C.rememberColors({}, [...R(5, "5"), ...R(5, "5區"), ...R(5, "5返", [1])], { 5: "甲", "5區": "乙", "5返": "甲" }),
    { "n:5|0": { 5: "甲", "5區": "乙" }, "n:5|1": { "5返": "甲" } });
  // 內容沒變：轉成文字和原本一模一樣（頁面靠這個判斷要不要存）
  const same = { "n:9|0": { 9: "丁" }, "n:897|1": { 897: "甲" }, "n:897|0": { 897: "甲" }, "n:1|0": { 1: "乙" } };
  assert.equal(JSON.stringify(C.rememberColors(same, r, { 897: "甲" })), JSON.stringify(same));
  assert.notEqual(JSON.stringify(C.rememberColors(same, r, { 897: "乙" })), JSON.stringify(same));
});

/** 模擬打開一次頁面：路線照 order 的先後一條一條載入（app.js 的 paint 做的事），回傳每個顯示名稱的顏色與記住的顏色。 */
function openPage(palette, files, watch, memo, order, fixed = {}) {
  const used = { ...fixed };
  for (const k of order) {
    const got = C.routeColors(palette, files[k], watch, used, memo);
    for (const x of files[k]) (used[x.unit] = used[x.unit] || {})[x.display] = got[x.display];
    memo = C.rememberColors(memo, files[k], got);
  }
  return { colors: Object.assign({}, ...Object.values(used)), memo };
}
const perms = (a) => (a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p])));
/** 每一種載入順序都打開一次，結果要一模一樣；回傳那個結果。 */
function everyOrder(palette, files, watch, memo, keys, fixed) {
  const want = openPage(palette, files, watch, memo, keys, fixed);
  for (const order of perms(keys)) assert.deepEqual(openPage(palette, files, watch, memo, order, fixed), want, "載入順序 " + order.join("→"));
  return want;
}
const P10 = Array.from({ length: 10 }, (_, i) => "色" + i);

test("路線的顏色不看載入的先後：重新整理、隔天再開都一樣（使用者 2026-10-05：897 和 577 重新整理後顏色對調）", () => {
  // 板橋公車站：內建的 307 之外關注 897（搭的是 |1）與 577
  const files = { 897: R(897, "897", [0, 1]), 577: R(577, "577", [0, 1]) };
  const W = { 板橋公車站: ["tpe:16111|0", "n:897|1", "n:577|0"], 國泰街口: ["tpe:16111|0"] };
  const builtin = { "tpe:16111|0": { 307: "#FFD253" }, "tpe:16111|1": { 307: "#FFD253" } };
  // 第一次（還沒記過）：誰先載入誰先挑；之後不管怎麼載入都是第一次的顏色，記的內容也不再變
  for (const first of perms(["897", "577"])) {
    const a = openPage(P10, files, W, {}, first, builtin);
    assert.equal(new Set([a.colors[897], a.colors[577]]).size, 2);
    assert.deepEqual(everyOrder(P10, files, W, a.memo, ["897", "577"], builtin), a);
  }
  // 五條路線、兩個站，其中一條兩個站都有關注：每一種第一次的順序，之後 120 種載入順序都不變
  const five = { 1: R(1), 2: R(2), 3: R(3, "3", [0, 1]), 4: [...R(4, "4"), ...R(4, "4區")], 5: R(5) };
  const W5 = { 甲站: ["n:1|0", "n:2|0", "n:3|0"], 乙站: ["n:3|1", "n:4|0", "n:5|0", "n:1|0"] };
  for (const first of [["1", "2", "3", "4", "5"], ["5", "4", "3", "2", "1"], ["3", "5", "1", "4", "2"]]) {
    const a = openPage(P4.concat("戊", "己"), five, W5, {}, first);
    assert.equal(new Set(["1", "2", "3"].map((n) => a.colors[n])).size, 3, "甲站不重複");
    assert.equal(new Set(["3", "4", "4區", "5", "1"].map((n) => a.colors[n])).size, 5, "乙站不重複");
    assert.deepEqual(everyOrder(P4.concat("戊", "己"), five, W5, a.memo, Object.keys(five)), a);
  }
});

test("路線的顏色：記過的不會被還沒記過的搶走；取消關注再加回來是原本的顏色", () => {
  const files = { 1: R(1), 2: R(2), 3: R(3), 4: R(4) };
  // 1、2 記過（故意不是照順序挑會得到的顏色），3 是新關注的：不管誰先載入，1、2 不變，3 拿剩下的
  const memo = { "n:1|0": { 1: "乙" }, "n:2|0": { 2: "甲" } };
  const a = everyOrder(P4, files, { 站: ["n:1|0", "n:2|0", "n:3|0"] }, memo, ["1", "2", "3"]);
  assert.deepEqual(a.colors, { 1: "乙", 2: "甲", 3: "丙" });
  // 取消關注 2：1、3 不變，2 記的還留著
  const b = everyOrder(P4, files, { 站: ["n:1|0", "n:3|0"] }, a.memo, ["1", "3"]);
  assert.deepEqual(b.colors, { 1: "乙", 3: "丙" });
  assert.deepEqual(b.memo["n:2|0"], { 2: "甲" });
  // 加回來（排到最後）：還是甲
  assert.deepEqual(everyOrder(P4, files, { 站: ["n:1|0", "n:3|0", "n:2|0"] }, b.memo, ["1", "2", "3"]).colors, { 1: "乙", 2: "甲", 3: "丙" });
  // 取消的那段時間關注了 4，4 用了甲（沒人佔著）：2 加回來時甲已經有人用，換一個；1、3、4 不變
  const c = everyOrder(P4, files, { 站: ["n:1|0", "n:3|0", "n:4|0"] }, b.memo, ["1", "3", "4"]);
  assert.deepEqual(c.colors, { 1: "乙", 3: "丙", 4: "甲" });
  const d = everyOrder(P4, files, { 站: ["n:1|0", "n:3|0", "n:4|0", "n:2|0"] }, c.memo, ["1", "2", "3", "4"]);
  assert.deepEqual(d.colors, { 1: "乙", 3: "丙", 4: "甲", 2: "丁" });
  assert.deepEqual(everyOrder(P4, files, { 站: ["n:1|0", "n:3|0", "n:4|0", "n:2|0"] }, d.memo, ["1", "2", "3", "4"]), d, "換過之後就固定");
});

test("路線的顏色：同一條路線兩個站都關注是同一個顏色；加到第二個站才撞色時，關注得早的留著、晚的換一次", () => {
  const files = { 1: R(1), 2: R(2), 3: R(3), 4: R(4), 5: R(5) };
  // 甲站 1、2，丙站 3、4，乙站只有 5：四個顏色各用一次，5 沒有同站的限制，挑到和 1 一樣的甲
  const W = { 甲站: ["n:1|0", "n:2|0"], 丙站: ["n:3|0", "n:4|0"], 乙站: ["n:5|0"] };
  const a = openPage(P4, files, W, {}, ["1", "2", "3", "4", "5"]);
  assert.deepEqual(a.colors, { 1: "甲", 2: "乙", 3: "丙", 4: "丁", 5: "甲" });
  // 把 1 也加到乙站：1 和 5 在同一個站撞色。下次打開，1（關注得早）留著甲，5 換；其他不動，而且和載入順序無關
  const W2 = { ...W, 乙站: ["n:5|0", "n:1|0"] };
  const b = everyOrder(P4, files, W2, a.memo, Object.keys(files));
  assert.deepEqual(b.colors, { 1: "甲", 2: "乙", 3: "丙", 4: "丁", 5: "乙" });
  assert.deepEqual(everyOrder(P4, files, W2, b.memo, Object.keys(files)), b, "換過一次之後就固定");
  // 乙站排在關注清單最前面時，5 算關注得早：5 留著，1 換（甲站的 2 用了乙，所以挑丙）
  const W3 = { 乙站: ["n:5|0", "n:1|0"], 甲站: ["n:1|0", "n:2|0"], 丙站: ["n:3|0", "n:4|0"] };
  assert.deepEqual(everyOrder(P4, files, W3, a.memo, Object.keys(files)).colors, { 1: "丙", 2: "乙", 3: "丙", 4: "丁", 5: "甲" });
});

test("路線的顏色：同一個站十條各一個顏色，第十一條才重複；重新整理後每一條都不變", () => {
  const files = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [String(i + 1), R(i + 1)]));
  const keys = Object.keys(files), ten = keys.slice(0, 10), W = (ks) => ({ 站: ["tpe:16111|0", ...ks.map((k) => `n:${k}|0`)] });
  const builtin = { "tpe:16111|0": { 307: "#FFD253", "307西藏三民": "#FF8461" }, "tpe:10482|0": { "265區": "#47B4EB" } };
  // 換幾種載入順序（10! 種跑不完）：倒過來、每次從不同的地方開始輪、固定的亂數
  const orders = (ks) => { let s = 7; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
    return [[...ks].reverse(), ...ks.map((_, i) => [...ks.slice(i), ...ks.slice(0, i)]), ...Array.from({ length: 30 }, () => [...ks].sort(() => rnd() - 0.5))]; };
  const a = openPage(P10, files, W(ten), {}, [...ten].reverse(), builtin);
  assert.equal(new Set(ten.map((k) => a.colors[k])).size, 10, "十條不重複");
  for (const o of orders(ten)) assert.deepEqual(openPage(P10, files, W(ten), a.memo, o, builtin), a, o.join("→"));
  // 第十一條：一定和某一條重複；之後怎麼載入，十一條都是原本的顏色
  const b = openPage(P10, files, W(keys), a.memo, keys, builtin);
  assert.deepEqual(ten.map((k) => b.colors[k]), ten.map((k) => a.colors[k]));
  assert.ok(P10.includes(b.colors[11]));
  for (const o of orders(keys)) assert.deepEqual(openPage(P10, files, W(keys), b.memo, o, builtin), b, o.join("→"));
});

// ---------------------------------------------------------------- 等車頁的列照到站時間排
test("等車頁的列：越快到的越上面；分鐘數一樣維持原本的上下；沒有車的排最下面；有一列展開著就先不動", () => {
  const K = ["甲", "乙", "丙", "丁"];
  // 第一次：照畫面上的分鐘數
  assert.deepEqual(C.arrivalOrder(K, { 甲: 9, 乙: 2, 丙: 14, 丁: 5 }), ["乙", "丁", "甲", "丙"]);
  assert.deepEqual(C.arrivalOrder(K, { 甲: 9, 乙: 2, 丙: 14, 丁: 5 }, null, false), ["乙", "丁", "甲", "丙"]);
  assert.deepEqual(C.arrivalOrder(K, { 甲: 90, 乙: 100, 丙: 9, 丁: 10 }), ["丙", "丁", "甲", "乙"], "照數字的大小，不是照字");
  // 到站是 0：排最上面，不是「沒有車」
  assert.deepEqual(C.arrivalOrder(K, { 甲: 3, 乙: 0, 丙: 1, 丁: 2 }), ["乙", "丙", "丁", "甲"]);
  // 沒有車（null、沒給）：最下面，照原本的順序，不看上一次怎麼排
  assert.deepEqual(C.arrivalOrder(K, { 甲: null, 乙: 7, 丁: 3 }), ["丁", "乙", "甲", "丙"]);
  assert.deepEqual(C.arrivalOrder(K, {}), K);
  assert.deepEqual(C.arrivalOrder(K, { 乙: 7 }, ["丙", "乙", "丁", "甲"]), ["乙", "甲", "丙", "丁"]);
  // 分鐘數一樣：第一次照原本的順序
  assert.deepEqual(C.arrivalOrder(K, { 甲: 5, 乙: 5, 丙: 2, 丁: 5 }), ["丙", "甲", "乙", "丁"]);
  // 分鐘數一樣：維持上一次畫面上的上下；上一次沒有的（剛關注的）排在後面、照原本的順序
  assert.deepEqual(C.arrivalOrder(K, { 甲: 5, 乙: 5, 丙: 2, 丁: 5 }, ["丁", "乙", "丙", "甲"]), ["丙", "丁", "乙", "甲"]);
  assert.deepEqual(C.arrivalOrder(K, { 甲: 5, 乙: 5, 丙: 5, 丁: 5 }, ["丁", "乙"]), ["丁", "乙", "甲", "丙"]);
  // 分鐘數不一樣：照分鐘數，不管上一次怎麼排
  assert.deepEqual(C.arrivalOrder(K, { 甲: 4, 乙: 5, 丙: 6, 丁: 7 }, ["丁", "丙", "乙", "甲"]), K);
  // 兩台差不多時間到的車：數字一樣時不互換，數字真的反過來才換
  const two = ["甲", "乙"];
  let o = C.arrivalOrder(two, { 甲: 5, 乙: 4 });
  assert.deepEqual(o, ["乙", "甲"]);
  assert.deepEqual((o = C.arrivalOrder(two, { 甲: 4, 乙: 4 }, o)), ["乙", "甲"]);
  assert.deepEqual((o = C.arrivalOrder(two, { 甲: 3, 乙: 4 }, o)), ["甲", "乙"]);
  assert.deepEqual((o = C.arrivalOrder(two, { 甲: 3, 乙: 3 }, o)), ["甲", "乙"]);
  // 有一列展開著（hold）：列沒有增減就照上一次的，就算數字已經反過來、有的沒車了
  assert.deepEqual(C.arrivalOrder(K, { 甲: 1, 乙: 9, 丙: 3, 丁: null }, ["乙", "丙", "丁", "甲"], true), ["乙", "丙", "丁", "甲"]);
  assert.deepEqual(C.arrivalOrder(K, { 甲: 1, 乙: 9, 丙: 3, 丁: null }, ["乙", "丙", "丁", "甲"], false), ["甲", "丙", "乙", "丁"], "沒有展開：照常排");
  // 展開著但列有增減、或還沒有上一次：照常排
  assert.deepEqual(C.arrivalOrder(K, { 甲: 1, 乙: 9, 丙: 3 }, ["乙", "丙", "甲"], true), ["甲", "丙", "乙", "丁"], "多了丁");
  assert.deepEqual(C.arrivalOrder(K, { 甲: 1, 乙: 9, 丙: 3 }, ["乙", "丙", "甲", "戊"], true), ["甲", "丙", "乙", "丁"], "丁換成戊");
  assert.deepEqual(C.arrivalOrder(K, { 甲: 1, 乙: 9, 丙: 3 }, ["乙", "丙", "甲", "丁", "戊"], true), ["甲", "丙", "乙", "丁"], "少了戊");
  assert.deepEqual(C.arrivalOrder(K, { 甲: 1, 乙: 9 }, null, true), ["甲", "乙", "丙", "丁"]);
  // 不改傳進來的順序
  const keys = ["甲", "乙", "丙"], prev = ["丙", "乙", "甲"];
  C.arrivalOrder(keys, { 甲: 3, 乙: 2, 丙: 1 }, prev);
  assert.deepEqual([keys, prev], [["甲", "乙", "丙"], ["丙", "乙", "甲"]]);
});

// ---------------------------------------------------------------- 幫忙量路況的路線
test("挑幫手路線：每次挑能補最多站間段的那一條；只經過一段的不挑；跳過指定的；挑到上限或沒有幫助為止", () => {
  // 關注的路線經過站牌 1→2→3→4→5（四個站間段）。其他路線：10 號經過 1、2、3、4、5；11 號經過 1、2、3；12 號經過 3、4、5；13 號只經過 4、5；14 號走反方向
  const mine = [{ stops: [1, 2, 3, 4, 5].map((n) => ({ station: n })) }];
  const at = { 1: [[10, 0], [11, 0], [14, 1]], 2: [[10, 0], [11, 0], [14, 1]], 3: [[10, 0], [11, 0], [12, 0], [14, 1]], 4: [[10, 0], [12, 0], [13, 0], [14, 1]], 5: [[10, 0], [12, 0], [13, 0]] };
  const stopsAt = new Map(Object.entries(at)), pick = (skip, limit, need, vs = mine) => C.helperRoutes(vs, stopsAt, new Set(skip), limit, need);
  // 方向不看（去返程的區別在站牌編號上：對向是另一根站牌），所以 14 號也算經過 1>2、2>3、3>4
  assert.deepEqual(pick([], 10, 1), [10], "一條就把四段都補到一次了：其他的沒有幫助");
  assert.deepEqual(pick([], 10, 2), [10, 14, 12], "每段要兩條：10 補四段、14 再補三段（和 11、12 同分時取序號小的…11 只補得到兩段）、最後 12 補 4>5");
  assert.deepEqual(pick([], 2, 2), [10, 14], "上限兩條");
  assert.deepEqual(pick([10], 10, 1), [14, 12], "跳過 10 號");
  assert.deepEqual(pick([10, 14], 10, 1), [11, 12], "同樣補兩段：序號小的先");
  assert.deepEqual(pick([10, 11, 12, 14], 10, 1), [], "13 號只經過一段：不挑（共用路段要連續兩站以上才借得到）");
  assert.deepEqual(pick([], 0, 2), []);
  // 站牌編號是字串或數字都對得上；索引裡沒有的站牌不影響
  assert.deepEqual(C.helperRoutes([{ stops: ["1", "2", "3", "99"].map((n) => ({ station: n })) }], stopsAt, new Set(), 1, 1), [10]);
  // 兩條關注的路線：站間段合起來算，重複的只算一次
  const two = [mine[0], { stops: [3, 4, 5].map((n) => ({ station: n })) }];
  assert.deepEqual(pick([], 10, 1, two), [10]);
  assert.deepEqual(C.helperRoutes([], stopsAt, new Set(), 10, 2), []);
});

test("幫手路線的車只留最近十分鐘的軌跡；使用者關注了它就改回一般路線", () => {
  const H = { ...VARIANT, subRouteId: "950", routeId: "95H", label: "幫手" };
  const tr = C.createTracker([VARIANT]);
  assert.equal(C.addVariants(tr, [H], true).length, 1);
  assert.deepEqual([C.entOf(tr, "900").helper, C.entOf(tr, "950").helper], [false, true]);
  for (let m = 0; m <= 30; m++) {
    const hhmm = `09:${String(m).padStart(2, "0")}`;
    C.ingestBusData(tr, { BusInfo: [fix("一般", 1 + m * 0.1, hhmm), fix("幫手車", 1 + m * 0.1, hhmm, { route: "950" })] }, T(hhmm));
  }
  assert.equal(tr.buses.get("一般").trace.length, 31);
  assert.equal(tr.buses.get("幫手車").trace.length, 11, "09:20–09:30");
  assert.ok(C.entOf(tr, "950").bins.filter(Boolean).length > 5, "段速照樣記");
  // 再加一次、這次不是幫手：不重複加，但身分改掉，軌跡從此留完整的
  assert.equal(C.addVariants(tr, [H]).length, 0);
  assert.equal(C.entOf(tr, "950").helper, false);
  C.ingestBusData(tr, { BusInfo: [fix("幫手車", 4.1, "09:31", { route: "950" })] }, T("09:31"));
  assert.equal(tr.buses.get("幫手車").trace.length, 12);
  // 以幫手的身分再加一次已經是一般路線的：不會被降回幫手
  C.addVariants(tr, [H], true);
  assert.equal(C.entOf(tr, "950").helper, false);
});

test("共用路段的比對：站牌編號一邊是字串、一邊是數字也對得上（內建路線與全市路線檔）", () => {
  const A = { stops: ["1", "2", "3"].map((n, i) => ({ station: n, name: "站" + n, km: i })) };
  const B = { stops: [1, 2, 3].map((n, i) => ({ station: n, name: "站" + n, km: i })) };
  assert.deepEqual(C.sharedSegments(A, B).map((s) => [s.v0, s.v1]), [[0, 1], [1, 2]]);
});

// ---------------------------------------------------------------- 畫面上寫不寫「約」
test("自己估的時刻寫「約」：官方報的不寫（含未發車、未定位），依班距的寫的是「≤」也不寫", () => {
  const approx = ["前車", "均速", "預設", "官方→前車", "官方→均速", "官方→預設", "班表"];
  const exact = ["官方", "官方・未發車", "官方・未定位", "班距"];
  assert.deepEqual(approx.map(C.isApprox), approx.map(() => true));
  assert.deepEqual(exact.map(C.isApprox), exact.map(() => false));
  // 核心實際會產生的來源都在上面兩組裡：用一個有官方預估、有前車、有班表的情境把來源收一遍
  const tr = trackerWith([["09:20", [fix("A", 4, "09:20", { route: "901" }), fix("B", 1, "09:20", { route: "901" })]]], [TT]);
  const r = C.routeArrivals(tr, "901", etaOf("09:20", [[5, 180], [2, 200, "1"]], "91"), T("09:20"));
  const seen = new Set(r.perStop.flat().map((a) => a.source));
  for (const s of seen) assert.ok(approx.includes(s) || exact.includes(s), `沒歸類的來源：${s}`);
  assert.ok(seen.has("官方") && seen.has("班表") && [...seen].some((s) => s.startsWith("官方→")), [...seen].join("、"));
});

