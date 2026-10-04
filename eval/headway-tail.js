/* 收班前「依班距」那一筆準不準：畫面上列了「≤ N 分・依班距」，之後真的有那一班車來嗎？
 * 用記錄器存下的快照重播，新舊兩版核心各算一次，對照之後 GPS 軌跡裡實際經過那一站的車數。
 *
 * 用法：node eval/headway-tail.js logs/2026-10-03-night [--old eval/baseline/core-v3.5.js] [--every 60] [--city]
 *   --city：除了內建路線，再加上全市路線檔裡「台北市、有班距表、當天末班發車在 21:45–22:40」的路線（記錄只有台北市；
 *           末班太晚的路線，末班車在記錄結束前跑不完，驗不了）。只有三條內建路線時樣本太少，規則要靠這一批訂。
 *
 * 判定：某一站在時刻 now 列了 k 筆（最後一筆是「依班距」），而 now 之後實際只有不到 k 台車經過這一站
 *   → 那一筆「依班距」是不存在的車。反過來，舊版有列、新版沒列、而那班車真的有來 → 少列了一班。
 * 只看有班距表的路線。「≤」寫的時刻離記錄結束不到 20 分鐘的不算：車要是晚一點來，記錄裡看不到，會被誤判成不存在。
 * 起點 0.6 km 內的站不算：車的第一筆定位常常已經過了這些站，數不到「經過」。
 *
 * 另外依舊版的每一筆分類（離末班發車還有多久 × 這一站前面已經列了什麼），看不存在的車集中在哪一格——規則要對著這張表訂。
 */
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : d; };
const dayDir = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
if (!dayDir) { console.error("用法：node eval/headway-tail.js logs/<日期-標籤>"); process.exit(1); }
const ROOT = path.resolve(__dirname, "..");
const NEW = require(path.join(ROOT, "web", "core.js"));
const OLD = require(path.resolve(opt("old", path.join(ROOT, "eval", "baseline", "core-v3.5.js"))));
const EVERY_S = Number(opt("every", "60"));
const DAY = opt("day", "");                           // 記錄是星期幾（sat…）；不給就看記錄的 status.json
const NEAR_ORIGIN_KM = 0.6, MARGIN_MS = 20 * 60e3;

const src = fs.readFileSync(path.join(ROOT, "web", "data", "app-data.js"), "utf8");
const D = JSON.parse(src.slice(src.indexOf("=") + 1).trim().replace(/;$/, ""));
const ALL = [...D.variants];
if (args.includes("--city")) {
  const builtin = new Set(D.variants.map((v) => v.family)), dir = path.join(ROOT, "web", "data", "routes");
  const dayKey = NEW.serviceDay(NEW.parseTpe(JSON.parse(fs.readFileSync(path.join(dayDir, "status.json"), "utf8")).startedAt || "") || Date.now()).dayKey;
  for (const f of fs.readdirSync(dir).filter((x) => x.startsWith("tpe-"))) {
    const r = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    if (builtin.has(r.name)) continue;
    for (const v of r.variants) {
      const ws = v.schedule.type === "frequency" ? v.schedule.windows.filter((w) => w.days.includes(DAY || dayKey)) : [];
      if (ws.length === 1 && ws[0].end >= "21:45" && ws[0].end <= "22:40") ALL.push(v);
    }
  }
}
const routeIds = [...new Set(ALL.map((v) => v.routeId))];
const FQ = ALL.filter((v) => v.schedule && v.schedule.type === "frequency");
const load = (p) => NEW.parseBlobJson(zlib.gunzipSync(fs.readFileSync(p)).toString("utf8"));
const list = (name) => fs.readdirSync(path.join(dayDir, name)).filter((f) => f.endsWith(".gz")).map((f) => path.join(dayDir, name, f))
  .map((f) => ({ f, t: NEW.parseTpe(load(f).EssentialInfo.UpdateTime) })).filter((x) => Number.isFinite(x.t)).sort((a, b) => a.t - b.t);
const bd = list("GetBusData"), et = list("GetEstimateTime");
/** 這一段營運時段的末班發車時刻（和核心的 serviceEndMs 同一個算法；舊版核心沒有這個函式，所以這裡自己算一次）。 */
function endOf(v, now) {
  const sd = NEW.serviceDay(now), m = (now - sd.start) / 60e3, today = v.schedule.windows.filter((x) => x.days.includes(sd.dayKey));
  const w = today.find((x) => NEW.hhmmToMin(x.start) <= m && m < NEW.hhmmToMin(x.end));
  if (!w) return null;
  let end = NEW.hhmmToMin(w.end);
  for (let grew = true; grew;) { grew = false; for (const x of today) if (NEW.hhmmToMin(x.start) <= end && NEW.hhmmToMin(x.end) > end) { end = NEW.hhmmToMin(x.end); grew = true; } }
  return sd.start + end * 60e3;
}

// ---------------------------------------------------------------- 第一遍：兩版各自重播，記下每一站列了什麼
const trN = NEW.createTracker(ALL), trO = OLD.createTracker(ALL);
const full = new Map();           // 車 → [{t, km, tid}]
const snaps = [], seenTid = new Set();
let ei = -1, etaN = null, etaO = null, lastT = -Infinity;
for (const { f } of bd) {
  const blob = load(f), now = NEW.parseTpe(blob.EssentialInfo.UpdateTime);
  NEW.ingestBusData(trN, blob, now); OLD.ingestBusData(trO, blob, now);
  for (const [id, bus] of trN.buses) {
    const p = bus.trace[bus.trace.length - 1];
    if (!p || p.km == null) continue;
    if (!full.has(id)) full.set(id, []);
    const arr = full.get(id), last = arr[arr.length - 1];
    if (!last || last.t < p.t) arr.push({ t: p.t, km: p.km, tid: bus.tid });
  }
  let moved = false;
  while (ei + 1 < et.length && et[ei + 1].t <= now) { ei++; moved = true; }
  if (moved) { const b = load(et[ei].f); etaN = NEW.indexEta(b, routeIds); etaO = OLD.indexEta(b, routeIds); }
  if (now - lastT < EVERY_S * 1000) continue;
  lastT = now;
  for (const v of FQ) {
    const RN = NEW.routeArrivals(trN, v.tid, etaN, now), RO = OLD.routeArrivals(trO, v.tid, etaO, now);
    const atOrigin = new Set(RO.active.filter((b) => b.km < OLD.P.originKm).map((b) => b.id));
    if (RO.active.length) seenTid.add(v.tid);                     // 從記錄開始到現在，這個變體有沒有出現過營運中的車
    const hw = OLD.headwayNow(v, now);
    v.stops.forEach((s, si) => {
      if (s.km < NEAR_ORIGIN_KM) return;
      const o = RO.perStop[si], n = RN.perStop[si];
      if (!o.some((a) => a.source === "班距") && !n.some((a) => a.source === "班距")) return;
      const first = o[0] && o[0].source !== "班距" ? o[0] : null;
      const before = !first ? "前面沒有車" : first.bus ? (atOrigin.has(first.bus) ? "車還在起點" : "車已在路上") : first.source;
      snaps.push({ now, v, si, stopKm: s.km, hw, before, firstMs: first ? first.ms : null, nActive: RO.active.length, seen: seenTid.has(v.tid),
                   old: o.map((a) => a.source), neu: n.map((a) => a.source),
                   oldMs: (o.find((a) => a.source === "班距") || {}).ms, neuMs: (n.find((a) => a.source === "班距") || {}).ms });
    });
  }
}

// ---------------------------------------------------------------- 第二遍：now 之後實際有幾台車經過這一站、各在什麼時候
const cache = new Map();
function passes(tid, now, stopKm) {
  const k = tid + "|" + stopKm;
  if (!cache.has(k)) {
    const out = [];
    for (const arr of full.values()) {
      let prev = null;
      for (const p of arr) {
        if (p.tid !== tid) { prev = null; continue; }
        if (prev && p.km < prev.km - 1) prev = null;                     // 倒退很多：新的一趟
        if (prev && prev.km < stopKm && p.km >= stopKm) out.push(p.t);
        prev = p;
      }
    }
    cache.set(k, out.sort((a, b) => a - b));
  }
  return cache.get(k).filter((t) => t > now);
}

const tally = () => ({ listed: 0, ghost: 0, late: 0, lost: 0 });
const T = { 舊: { all: tally(), tail: tally() }, 新: { all: tally(), tail: tally() } };
const cells = {}, cells2 = {}, olds = [], ex = [], logEnd = bd[bd.length - 1].t;
for (const s of snaps) {
  if (Math.max(s.oldMs || 0, s.neuMs || 0) > logEnd - MARGIN_MS) continue;
  const act = passes(s.v.tid, s.now, s.stopKm), end = endOf(s.v, s.now);
  const left = end == null ? null : (end - s.now) / 60e3;
  const tail = left != null && left <= 30;                               // 離末班發車 30 分鐘內
  for (const [name, srcs, ms] of [["舊", s.old, s.oldMs], ["新", s.neu, s.neuMs]]) {
    const k = srcs.indexOf("班距");
    if (k < 0) continue;
    const real = act.length > k;                                         // 這一筆是第 k+1 班：之後真的有那麼多台車嗎
    for (const b of tail ? ["all", "tail"] : ["all"]) {
      T[name][b].listed++;
      if (!real) T[name][b].ghost++;
      else if (act[k] > ms + 60e3) T[name][b].late++;                    // 車有來，但比「≤」寫的還晚超過 1 分鐘
    }
    if (!real && name === "新" && ex.length < 6) ex.push(`${NEW.fmtTime(s.now)} ${s.v.display} 往${s.v.toward} ${s.v.stops[s.si].name}：列了 ${srcs.join("、")}；之後實際 ${act.length} 台`);
    if (name === "舊" && s.hw) {
      const zone = left == null ? "不在時段內" : left < s.hw.min ? "① 不到最短班距" : left <= s.hw.max ? "② 最短～最長班距之間" : "③ 超過最長班距";
      const run = s.nActive ? "現在有車在跑" : s.seen ? "現在沒車、稍早有" : "一直沒看到車";
      const lateMin = real ? (act[k] - ms) / 60e3 : null;
      const add = (table, key) => { const c = (table[key] = table[key] || { n: 0, ghost: 0, late: 0 }); c.n++; if (!real) c.ghost++; else if (lateMin > 1) c.late++; };
      add(cells2, run + "｜" + s.before);
      if (s.nActive) add(cells, zone + "｜" + s.before);
      olds.push({ run: !!s.nActive, zone: zone[0], before: s.before, real, lateMin });
    }
  }
  const ko = s.old.indexOf("班距");
  if (ko >= 0 && !s.neu.includes("班距") && act.length > ko) { T.新.all.lost++; if (tail) T.新.tail.lost++; }
}
const pct = (a, b) => (b ? (a / b * 100).toFixed(1) + "%" : "-");
console.log(`記錄 ${NEW.fmtTime(bd[0].t)}–${NEW.fmtTime(logEnd)}；每 ${EVERY_S} 秒看一次，${FQ.length} 個有班距表的變體（${[...new Set(FQ.map((v) => v.family || v.display))].length} 條路線；起點 ${NEAR_ORIGIN_KM} km 內的站不算）`);
for (const [label, key] of [["整段記錄", "all"], ["離末班發車 30 分鐘內", "tail"]]) {
  console.log(`\n${label}（站 × 時刻）`);
  for (const name of ["舊", "新"]) {
    const t = T[name][key];
    console.log(`  ${name}版  列了「依班距」${String(t.listed).padStart(6)} 筆  其中不存在的車 ${String(t.ghost).padStart(5)}（${pct(t.ghost, t.listed)}）  有來但比「≤」晚 ${String(t.late).padStart(5)}（${pct(t.late, t.listed)}）` +
      (name === "新" ? `  舊版有列、真的有車、新版沒列 ${t.lost}` : ""));
  }
}
const row = (k, c) => `  ${k.padEnd(28)} ${String(c.n).padStart(6)} 筆  不存在 ${String(c.ghost).padStart(5)}（${pct(c.ghost, c.n).padStart(6)}）  有來但比「≤」晚 ${String(c.late).padStart(5)}（${pct(c.late, c.n).padStart(6)}）`;
console.log("\n舊版的每一筆「依班距」：這個變體現在有沒有車在跑 × 這一站前面已經列了什麼");
for (const k of Object.keys(cells2).sort()) console.log(row(k, cells2[k]));
console.log("\n只看「現在有車在跑」的變體：離末班發車還有多久 × 前面已經列了什麼");
for (const k of Object.keys(cells).sort()) console.log(row(k, cells[k]));

// 候選規則：都從舊版的每一筆出發，決定哪些還要列。比的是「列出來的裡面有多少不存在」與「少列了多少真的有來的車」
const official = (b) => b === "官方・未發車" || b === "官方・未定位";
const RULES = [
  ["舊版（全部照列）", () => true],
  ["甲：這個變體現在要有車在跑", (o) => o.run],
  ["甲＋乙1：官方未發車／未定位後面，離末班超過最長班距才列", (o) => o.run && !(official(o.before) && o.zone !== "③")],
  ["甲＋乙2：官方未發車／未定位後面一律不列", (o) => o.run && !official(o.before)],
  ["甲＋乙3：前面那班不是已在路上的車，離末班超過最長班距才列", (o) => o.run && !(o.before !== "前面沒有車" && o.before !== "車已在路上" && o.zone !== "③")],
  ["甲＋乙2＋丙：前面沒有車時也不列（只剩接在看得到的車後面）", (o) => o.run && !official(o.before) && o.before !== "前面沒有車"],
];
console.log("\n候選規則（從舊版的 " + olds.length + " 筆出發）");
for (const [name, keep] of RULES) {
  const kept = olds.filter(keep), ghost = kept.filter((o) => !o.real).length, late = kept.filter((o) => o.real && o.lateMin > 1).length;
  const lost = olds.filter((o) => !keep(o) && o.real).length;
  console.log(`  ${name}\n      列 ${String(kept.length).padStart(6)} 筆  不存在 ${String(ghost).padStart(5)}（${pct(ghost, kept.length)}）  比「≤」晚 ${String(late).padStart(5)}（${pct(late, kept.length)}）  少列真的有來的 ${String(lost).padStart(5)}（占原本真的有來的 ${pct(lost, olds.filter((o) => o.real).length)}）`);
}
const lates = olds.filter((o) => o.run && o.real && o.lateMin > 1).map((o) => o.lateMin).sort((a, b) => a - b);
if (lates.length) console.log(`\n有車在跑的變體裡，比「≤」晚到的那些晚了多久：中位 ${lates[lates.length >> 1].toFixed(1)} 分、九成在 ${lates[Math.floor(lates.length * 0.9)].toFixed(1)} 分以內`);
if (ex.length) console.log("\n新版仍然列了不存在的車，例：\n  " + ex.join("\n  "));
