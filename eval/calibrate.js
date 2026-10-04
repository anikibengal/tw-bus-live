/* 「最早可能到站」的校準：分路線 × 時段（白天／夜間）。
 *
 * 用法：node eval/calibrate.js logs/2026-10-03-day logs/2026-10-03-night [--quantile 0.9] [--tag v3.0] [--dry]
 *   每段記錄先用 eval/replay.js --app --route all 重播出逐筆「預測、實際到站」，再依「路線|時段」分格配適。
 *   寫入 web/data/calibration.js（--dry 只印結果、不寫檔）。
 *
 * 偏移＝該格、該來源、該預測距離下「預測−實際」的高分位數（車比預測早到多少）。
 * 同時做樣本外檢查：每格依時間切兩半，前半配適、後半檢查，結果寫進檔案的 check；正式的偏移用全部資料配適。
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const ROOT = path.resolve(__dirname, "..");
const C = require(path.join(ROOT, "web", "core.js"));

const EDGES = [0, 3, 6, 10, 15, 20, 30, 45, 90];     // 依「預測還有幾分鐘」分組（執行時拿得到的量）
const GROUPS = ["官方", "官方→推算", "推算"];
const MIN_N = 150;                                    // 每個區間至少這麼多筆才自己算分位數
const MIN_CELL = 2000;                                // 一格（路線|時段）少於這麼多筆就不單獨成格，改用該時段合併表

const quantile = (xs, p) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b), i = (s.length - 1) * p, lo = Math.floor(i);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo);
};
const cellKey = (r) => `${r.fam}|${C.periodOf(r.now)}`;

/** 一張校準表：{n, groups: {組: [{h0, h1, offsetMin, n, from}]}}。 */
function fit(rows, q) {
  const pool = {};
  let n = 0;
  for (const r of rows) {
    const g = C.calibGroup(r.source), hp = (r.ms - r.now) / 60e3;
    const bi = EDGES.findIndex((e, i) => i + 1 < EDGES.length && hp >= e && hp < EDGES[i + 1]);
    if (!g || bi < 0) continue;
    n++;
    // 官方以外的兩組樣本少時合併著用
    for (const key of [g, g !== "官方" ? "推算合併" : null]) if (key) ((pool[key] = pool[key] || [])[bi] = pool[key][bi] || []).push(r.err);
  }
  const groups = {};
  for (const g of GROUPS) {
    let prev = -Infinity;
    groups[g] = EDGES.slice(0, -1).map((h0, bi) => {
      let errs = (pool[g] || [])[bi] || [], from = g;
      if (errs.length < MIN_N && g !== "官方") { errs = (pool["推算合併"] || [])[bi] || []; from = "推算合併"; }
      let off = errs.length >= MIN_N ? quantile(errs, q) : prev;      // 樣本不足：沿用前一區間
      if (!Number.isFinite(off)) off = null;
      if (off != null) { off = Math.max(off, prev); prev = off; }      // 偏移不隨預測距離縮小
      return { h0, h1: EDGES[bi + 1], offsetMin: off == null ? null : Number(off.toFixed(2)), n: errs.length, from };
    });
  }
  return { n, groups };
}

/** 整份校準：各格一張表，另有各時段合併表給沒有自己那一格的路線用。 */
function build(rows, q) {
  const byCell = {}, byPeriod = {};
  for (const r of rows) {
    (byCell[cellKey(r)] = byCell[cellKey(r)] || []).push(r);
    const p = C.periodOf(r.now);
    (byPeriod[p] = byPeriod[p] || []).push(r);
  }
  const cells = {}, fallback = {};
  for (const [k, rs] of Object.entries(byCell)) if (rs.length >= MIN_CELL) cells[k] = fit(rs, q);
  for (const [p, rs] of Object.entries(byPeriod)) fallback[p] = fit(rs, q);
  return { cells, fallback };
}

/** 「車比畫面上的最早時間還早到」的比例；沒給最早時間時以預測時刻算。lead＝最早時間平均比預測提前幾分。 */
function check(rows, calib) {
  let n = 0, miss = 0, lead = 0;
  for (const r of rows) {
    if (!C.calibGroup(r.source)) continue;
    const e = C.earliestMs({ ms: r.ms, source: r.source }, r.now, C.calibFor(calib, r.fam, r.now));
    const shown = e != null ? e : r.ms;
    n++;
    if (r.act < shown - 1000) miss++;
    lead += (r.ms - shown) / 60e3;
  }
  return { n, miss: n ? miss / n : NaN, lead: n ? lead / n : NaN };
}

/** 每格依預測時刻的中位數切兩半（前半配適、後半檢查）。 */
function splitHalves(rows) {
  const byCell = {};
  for (const r of rows) (byCell[cellKey(r)] = byCell[cellKey(r)] || []).push(r);
  const train = [], test = [];
  for (const rs of Object.values(byCell)) {
    const mid = quantile(rs.map((r) => r.now), 0.5);
    for (const r of rs) (r.now < mid ? train : test).push(r);
  }
  return { train, test };
}

/** 樣本外檢查：前半配適、後半逐格檢查。 */
function outOfSample(rows, q) {
  const { train, test } = splitHalves(rows);
  const calib = build(train, q);
  const cells = {};
  for (const k of [...new Set(test.map(cellKey))].sort()) cells[k] = check(test.filter((r) => cellKey(r) === k), calib);
  return { trainN: train.length, testN: test.length, cells, all: check(test, calib) };
}

function replayRows(dir, tag) {
  const tmp = path.join(os.tmpdir(), `bus-calib-${process.pid}-${path.basename(dir)}.json`);
  try {
    execFileSync(process.execPath, [path.join(__dirname, "replay.js"), dir, "--app", "--route", "all", "--tag", `calib-${tag}`, "--dump", tmp],
      { stdio: ["ignore", "ignore", "inherit"] });
    return JSON.parse(fs.readFileSync(tmp, "utf8"));
  } finally { fs.rmSync(tmp, { force: true }); }
}

function main() {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : d; };
  const dirs = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && ["--quantile", "--tag"].includes(args[i - 1])));
  if (!dirs.length) { console.error("用法：node eval/calibrate.js logs/<記錄> [logs/<記錄> ...] [--quantile 0.9] [--tag v3.0] [--dry]"); process.exit(1); }
  const q = Number(opt("quantile", "0.9")), tag = opt("tag", "core");
  const rows = dirs.flatMap((d) => replayRows(d, tag));
  if (rows.some((r) => !r.fam)) { console.error("逐筆明細沒有路線欄位（fam），eval/replay.js 版本不符"); process.exit(1); }

  const calib = build(rows, q), oos = outOfSample(rows, q);
  const pct = (x) => (x * 100).toFixed(1) + "%";
  console.log(`共 ${rows.length} 筆可對照預測（${dirs.map((d) => path.basename(d)).join("、")}），分位數 ${q}`);
  console.log(`\n樣本外檢查（每格前半配適 ${oos.trainN} 筆、後半檢查 ${oos.testN} 筆）：車比最早時間還早到的比例，目標 ${pct(1 - q)}`);
  for (const [k, c] of Object.entries(oos.cells)) console.log(`  ${k.padEnd(12)} ${pct(c.miss).padStart(6)}　${c.n} 筆　最早時間平均比預測提前 ${c.lead.toFixed(1)} 分`);
  console.log(`  ${"全部".padEnd(10)} ${pct(oos.all.miss).padStart(6)}　${oos.all.n} 筆`);
  console.log(`\n全部資料配適（正式用）：樣本內 ${pct(check(rows, calib).miss)}`);
  for (const [k, t] of Object.entries({ ...calib.cells, ...Object.fromEntries(Object.entries(calib.fallback).map(([p, t]) => [`（合併）${p}`, t])) })) {
    console.log(`  ${k}（${t.n} 筆）`);
    for (const g of GROUPS) console.log(`    ${g.padEnd(7)} ` + t.groups[g].map((b) => `${b.h0}-${b.h1}:${b.offsetMin == null ? "-" : b.offsetMin.toFixed(1)}`).join("  "));
  }
  const out = {
    schema: 2, generated: new Date().toISOString(), core: tag, quantile: q, minN: MIN_N,
    data: dirs.map((d) => path.basename(d)), periods: { dayStartH: C.P.dayStartH, dayEndH: C.P.dayEndH },
    cells: calib.cells, fallback: calib.fallback,
    check: { method: "每格依時間切兩半，前半配適、後半檢查", target: Number((1 - q).toFixed(3)),
             cells: Object.fromEntries(Object.entries(oos.cells).map(([k, c]) => [k, { n: c.n, miss: Number(c.miss.toFixed(4)), leadMin: Number(c.lead.toFixed(2)) }])),
             all: { n: oos.all.n, miss: Number(oos.all.miss.toFixed(4)) } },
  };
  if (args.includes("--dry")) { console.log("\n--dry：沒有寫檔"); return; }
  const file = path.join(ROOT, "web", "data", "calibration.js");
  fs.writeFileSync(file, `window.BUS_CALIBRATION = ${JSON.stringify(out)};\n`);
  console.log(`\n寫入 ${path.relative(ROOT, file)}`);
}

module.exports = { fit, build, check, splitHalves, outOfSample, EDGES, GROUPS, MIN_N, MIN_CELL };
if (require.main === module) main();
