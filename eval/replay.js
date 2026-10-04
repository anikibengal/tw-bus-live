/* 重播驗證：用記錄器存下的快照，一步步重播網頁會給出的到站預測，再用之後的 GPS 軌跡算實際到站時刻，比較誤差。
 * 用的是網頁同一份 web/core.js，所以驗證的就是頁面實際在跑的邏輯。
 *
 * 用法：node eval/replay.js logs/2026-10-03-day [--every 60] [--route 307] [--app]
 *   --check-calib <校準檔>：檢查「最早可能」的涵蓋率；--dump <檔>：輸出逐筆明細。校準的配適在 eval/calibrate.js。
 *   --app：改用頁面實際載入的 web/data/app-data.js（所有路線一起追蹤、營運業者已合併），只評估 --route 那一家（all＝全部）。
 *          不加時用 data/routes/Taipei-<route>.json 單獨跑一條路線。
 * 輸出：終端機摘要＋ eval/out/<記錄名>.json（明細統計）
 *
 * 誤差＝預測 − 實際（分鐘）。正值＝車比預測早到（會讓人錯過車）。
 */
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : d; };
const dayDir = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
const CORE = path.resolve(opt("core", path.join(__dirname, "..", "web", "core.js")));   // 可指定舊版做新舊比較
const C = require(CORE);
// --set a=1,b=inst：覆寫核心參數 C.P（做實驗用，例如模擬手機剛打開沒有歷史：--set useBins=false）
for (const kv of (opt("set", "") || "").split(",").filter(Boolean)) {
  const [k, v] = kv.split("=");
  if (!(k in C.P)) { console.error(`這版 core 沒有參數 ${k}`); process.exit(1); }
  C.P[k] = v === "true" ? true : v === "false" ? false : Number.isFinite(Number(v)) ? Number(v) : v;
}
const EVERY_S = Number(opt("every", "60"));          // 每隔幾秒（資料時間）做一次預測
// --from HH:MM：模擬這個時刻才打開頁面（之前的快照不餵給追蹤器）；--predict-min N：只評估打開後 N 分鐘內做的預測。
// 兩個一起用來看「剛打開、還沒累積段速」時準不準。實際到站仍用整段記錄的軌跡算。
const FROM = opt("from", ""), PREDICT_MIN = Number(opt("predict-min", "0"));
const ROUTE = opt("route", "307");
if (!dayDir) { console.error("用法：node eval/replay.js logs/<日期-標籤>"); process.exit(1); }

const ROOT = path.resolve(__dirname, "..");
const APP = args.includes("--app");
let D;
if (APP) {
  const src = fs.readFileSync(path.join(ROOT, "web", "data", "app-data.js"), "utf8");
  D = JSON.parse(src.slice(src.indexOf("=") + 1).trim().replace(/;$/, ""));
} else D = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "routes", `Taipei-${ROUTE}.json`), "utf8"));
const EVAL = D.variants.filter((v) => !APP || ROUTE === "all" || v.family === ROUTE);
if (!EVAL.length) { console.error(`資料裡沒有 ${ROUTE}`); process.exit(1); }
// --extra [N]：把共用路段的其他台北市路線一起追蹤（只拿它們的車來量段速，不評估它們）。記錄只有台北市的車。
//   不給 N：凡是共用兩段以上的都加（上限）；給 N：用頁面同一個挑法（core.helperRoutes）挑 N 條，驗證的就是頁面實際會載入的那幾條。
const EXTRA = [];
if (args.includes("--extra")) {
  const mine = new Set(D.variants.map((v) => String(v.routeId))), dir = path.join(ROOT, "web", "data", "routes");
  const limit = Number(opt("extra", "")) || 0;
  let files = fs.readdirSync(dir).filter((x) => x.startsWith("tpe-"));
  if (limit) {
    const idx = JSON.parse(fs.readFileSync(path.join(ROOT, "web", "data", "city-index.json"), "utf8"));
    const stopsAt = new Map(idx.plats.map((p) => [String(p[0]), p[4]]));
    const skip = new Set(idx.routes.map((r, i) => (mine.has(String(r[3])) || r[2] !== "tpe" ? i : -1)).filter((i) => i >= 0));
    files = C.helperRoutes(EVAL, stopsAt, skip, limit, 2).map((ri) => idx.routes[ri][0].replace(":", "-") + ".json");
  }
  for (const f of files) {
    const r = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    if (mine.has(String(r.routeId))) continue;
    for (const w of r.variants) if (limit || EVAL.some((v) => C.sharedSegments(v, w).length >= 2)) EXTRA.push(w);
  }
  console.log(`另外追蹤 ${EXTRA.length} 個共用路段的變體（${new Set(EXTRA.map((w) => w.family)).size} 條路線）`);
}
const routeIds = [...new Set(D.variants.map((v) => v.routeId))];
const idOf = (v) => (C.tidOf ? C.tidOf(v) : String(v.subRouteId));      // 舊版 core 用子路線編號

const load = (p) => C.parseBlobJson(zlib.gunzipSync(fs.readFileSync(p)).toString("utf8"));
// 依「資料本身的更新時刻」排序，不依檔名：檔名是 HHMMSS，跨午夜的記錄按檔名排會把 00:00 之後的排到最前面
const list = (name) => {
  const dir = path.join(dayDir, name);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".gz")).map((f) => path.join(dir, f))
    .map((f) => ({ f, t: C.parseTpe(load(f).EssentialInfo.UpdateTime) }))
    .filter((x) => Number.isFinite(x.t)).sort((a, b) => a.t - b.t).map((x) => x.f);
};
const bdFiles = list("GetBusData"), etFiles = list("GetEstimateTime");
if (!bdFiles.length) { console.error("沒有 GetBusData 快照"); process.exit(1); }

// ---------------------------------------------------------------- 第一遍：重播並記下預測、同時收集完整軌跡
const tracker = C.createTracker([...D.variants, ...EXTRA]);
const full = new Map();          // 車 → [{t, km, sub, duty}]（不修剪，用來算實際到站）
const preds = [];
let etaIdx = -1, eta = null, lastPredT = -Infinity, nSnap = 0;
const etaTimes = etFiles.map((f) => { const b = load(f); return { f, t: C.parseTpe(b.EssentialInfo.UpdateTime), b: null }; });

const shadow = FROM ? C.createTracker([...D.variants]) : null;     // 有 --from 時：另一個從頭追蹤的追蹤器，只用來收完整軌跡
let openedAt = null;
for (const f of bdFiles) {
  const bd = load(f);
  const now = C.parseTpe(bd.EssentialInfo.UpdateTime);
  if (!Number.isFinite(now)) continue;
  nSnap++;
  const opened = !FROM || C.fmtTime(now) >= FROM || (openedAt != null);
  if (shadow) C.ingestBusData(shadow, bd, now);
  if (opened) { if (openedAt == null) openedAt = now; C.ingestBusData(tracker, bd, now); }
  for (const [id, bus] of (shadow || tracker).buses) {
    const p = bus.trace[bus.trace.length - 1];
    if (!p) continue;
    if (!full.has(id)) full.set(id, []);
    const arr = full.get(id), last = arr[arr.length - 1];
    if (!last || last.t < p.t) arr.push({ t: p.t, km: p.km, sub: bus.tid || bus.subRouteId, duty: p.duty });
  }
  while (etaIdx + 1 < etaTimes.length && etaTimes[etaIdx + 1].t <= now) etaIdx++;
  if (etaIdx >= 0) {
    const e = etaTimes[etaIdx];
    if (!e.b) { e.b = C.indexEta(load(e.f), routeIds); for (const x of etaTimes) if (x !== e) x.b = null; }
    eta = e.b;
  }
  if (!opened || (PREDICT_MIN && now - openedAt > PREDICT_MIN * 60e3)) continue;
  if (now - lastPredT < EVERY_S * 1000) continue;
  lastPredT = now;
  for (const v of EVAL) {
    const R = C.routeArrivals(tracker, idOf(v), eta, now);
    R.perStop.forEach((lst, si) => {
      lst.forEach((a, rank) => {
        if (!a.bus) return;                                   // 未定位／班表：沒有車可以對
        const b = R.active.find((x) => x.id === a.bus);
        preds.push({ now, bus: a.bus, sub: idOf(v), label: v.label, fam: v.family || ROUTE, si, stopKm: v.stops[si].km, busKm: b ? b.km : null,
                     ms: a.ms, source: a.source, rank: rank + 1 });
      });
    });
  }
}

// ---------------------------------------------------------------- 第二遍：實際到站時刻
/** 這台車在 now 之後、同一趟（同子路線、沒有倒退回起點）第一次越過 stopKm 的時刻。 */
function actualPass(busId, sub, now, stopKm) {
  const arr = full.get(busId);
  if (!arr) return null;
  let prev = null;
  for (const p of arr) {
    if (p.t < now) { prev = p.sub === sub && p.km != null ? p : null; continue; }
    if (p.sub !== sub) return null;                            // 換了子路線：這趟結束了
    if (p.km == null) continue;
    if (prev && p.km < prev.km - 1) return null;               // 倒退很多：新的一趟
    if (prev && prev.km < stopKm && p.km >= stopKm) {
      if (p.t - prev.t > 3 * 60e3) return null;                // 中間斷太久，內插不可信
      return prev.t + (p.t - prev.t) * (stopKm - prev.km) / ((p.km - prev.km) || 1);
    }
    prev = p;
  }
  return null;                                                 // 記錄結束前還沒到
}

const rows = [];
let unmatched = 0;
for (const p of preds) {
  const act = actualPass(p.bus, p.sub, p.now, p.stopKm);
  if (act == null) { unmatched++; continue; }
  rows.push({ ...p, act, err: (p.ms - act) / 60e3, horizon: (act - p.now) / 60e3 });
}

// ---------------------------------------------------------------- 統計
const q = (xs, p) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); const i = (s.length - 1) * p, lo = Math.floor(i); return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo); };
function stats(rs) {
  const e = rs.map((r) => r.err);
  return { n: rs.length, median: q(e, 0.5), mae: e.reduce((s, x) => s + Math.abs(x), 0) / (e.length || 1),
           p10: q(e, 0.1), p90: q(e, 0.9), earlyGe1: rs.filter((r) => r.err >= 1).length / (rs.length || 1),
           earlyGe2: rs.filter((r) => r.err >= 2).length / (rs.length || 1) };
}
const group = (src) => (src === "官方" ? "官方" : src.startsWith("官方→") ? "官方→推算" : "推算");
const HB = [[0, 5], [5, 10], [10, 20], [20, 40], [40, 90]];
const hb = (h) => HB.find(([a, b]) => h >= a && h < b);
const table = {};
for (const r of rows) {
  const h = hb(r.horizon);
  if (!h) continue;
  const hk = `${h[0]}-${h[1]}`;
  for (const k of [`${group(r.source)}|${hk}`, `全部|${hk}`, `第${r.rank}班|${hk}`, `${r.source}|全`,
                   `${r.label}${group(r.source) === "官方" ? "官方" : "推算"}|${hk}`,
                   `${r.source.replace("官方→", "")}方式|${hk}`,
                   group(r.source) === "官方" ? null : `非官方|${hk}`]) if (k) (table[k] = table[k] || []).push(r);
}
const out = {};
for (const [k, rs] of Object.entries(table)) out[k] = stats(rs);

const t0 = C.parseTpe(load(bdFiles[0]).EssentialInfo.UpdateTime), t1 = C.parseTpe(load(bdFiles[bdFiles.length - 1]).EssentialInfo.UpdateTime);
console.log(`記錄 ${path.basename(dayDir)}：${C.fmtTime(t0)}–${C.fmtTime(t1)}，${nSnap} 份定位快照、${etFiles.length} 份預估到站快照；每 ${EVERY_S} 秒預測一次`);
console.log(`預測 ${preds.length} 筆，對得到實際到站 ${rows.length} 筆（對不到 ${unmatched} 筆：記錄結束前還沒到、換趟或定位中斷）`);
console.log("誤差＝預測−實際（分）；「早到≥1分」＝車比預測早 1 分鐘以上到（會讓人錯過車）\n");
const fmtN = (x) => (Number.isFinite(x) ? x.toFixed(1).padStart(6) : "     -");
const pct = (x) => ((x * 100).toFixed(0) + "%").padStart(8);
const width = (s) => [...s].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e7f ? 2 : 1), 0);   // 中文算兩格
const padW = (s, w) => s + " ".repeat(Math.max(0, w - width(s)));
const show = (title, keys) => {
  console.log(title);
  console.log(`  ${padW("分組", 12)}${padW("距到站", 10)}${"筆數".padStart(6)}${padW("", 2)}中位數    MAE    P10    P90 早到≥1分 早到≥2分`);
  for (const k of keys) {
    const s = out[k]; if (!s) continue;
    const [g, h] = k.split("|");
    console.log(`  ${padW(g, 12)}${padW(h + " 分", 10)}${String(s.n).padStart(8)}${fmtN(s.median)} ${fmtN(s.mae)} ${fmtN(s.p10)} ${fmtN(s.p90)}${pct(s.earlyGe1)}${pct(s.earlyGe2)}`);
  }
  console.log();
};
const hk = HB.map(([a, b]) => `${a}-${b}`);
show("【依來源】", ["官方", "官方→推算", "推算"].flatMap((g) => hk.map((h) => `${g}|${h}`)));
show("【依名次】第 1 班＝該站下一班、第 2 班＝下下班", ["第1班", "第2班"].flatMap((g) => hk.map((h) => `${g}|${h}`)));
const labels = [...new Set(EVAL.map((v) => v.label))];
show("【依變體】推算＝非官方（含官方→推算）", labels.flatMap((l) => ["官方", "推算"].flatMap((g) => hk.map((h) => `${l}${g}|${h}`))));
show("【依推算用的速度】前車＝前車段速、均速＝這台車近 5 分鐘、預設＝18 km/h（含以官方為起點接續者）", ["前車方式", "均速方式", "預設方式"].flatMap((g) => hk.map((h) => `${g}|${h}`)));
show("【全部】", hk.map((h) => `全部|${h}`));

// 校準（「最早可能」到站的偏移）由 eval/calibrate.js 配適：它需要同時看多段記錄，並分路線 × 時段。
if (args.includes("--calibrate")) { console.error("--calibrate 已移到 eval/calibrate.js：node eval/calibrate.js logs/<記錄> [logs/<記錄> ...]"); process.exit(1); }

// ---------------------------------------------------------------- 校準檢查（--check-calib <校準檔>）
if (opt("check-calib")) {
  const src = fs.readFileSync(opt("check-calib"), "utf8");
  const cal = JSON.parse(src.slice(src.indexOf("=") + 1).trim().replace(/;$/, ""));
  const acc = {};
  const tableOf = (r) => (C.calibFor ? C.calibFor(cal, r.fam, r.now) : cal);      // 新格式依路線與時段挑表
  for (const r of rows) {
    const g = C.calibGroup(r.source);
    if (!g) continue;
    const e = C.earliestMs({ ms: r.ms, source: r.source }, r.now, tableOf(r));
    const shown = e != null ? e : r.ms;                         // 沒給最早時間時，畫面上只有預測時刻
    const hp = (r.ms - r.now) / 60e3;
    const hb2 = hp < 10 ? "0-10" : hp < 30 ? "10-30" : "30-90";
    for (const k of [`${g}|${hb2}`, `全部|${hb2}`, "全部|全"]) {
      const a = (acc[k] = acc[k] || { n: 0, miss: 0, withE: 0, gain: 0 });
      a.n++; if (r.act < shown - 1000) a.miss++;
      if (e != null) { a.withE++; a.gain += (r.ms - e) / 60e3; }
    }
  }
  console.log(`【校準檢查】用 ${path.basename(opt("check-calib"))}（${[].concat(cal.data).join("、")} 產生，分位數 ${cal.quantile}）`);
  console.log("  「比最早還早」＝車比畫面上的最早時間（沒有最早時間時為預測時刻）還早到；設計目標約 " + Math.round((1 - cal.quantile) * 100) + "%");
  for (const [k, a] of Object.entries(acc).sort()) {
    const [g, h] = k.split("|");
    console.log(`  ${padW(g, 12)}${padW(h + " 分", 10)}${String(a.n).padStart(8)} 筆  比最早還早 ${((a.miss / a.n) * 100).toFixed(1).padStart(5)}%  有給最早時間 ${((a.withE / a.n) * 100).toFixed(0).padStart(3)}%  平均提前 ${(a.withE ? a.gain / a.withE : 0).toFixed(1)} 分`);
  }
  console.log();
}

const outDir = path.join(ROOT, "eval", "out");
fs.mkdirSync(outDir, { recursive: true });
if (opt("dump")) fs.writeFileSync(opt("dump"), JSON.stringify(rows));   // 逐筆明細，供臨時分析
const tag = opt("tag", path.basename(CORE, ".js"));
fs.writeFileSync(path.join(outDir, `${path.basename(dayDir)}--${tag}.json`), JSON.stringify({ dayDir, core: CORE, everyS: EVERY_S, nSnap, preds: preds.length, matched: rows.length, unmatched, stats: out }, null, 1));
