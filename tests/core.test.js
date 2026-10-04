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

test("前車段速：前車剛以 30 km/h 跑過 → 後車用前車段速", () => {
  const tr = trackerWith([
    ["09:18", [fix("A", 3, "09:18")]], ["09:20", [fix("A", 4, "09:20")]], ["09:22", [fix("A", 5, "09:22")]],
    ["09:24", [fix("A", 6, "09:24")]], ["09:26", [fix("A", 7, "09:26"), fix("B", 3, "09:26")]],
  ]);
  const r = C.routeArrivals(tr, "900", null, T("09:26"));
  assert.deepEqual(at(r.perStop[6]).find((x) => x[0] === "B"), ["B", "09:32", "前車"]);   // 3 km × 2 分/km
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
  for (let b = 0; b < 50; b++) ent.bins[b] = { pace: 12, at: T("09:29") };
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
  for (let k = 0; k < 5.05; k += 0.2) B.bins[Math.floor(k / C.P.binKm + 1e-9)] = { pace: 3, at: now - 60e3 };
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
  for (let k = 3; k < 4; k += 0.2) A.bins[Math.floor(k / C.P.binKm + 1e-9)] = { pace: 1, at: now - 20 * 60e3 };
  for (let k = 3; k < 4.1; k += 0.2) B.bins[Math.floor(k / C.P.binKm + 1e-9)] = { pace: 3, at: now - 60e3 };
  assert.ok(C.travelMin(A, 3, 4, 9, now).min > 2.5, "較新的 B 段速（3 分/km）應優先");
  for (let k = 3; k < 4; k += 0.2) A.bins[Math.floor(k / C.P.binKm + 1e-9)] = { pace: 1, at: now };
  assert.ok(C.travelMin(A, 3, 4, 9, now).min < 1.5, "A 自己更新後改用 A");
});

test("借用段速：車少的變體在共用路段的推算來源變成前車", () => {
  const tr = C.createTracker([VA, VB]);
  const now = T("09:30"), B = C.entOf(tr, "911");
  for (let k = 3; k < 5.05; k += 0.2) B.bins[Math.floor(k / C.P.binKm + 1e-9)] = { pace: 3, at: now - 60e3 };
  C.ingestBusData(tr, { BusInfo: [{ ...fix("X", 3, "09:30"), RouteID: "910" }] }, now);
  const r = C.routeArrivals(tr, "910", null, now);
  assert.deepEqual(at(r.perStop[4])[0], ["X", "09:33", "前車"]);     // 共2→共3 1 km × 3 分
});

// ---------------------------------------------------------------- 前車段速（越界時刻法）
const binTimes = (tr, sub = "900") => C.entOf(tr, sub).bins.map((b, i) => (b ? [Number((i * 0.2).toFixed(1)), Number((b.pace * 0.2).toFixed(2))] : null)).filter(Boolean);

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

test("只有班距的路線：沒車的站補一筆依班距的上限", () => {
  const tr = trackerWith([], [FQ]);
  const r = C.routeArrivals(tr, "902", null, T("09:30"));
  assert.deepEqual(at(r.perStop[3]), [[null, "09:50", "班距"]]);       // 09:30 + 班距上限 10 + 3 km ÷ 18 km/h
  assert.equal(r.perStop[3][0].upper, true);
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
  for (let b = 25; b < 30; b++) ent.bins[b] = { pace: 6, at: now - 60e3 };
  const r = C.roadAhead(tr, "900", 6, now);
  assert.ok(Math.abs(r.coverage - 0.5) < 1e-9);
  assert.ok(Math.abs(r.kmh - 10) < 1e-6, `應為 10 km/h，實得 ${r.kmh}`);
  assert.deepEqual(C.roadAhead(tr, "900", 3, now), { coverage: 0, kmh: null }, "完全沒量到：不給速度");
  assert.equal(C.roadAhead(tr, "900", 0.2, now), null, "起點附近沒有前方");
  // 資料過期（超過 45 分鐘）就不算
  for (let b = 25; b < 30; b++) ent.bins[b] = { pace: 6, at: now - 50 * 60e3 };
  assert.equal(C.roadAhead(tr, "900", 6, now).kmh, null);
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
      const r = C.routeArrivals(C.createTracker([FQ]), "902", null, T(hhmm));
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

test("站牌依行車方位分段：同方向的併成一段、對面另成一段、方位不明的各自一段", () => {
  // 國泰街口：往東 104 度、往西 291 度
  assert.deepEqual(C.headingSections([{ id: "東", heading: 104 }, { id: "西", heading: 291 }]),
    [{ ids: ["東"], heading: 104, opposite: false }, { ids: ["西"], heading: 291, opposite: true }]);
  // 順序照傳入的順序：先給西，西就是第一段
  assert.deepEqual(C.headingSections([{ id: "西", heading: 291 }, { id: "東", heading: 104 }]).map((s) => [s.ids[0], s.opposite]), [["西", false], ["東", true]]);
  // 捷運西門站：往南的站牌有兩根（195、195），往北的兩根（14、15）；同方向併成一段
  const ximen = C.headingSections([{ id: "南1", heading: 195 }, { id: "北1", heading: 14 }, { id: "南2", heading: 195 }, { id: "北2", heading: 15 }]);
  assert.deepEqual(ximen.map((s) => [s.ids, s.opposite]), [[["南1", "南2"], false], [["北1", "北2"], true]]);
  // 差 45 度以內算同方向（含正北兩側 350 與 20）；差 46 度就分開，但不到 135 度不叫對面
  assert.deepEqual(C.headingSections([{ id: "a", heading: 350 }, { id: "b", heading: 35 }]).map((s) => s.ids), [["a", "b"]]);
  assert.deepEqual(C.headingSections([{ id: "a", heading: 350 }, { id: "b", heading: 36 }]).map((s) => [s.ids, s.opposite]), [[["a"], false], [["b"], false]]);
  assert.deepEqual(C.headingSections([{ id: "a", heading: 0 }, { id: "b", heading: 134 }]).map((s) => s.opposite), [false, false]);
  assert.deepEqual(C.headingSections([{ id: "a", heading: 0 }, { id: "b", heading: 135 }]).map((s) => s.opposite), [false, true]);
  assert.deepEqual(C.headingSections([{ id: "a", heading: 0 }, { id: "b", heading: 225 }]).map((s) => s.opposite), [false, true], "從另一側量也是 135 度");
  // 方位不明：各自一段，不和任何一段併，也不叫對面；方位 0（正北）不是「不明」
  const mixed = C.headingSections([{ id: "甲", heading: null }, { id: "乙", heading: null }, { id: "丙", heading: 0 }, { id: "丁", heading: 10 }, { id: "戊", heading: 180 }]);
  assert.deepEqual(mixed.map((s) => [s.ids, s.opposite]), [[["甲"], false], [["乙"], false], [["丙", "丁"], false], [["戊"], false]]);
  assert.deepEqual(C.headingSections([{ id: "北", heading: 0 }, { id: "南", heading: 180 }])[1].opposite, true);
  // 方位不明的站牌排在往北的站牌後面：不能因為「不明」被當成 0 度就併進去
  assert.deepEqual(C.headingSections([{ id: "北", heading: 0 }, { id: "不明", heading: null }]).map((s) => s.ids), [["北"], ["不明"]]);
  // 「對面」是和第一段比，不是和前一段比
  assert.deepEqual(C.headingSections([{ id: "a", heading: 0 }, { id: "b", heading: 90 }, { id: "c", heading: 180 }]).map((s) => s.opposite), [false, false, true]);
  // 同一根站牌重複給（一根站牌上關注了好幾條路線）：只算一次
  assert.deepEqual(C.headingSections([{ id: "東", heading: 104 }, { id: "東", heading: 104 }, { id: "西", heading: 291 }]).map((s) => s.ids), [["東"], ["西"]]);
  assert.deepEqual(C.headingSections([]), []);
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

test("分段還要看距離：同名但隔了一兩個路口的站牌不併，相隔十幾公尺的才併", () => {
  const LAT = 25.0465, LON = 121.52, M = 1 / 110540;                     // 往北 1 公尺是多少緯度
  const pole = (id, heading, northM) => ({ id, heading, lat: LAT + northM * M, lon: LON });
  // 行政院：往撫遠街的站牌 179 度、往板橋的 216 度，方位只差 37 度，但相隔約 250 公尺 → 兩段，而且不叫對面
  assert.deepEqual(C.headingSections([pole("撫遠街", 179, 0), pole("板橋", 216, 250)]).map((s) => [s.ids, s.opposite]), [[["撫遠街"], false], [["板橋"], false]]);
  // 捷運西門站：往南的兩根相隔 17 公尺 → 併成一段
  assert.deepEqual(C.headingSections([pole("南1", 195, 0), pole("南2", 195, 17)]).map((s) => s.ids), [["南1", "南2"]]);
  // 門檻 80 公尺（含）
  assert.deepEqual(C.headingSections([pole("a", 90, 0), pole("b", 90, 79)]).map((s) => s.ids), [["a", "b"]]);
  assert.deepEqual(C.headingSections([pole("a", 90, 0), pole("b", 90, 81)]).map((s) => s.ids), [["a"], ["b"]]);
  // 一長排站牌：離這一段裡任何一根夠近就算（a–b 60 m、b–c 60 m、a–c 120 m）
  assert.deepEqual(C.headingSections([pole("a", 90, 0), pole("b", 90, 60), pole("c", 90, 120)]).map((s) => s.ids), [["a", "b", "c"]]);
  // 回傳的段不帶座標（只給畫面用得到的欄位）
  assert.deepEqual(Object.keys(C.headingSections([pole("a", 90, 0)])[0]).sort(), ["heading", "ids", "opposite"]);
  // 沒給座標：只看方位（重播、測試資料）
  assert.deepEqual(C.headingSections([{ id: "a", heading: 90 }, pole("b", 90, 500)]).map((s) => s.ids), [["a", "b"]]);
  assert.deepEqual(C.headingSections([pole("a", 90, 0), { id: "b", heading: 90 }]).map((s) => s.ids), [["a", "b"]], "後面那根沒座標也一樣");
});
