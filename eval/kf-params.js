/* 卡爾曼濾波要的三個數字從哪來：用記錄裡每台車越過每個 0.2 km 分段的步調（分／公里）估。
 *   R  觀測雜訊：同一段路、相隔很短的兩台車，步調差多少（紅燈、靠站的運氣）
 *   S  這一段「真正的路況」偏離預設車速的變異數
 *   τ  路況多久會變（相隔越久的兩台車，步調差得越多；差到不再增加的時間尺度）
 * 做法：同一分段相鄰兩筆觀測的差的平方除以 2，依相隔時間分組。相隔很短 ≈ R，相隔很久 ≈ R + S。
 *
 * 用法：node eval/kf-params.js logs/2026-10-03-day
 */
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const dayDir = process.argv[2];
if (!dayDir) { console.error("用法：node eval/kf-params.js logs/<日期-標籤>"); process.exit(1); }
const ROOT = path.resolve(__dirname, "..");
const C = require(path.join(ROOT, "eval", "candidates", "core-kf.js"));
const src = fs.readFileSync(path.join(ROOT, "web", "data", "app-data.js"), "utf8");
const D = JSON.parse(src.slice(src.indexOf("=") + 1).trim().replace(/;$/, ""));
const load = (p) => C.parseBlobJson(zlib.gunzipSync(fs.readFileSync(p)).toString("utf8"));
const files = fs.readdirSync(path.join(dayDir, "GetBusData")).filter((f) => f.endsWith(".gz")).map((f) => path.join(dayDir, "GetBusData", f))
  .map((f) => ({ f, t: C.parseTpe(load(f).EssentialInfo.UpdateTime) })).filter((x) => Number.isFinite(x.t)).sort((a, b) => a.t - b.t);
C.P.kfLog = [];
const tracker = C.createTracker(D.variants);
for (const { f } of files) { const b = load(f); C.ingestBusData(tracker, b, C.parseTpe(b.EssentialInfo.UpdateTime)); }
const obs = C.P.kfLog;
const prior = 60 / C.defaultKmhAt(files[0].t);
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / (xs.length || 1);
const variance = (xs) => { const m = mean(xs); return mean(xs.map((x) => (x - m) ** 2)); };
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor((s.length - 1) * p)]; };
console.log(`${path.basename(dayDir)}：${obs.length} 筆分段觀測（${new Set(obs.map((o) => o.tid + "|" + o.bin)).size} 個分段、${new Set(obs.map((o) => o.bus)).size} 台車）；預設車速的步調 ${prior.toFixed(2)} 分／公里`);
const zs = obs.map((o) => o.z);
console.log(`步調（分／公里）：平均 ${mean(zs).toFixed(2)}、中位 ${q(zs, 0.5).toFixed(2)}、P10 ${q(zs, 0.1).toFixed(2)}、P90 ${q(zs, 0.9).toFixed(2)}；整體變異數 ${variance(zs).toFixed(2)}`);
// 各分段自己的平均（這一段本來就比較慢：有站、有紅燈）占多少
const by = new Map();
for (const o of obs) { const k = o.tid + "|" + o.bin; if (!by.has(k)) by.set(k, []); by.get(k).push(o); }
const binMeans = [...by.values()].filter((l) => l.length >= 4).map((l) => mean(l.map((o) => o.z)));
const within = mean([...by.values()].filter((l) => l.length >= 4).map((l) => variance(l.map((o) => o.z))));
console.log(`分段之間（各段平均的變異數）${variance(binMeans).toFixed(2)}；同一段、不同車之間 ${within.toFixed(2)}`);
// 同一分段相鄰兩筆：半方差 vs 相隔時間
const G = [[0, 5], [5, 10], [10, 20], [20, 40], [40, 90]], acc = G.map(() => []);
for (const l of by.values()) {
  l.sort((a, b) => a.t - b.t);
  for (let i = 0; i < l.length; i++) for (let j = i + 1; j < l.length; j++) {
    const gap = (l[j].t - l[i].t) / 60e3, g = G.findIndex(([a, b]) => gap >= a && gap < b);
    if (g >= 0) acc[g].push((l[j].z - l[i].z) ** 2 / 2);
  }
}
console.log("同一分段的兩台車，步調差的平方 ÷ 2（依相隔幾分鐘）：");
G.forEach(([a, b], i) => console.log(`  相隔 ${String(a).padStart(2)}–${String(b).padEnd(2)} 分  ${String(acc[i].length).padStart(6)} 對  ${mean(acc[i]).toFixed(2)}`));
const R = mean(acc[0]), top = mean(acc[4].length ? acc[4] : acc[3]);
console.log(`→ 觀測雜訊 R ≈ ${R.toFixed(2)}（相隔 5 分內）；R + S ≈ ${top.toFixed(2)}（相隔最久那一組）→ S ≈ ${Math.max(0, top - R).toFixed(2)}`);
