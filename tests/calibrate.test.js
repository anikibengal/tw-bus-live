// 「最早可能」校準的測試：node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../web/core.js");
const K = require("../eval/calibrate.js");

const T = (hhmm) => C.parseTpe(`2026-10-03 ${hhmm}:00`);
/** 一筆「預測、實際」：在 now 預測 hp 分後到，實際比預測早 err 分到。 */
const row = (fam, hhmm, source, hp, err, plusS = 0) => {
  const now = T(hhmm) + plusS * 1000, ms = now + hp * 60e3;
  return { fam, now, ms, act: ms - err * 60e3, err, source };
};
/** n 筆誤差均勻落在 lo～hi 的資料（第 90 百分位＝lo + 0.9 × (hi − lo)）。 */
const spread = (fam, hhmm, source, hp, lo, hi, n = 201) =>
  Array.from({ length: n }, (_, i) => row(fam, hhmm, source, hp, lo + ((hi - lo) * i) / (n - 1), i));
const off = (table, group, hp) => table.groups[group].find((b) => hp >= b.h0 && hp < b.h1).offsetMin;

test("偏移＝該來源、該預測距離下「車比預測早到」的第 90 百分位", () => {
  const t = K.fit([...spread("307", "10:00", "官方", 4, -2, 2), ...spread("307", "10:00", "官方", 12, -3, 7)], 0.9);
  assert.equal(off(t, "官方", 4), 1.6);        // −2 + 0.9 × 4
  assert.equal(off(t, "官方", 12), 6);         // −3 + 0.9 × 10
  assert.equal(t.n, 402);
});

test("偏移不隨預測距離縮小；樣本不足的區間沿用前一區間", () => {
  const t = K.fit([...spread("307", "10:00", "官方", 4, 0, 5), ...spread("307", "10:00", "官方", 8, 0, 2),
                   ...spread("307", "10:00", "官方", 25, 0, 20, 30)], 0.9);
  assert.equal(off(t, "官方", 4), 4.5);
  assert.equal(off(t, "官方", 8), 4.5, "算出來是 1.8，但不能比前一區間小");
  assert.equal(off(t, "官方", 12), 4.5, "沒有資料：沿用");
  assert.equal(off(t, "官方", 25), 4.5, "只有 30 筆（不到 150）：沿用，不拿少量樣本算分位數");
  assert.equal(off(t, "官方", 1), null, "最前面沒有資料也沒有前一區間");
});

test("推算兩組樣本少時合併著用；官方不與推算合併", () => {
  const t = K.fit([...spread("307", "10:00", "官方→前車", 4, 0, 2, 100), ...spread("307", "10:00", "預設", 4, 0, 4, 100),
                   ...spread("307", "10:00", "官方", 4, 0, 10, 100)], 0.9);
  const pooled = off(t, "推算", 4);
  assert.ok(pooled > 2 && pooled < 4, `合併 200 筆算出 ${pooled}`);
  assert.equal(off(t, "官方→推算", 4), pooled);
  assert.equal(t.groups["推算"].find((b) => b.h0 === 3).from, "推算合併");
  assert.equal(off(t, "官方", 4), null, "官方只有 100 筆：不能借推算的樣本");
});

test("班表與班距不進校準", () => {
  const t = K.fit([...spread("307", "10:00", "班表", 4, 0, 9), ...spread("307", "10:00", "班距", 4, 0, 9)], 0.9);
  assert.equal(t.n, 0);
});

test("分路線 × 時段各一張表；時段依預測當下的時刻；樣本太少的格子不成格，改用該時段合併表", () => {
  const many = (fam, hhmm, hi) => Array.from({ length: 12 }, () => spread(fam, hhmm, "官方", 4, 0, hi)).flat();   // 2412 筆
  const rows = [...many("307", "10:00", 2), ...many("307", "22:30", 6), ...many("265區", "10:00", 4),
                ...spread("265區", "22:30", "官方", 4, 0, 10)];                                                   // 只有 201 筆
  const cal = K.build(rows, 0.9);
  assert.deepEqual(Object.keys(cal.cells).sort(), ["265區|day", "307|day", "307|night"]);
  assert.equal(off(cal.cells["307|day"], "官方", 4), 1.8);
  assert.equal(off(cal.cells["307|night"], "官方", 4), 5.4);
  assert.equal(off(cal.cells["265區|day"], "官方", 4), 3.6);
  // 執行時怎麼挑：有自己那一格用那一格；沒有就用該時段各路線合併；沒看過的路線也一樣
  const pick = (fam, hhmm) => off(C.calibFor(cal, fam, T(hhmm)), "官方", 4);
  assert.equal(pick("307", "09:00"), 1.8);
  assert.equal(pick("307", "23:00"), 5.4);
  assert.equal(pick("265區", "23:00"), off(cal.fallback.night, "官方", 4));
  assert.equal(pick("沒看過的路線", "09:00"), off(cal.fallback.day, "官方", 4));
  assert.ok(off(cal.fallback.day, "官方", 4) > 1.8 && off(cal.fallback.day, "官方", 4) < 3.6, "合併表介於兩條路線之間");
});

test("檢查：車比畫面上的最早時間還早到才算漏；沒給最早時間時以預測時刻算", () => {
  const table = { groups: { 官方: [{ h0: 0, h1: 90, offsetMin: 2 }], "官方→推算": [], 推算: [] } };
  const cal = { cells: { "307|day": table }, fallback: {} };
  const rows = [row("307", "10:00", "官方", 10, 1), row("307", "10:00", "官方", 10, 2.5), row("307", "10:00", "官方", 10, -3),
                row("307", "10:00", "班表", 10, 9),                 // 不列入
                row("265區", "10:00", "官方", 10, 0.5)];            // 沒有表：最早＝預測時刻，早 0.5 分就算漏
  const c = K.check(rows, cal);
  assert.equal(c.n, 4);
  assert.equal(c.miss, 2 / 4);
  assert.equal(c.lead, (2 + 2 + 2 + 0) / 4);
});

test("樣本外檢查：每格依時間切兩半，前半配適、後半檢查", () => {
  // 前半小時車都準時、後半小時車都早 3 分到：前半配出的偏移擋不住後半
  const early = Array.from({ length: 2400 }, (_, i) => row("307", "10:00", "官方", 4, 0, i));
  const late = Array.from({ length: 2400 }, (_, i) => row("307", "10:50", "官方", 4, 3, i));
  const { train, test: held } = K.splitHalves([...late, ...early]);
  assert.equal(train.length, 2400);
  assert.ok(train.every((r) => r.err === 0) && held.every((r) => r.err === 3), "依時間切，不是依順序");
  const oos = K.outOfSample([...late, ...early], 0.9);
  assert.equal(oos.cells["307|day"].miss, 1);
  assert.equal(K.check([...late, ...early], K.build([...late, ...early], 0.9)).miss, 0, "全部資料配適時看不出來（樣本內）");
});
