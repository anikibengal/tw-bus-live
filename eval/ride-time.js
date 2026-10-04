/* 「從這一站搭到那一站要多久」準不準：用記錄器存下的快照重播，比較預估車程與那台車實際跑的時間。
 * 用的是網頁同一份 web/core.js（rideEstimate）與 web/data/app-data.js，驗證的就是頁面實際在跑的邏輯。
 *
 * 用法：node eval/ride-time.js logs/2026-10-03-day [--every 60]
 *
 * 做法：每隔 --every 秒（資料時間），對每個變體挑幾個上車站，各配幾個下車站（往後 3、6、10、15、20、30 站）；
 *   只看「下一班 20 分鐘內會到上車站、而且是有定位的車」的情況——人站在站牌、要搭下一班時問的問題。
 *   實際車程＝那台車之後越過兩站的時刻相減（GPS 軌跡內插）。
 * 比四種算法（誤差＝預估 − 實際，分鐘；正值＝實際比預估快）：
 *   頁面    core.rideEstimate：同一台車在兩站的推估時刻相減，推不到下車站才用前車段速
 *   段速    只用前車段速走這一段（沒量到的分段用預設車速）
 *   預設    整段都用預設車速（剛打開頁面、完全沒有歷史時的下限）
 *   官方差  兩站的官方預估直接相減（使用者自己看得到的數字；兩個數字指的不一定是同一台車）
 */
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : d; };
const dayDir = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
if (!dayDir) { console.error("用法：node eval/ride-time.js logs/<日期-標籤>"); process.exit(1); }
const ROOT = path.resolve(__dirname, "..");
const C = require(path.join(ROOT, "web", "core.js"));
const EVERY_S = Number(opt("every", "60"));
const BOARD_MAX_MIN = 20, FROM_STEP = 4, HOPS = [3, 6, 10, 15, 20, 30];

const src = fs.readFileSync(path.join(ROOT, "web", "data", "app-data.js"), "utf8");
const D = JSON.parse(src.slice(src.indexOf("=") + 1).trim().replace(/;$/, ""));
const routeIds = [...new Set(D.variants.map((v) => v.routeId))];
const load = (p) => C.parseBlobJson(zlib.gunzipSync(fs.readFileSync(p)).toString("utf8"));
const list = (name) => fs.readdirSync(path.join(dayDir, name)).filter((f) => f.endsWith(".gz")).map((f) => path.join(dayDir, name, f))
  .map((f) => ({ f, t: C.parseTpe(load(f).EssentialInfo.UpdateTime) })).filter((x) => Number.isFinite(x.t)).sort((a, b) => a.t - b.t);
const bd = list("GetBusData"), et = list("GetEstimateTime");

// ---------------------------------------------------------------- 第一遍：重播、記下預估
const tracker = C.createTracker(D.variants), full = new Map(), preds = [];
let ei = -1, eta = null, lastT = -Infinity;
const t0 = bd[0].t;
for (const { f } of bd) {
  const blob = load(f), now = C.parseTpe(blob.EssentialInfo.UpdateTime);
  C.ingestBusData(tracker, blob, now);
  for (const [id, bus] of tracker.buses) {
    const p = bus.trace[bus.trace.length - 1];
    if (!p) continue;
    if (!full.has(id)) full.set(id, []);
    const arr = full.get(id), last = arr[arr.length - 1];
    if (!last || last.t < p.t) arr.push({ t: p.t, km: p.km, sub: bus.tid, duty: p.duty });
  }
  let moved = false;
  while (ei + 1 < et.length && et[ei + 1].t <= now) { ei++; moved = true; }
  if (moved) eta = C.indexEta(load(et[ei].f), routeIds);
  if (now - lastT < EVERY_S * 1000) continue;
  lastT = now;
  for (const v of D.variants) {
    const R = C.routeArrivals(tracker, v.tid, eta, now), ent = C.entOf(tracker, v.tid);
    const off = (s) => { const x = eta && eta.map.get(`${v.routeId}|${v.direction}|${s.id}`); return x != null && x >= 0 ? x : null; };
    for (let i = 1; i < v.stops.length - 1; i += FROM_STEP) {
      const first = R.perStop[i][0];
      if (!first || !first.bus || (first.ms - now) / 60e3 > BOARD_MAX_MIN) continue;
      for (const hop of HOPS) {
        const j = i + hop;
        if (j >= v.stops.length) break;
        const est = C.rideEstimate(tracker, v.tid, R, i, j, now);
        const k0 = v.stops[i].km, k1 = v.stops[j].km;
        const seg = C.travelMin(ent, k0, k1, 60 / C.defaultKmhAt(now), now);
        const oi = off(v.stops[i]), oj = off(v.stops[j]);
        preds.push({ now, sub: v.tid, label: v.display, bus: first.bus, k0, k1, km: k1 - k0,
                     page: est.min, usedBus: !!est.bus, seg: seg.min, cov: seg.coverage, def: (k1 - k0) * 60 / C.defaultKmhAt(now),
                     off: oi != null && oj != null && oj > oi ? (oj - oi) / 60 : null, warmMin: (now - t0) / 60e3 });
      }
    }
  }
}

// ---------------------------------------------------------------- 第二遍：那台車實際跑了多久
function actualPass(busId, sub, now, stopKm) {
  const arr = full.get(busId);
  if (!arr) return null;
  let prev = null;
  for (const p of arr) {
    if (p.t < now) { prev = p.sub === sub && p.km != null ? p : null; continue; }
    if (p.sub !== sub) return null;
    if (p.km == null) continue;
    if (prev && p.km < prev.km - 1) return null;
    if (prev && prev.km < stopKm && p.km >= stopKm) return p.t - prev.t > 3 * 60e3 ? null : prev.t + (p.t - prev.t) * (stopKm - prev.km) / ((p.km - prev.km) || 1);
    prev = p;
  }
  return null;
}
const rows = [];
for (const p of preds) {
  const a = actualPass(p.bus, p.sub, p.now, p.k0), b = a == null ? null : actualPass(p.bus, p.sub, p.now, p.k1);
  if (a == null || b == null || b <= a) continue;
  rows.push({ ...p, act: (b - a) / 60e3 });
}

// ---------------------------------------------------------------- 統計
const q = (xs, p) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); const i = (s.length - 1) * p, lo = Math.floor(i); return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo); };
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : "-");
const stat = (es) => ({ n: es.length, mae: es.reduce((s, x) => s + Math.abs(x), 0) / (es.length || 1), med: q(es, 0.5), p10: q(es, 0.1), p90: q(es, 0.9),
                        pct: NaN });
const line = (name, rs, key) => {
  const ok = rs.filter((r) => r[key] != null), es = ok.map((r) => r[key] - r.act), s = stat(es);
  const rel = q(ok.map((r) => Math.abs(r[key] - r.act) / r.act), 0.5) * 100;
  return `  ${name.padEnd(5)} n=${String(s.n).padStart(5)}  平均絕對誤差 ${f1(s.mae).padStart(4)} 分  中位 ${f1(s.med).padStart(5)}  P10 ${f1(s.p10).padStart(5)}  P90 ${f1(s.p90).padStart(5)}  相對誤差中位 ${f1(rel).padStart(4)}%`;
};
const METHODS = [["頁面", "page"], ["段速", "seg"], ["預設", "def"], ["官方差", "off"]];
const BUCKETS = [[0, 5], [5, 10], [10, 20], [20, 40], [40, 90]];
const out = { log: path.basename(dayDir), from: C.fmtTime(bd[0].t), to: C.fmtTime(bd[bd.length - 1].t), preds: preds.length, matched: rows.length, table: {} };
console.log(`記錄 ${out.from}–${out.to}；預估 ${preds.length} 筆，對得到實際車程 ${rows.length} 筆（其餘是記錄結束前還沒到下車站）`);
console.log("誤差＝預估車程 − 實際車程（分）。依實際車程分組：\n");
for (const [lo, hi] of BUCKETS) {
  const rs = rows.filter((r) => r.act >= lo && r.act < hi);
  if (rs.length < 30) continue;
  console.log(`實際車程 ${lo}–${hi} 分（${rs.length} 筆，中位 ${f1(q(rs.map((r) => r.act), 0.5))} 分、${f1(q(rs.map((r) => r.km), 0.5))} km）`);
  for (const [name, key] of METHODS) {
    console.log(line(name, rs, key));
    const ok = rs.filter((r) => r[key] != null);
    out.table[`${name}|${lo}-${hi}`] = stat(ok.map((r) => r[key] - r.act));
  }
}
console.log("\n頁面開了多久（從記錄開始算）× 頁面算法，實際車程 10–40 分：");
for (const [lo, hi] of [[0, 10], [10, 30], [30, 999]]) {
  const rs = rows.filter((r) => r.act >= 10 && r.act < 40 && r.warmMin >= lo && r.warmMin < hi);
  if (!rs.length) continue;
  console.log(`  開了 ${lo}–${hi === 999 ? "" : hi} 分`.padEnd(14) + line("", rs, "page").trim() + `  段速涵蓋中位 ${(q(rs.map((r) => r.cov), 0.5) * 100).toFixed(0)}%`);
  out.table[`頁面|開了${lo}-${hi}`] = stat(rs.map((r) => r.page - r.act));
}
console.log("\n頁面算法依「有沒有前車段速」分（實際車程 10–40 分）：");
for (const [name, test] of [["涵蓋 <30%", (c) => c < 0.3], ["30–80%", (c) => c >= 0.3 && c < 0.8], ["≥80%", (c) => c >= 0.8]]) {
  const rs = rows.filter((r) => r.act >= 10 && r.act < 40 && test(r.cov));
  if (rs.length) console.log(`  ${name.padEnd(8)}` + line("", rs, "page").trim());
}
console.log("\n各路線（頁面算法，實際車程 10–40 分）：");
for (const label of [...new Set(rows.map((r) => r.label))]) {
  const rs = rows.filter((r) => r.label === label && r.act >= 10 && r.act < 40);
  if (rs.length >= 30) console.log(`  ${label.padEnd(8)}` + line("", rs, "page").trim());
}
const used = rows.filter((r) => r.usedBus).length;
console.log(`\n頁面算法裡，同一台車兩站都推得到的占 ${(used / (rows.length || 1) * 100).toFixed(0)}%，其餘用前車段速`);
const outDir = path.join(ROOT, "eval", "out");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, `${path.basename(dayDir)}--ride-time.json`), JSON.stringify(out, null, 1));
