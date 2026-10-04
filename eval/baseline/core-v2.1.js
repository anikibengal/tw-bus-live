/* 即時公車路線圖核心邏輯（純函式，瀏覽器與 Node 共用）。
 *
 * 名詞：
 *   variant  路線變體＋方向（例：307莒光往撫遠街），資料來自 build_static.py
 *   km       沿該變體線型的公里數
 *   時間一律用 epoch 毫秒；台北時間用 UTC+8 換算，不依賴執行環境的時區
 *
 * 官方預估到站每站只報「最近那一班」且不說是哪台車。這裡把它對到「該站後方最近的那台車」，
 * 其餘的車（第二班以後）以官方預估為錨點、用前車實際段速接續推算。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.BusCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const TPE_OFFSET_MS = 8 * 3600e3;
  const ROLLOVER_H = 3;              // 03:00 前算前一個營運日
  const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const P = {
    maxOffsetM: 150,                 // 離線型超過就不採用這筆定位
    endZoneKm: 0.1,                  // 已到終點的車不再列為「要到站」
    staleFixMin: 3,                  // 定位超過幾分鐘沒更新就不採用
    passTolKm: 0.03,                 // 車位超過站點這麼多才算「已過站」
    binKm: 0.2,                      // 前車段速的分段長度
    paceFreshMin: 45,                // 前車段速多舊以內才用
    ownSpeedWindowMin: 5,            // 自身均速取最近幾分鐘
    defaultKmh: 18,                  // 沒有任何速度資料時的預設車速（假設值）
    minKmh: 8, maxKmh: 40,
    paceCoverageMin: 0.6,            // 前車段速涵蓋率低於這個就標成均速／預設
    physMaxKmh: 50,                  // 官方預估若比這個速度還快才做得到，就判定指的是別台車
    horizonMin: 90,                  // 只推算到這麼遠的未來
    originKm: 0.5,                   // 起點附近：有車停在這裡就不再用班表補同一班
    originMatchMin: 12,              // 起點附近的車對到 ±12 分內最近的班表發車時刻
    traceKeepMin: 180,
  };

  // ---------------------------------------------------------------- 時間
  function tpeParts(ms) {
    const d = new Date(ms + TPE_OFFSET_MS);
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(),
             h: d.getUTCHours(), mi: d.getUTCMinutes(), dow: d.getUTCDay() };
  }
  /** 營運日 00:00（台北）的 epoch 毫秒與星期鍵。03:00 前算前一天。 */
  function serviceDay(ms) {
    const p = tpeParts(ms - ROLLOVER_H * 3600e3);
    return { start: Date.UTC(p.y, p.mo, p.d) - TPE_OFFSET_MS, dayKey: DAY_KEYS[p.dow] };
  }
  function hhmmToMin(s) { const [h, m] = s.split(":").map(Number); return h * 60 + m; }
  function fmtTime(ms) { const p = tpeParts(ms); return String(p.h).padStart(2, "0") + ":" + String(p.mi).padStart(2, "0"); }
  /** "2026-10-03 07:46:49" 或 "2026/10/03 07:47:00"（台北時間）→ epoch 毫秒 */
  function parseTpe(s) {
    const m = /^(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s || "");
    if (!m) return NaN;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - TPE_OFFSET_MS;
  }

  // ---------------------------------------------------------------- 幾何
  function prepLine(variant) {
    const [lon0, lat0] = variant.shape[0];
    const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
    const pts = variant.shape.map(([lon, lat]) => [(lon - lon0) * kx, (lat - lat0) * ky]);
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    return { lon0, lat0, kx, ky, pts, cumM: cum, lengthKm: cum[cum.length - 1] / 1000 };
  }
  /** 投影到 [kmMin, kmMax] 內最近的位置；視窗內沒有線段就退回全線。 */
  function project(line, lon, lat, kmMin, kmMax) {
    const px = (lon - line.lon0) * line.kx, py = (lat - line.lat0) * line.ky;
    const lo = kmMin == null ? -Infinity : kmMin * 1000, hi = kmMax == null ? Infinity : kmMax * 1000;
    let best = null;
    for (let i = 0; i < line.pts.length - 1; i++) {
      const a0 = line.cumM[i], a1 = line.cumM[i + 1];
      if (a1 < lo || a0 > hi) continue;
      const [x1, y1] = line.pts[i], [x2, y2] = line.pts[i + 1];
      const dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy;
      let t = L2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / L2;
      t = Math.min(1, Math.max(0, t));
      let along = a0 + t * (a1 - a0);
      if (along < lo || along > hi) { along = Math.min(hi, Math.max(lo, along)); t = a1 === a0 ? 0 : (along - a0) / (a1 - a0); }
      const d = Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
      if (!best || d < best.offsetM) best = { km: along / 1000, offsetM: d };
    }
    return best || project(line, lon, lat);
  }

  // ---------------------------------------------------------------- 開放資料解析
  function parseBlobJson(text) {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  }
  /** 預估到站 → Map("routeId|goBack|stopId" → 秒數或負的代碼) */
  function indexEta(blob, routeIds) {
    const want = new Set(routeIds.map(String));
    const map = new Map();
    for (const r of blob.BusInfo || []) {
      if (!want.has(String(r.RouteID))) continue;
      map.set(`${r.RouteID}|${r.GoBack}|${r.StopID}`, Number(r.EstimateTime));
    }
    return { map, updateMs: parseTpe((blob.EssentialInfo || {}).UpdateTime) };
  }

  // ---------------------------------------------------------------- 車輛追蹤
  function createTracker(variants) {
    const byId = new Map();
    for (const v of variants) byId.set(String(v.subRouteId), { v, line: prepLine(v), bins: [], shared: [] });
    // 同方向的其他變體：記下共用路段，前車段速可以互相借用
    for (const a of byId.values()) for (const b of byId.values()) {
      if (a === b || a.v.direction !== b.v.direction) continue;
      const segs = sharedSegments(a.v, b.v);
      if (segs.length) a.shared.push({ ent: b, segs });
    }
    return { byId, buses: new Map() };
  }

  /**
   * 兩個變體的共用路段：在兩邊都是「連續的兩站」、且這段長度相差 10%（或 50 m）以內。
   * 兩站之間若有任一邊多停別的站、或長度差太多（可能走不同街道），就不算共用。
   * 回傳 [{v0, v1, w0, w1}]：本變體的公里區間與對方的公里區間。
   */
  function sharedSegments(V, W) {
    const key = (s) => s.station || s.name;
    const posW = new Map(W.stops.map((s, i) => [key(s), i]));
    const segs = [];
    for (let i = 0; i + 1 < V.stops.length; i++) {
      const a = V.stops[i], b = V.stops[i + 1];
      const wi = posW.get(key(a)), wj = posW.get(key(b));
      if (wi == null || wj == null || wj !== wi + 1) continue;
      const lenV = b.km - a.km, lenW = W.stops[wj].km - W.stops[wi].km;
      if (lenV <= 0 || lenW <= 0) continue;
      if (Math.abs(lenV - lenW) > Math.max(0.05, 0.1 * Math.max(lenV, lenW))) continue;
      segs.push({ v0: a.km, v1: b.km, w0: W.stops[wi].km, w1: W.stops[wj].km });
    }
    return segs;
  }
  function mapKm(segs, k) {
    for (const s of segs) if (k >= s.v0 && k <= s.v1) return { km: s.w0 + (k - s.v0) * (s.w1 - s.w0) / (s.v1 - s.v0), ratio: (s.w1 - s.w0) / (s.v1 - s.v0) };
    return null;
  }

  /** 吃一份 GetBusData，更新軌跡與前車段速。回傳這次新增的定位筆數。 */
  function ingestBusData(tracker, blob, nowMs) {
    let added = 0;
    for (const r of blob.BusInfo || []) {
      const ent = tracker.byId.get(String(r.RouteID));
      if (!ent) continue;
      const t = parseTpe(r.DataTime);
      if (!Number.isFinite(t)) continue;
      const id = r.BusID;
      let bus = tracker.buses.get(id);
      if (!bus || bus.subRouteId !== String(r.RouteID)) {
        bus = { id, subRouteId: String(r.RouteID), trace: [] };     // 換了子路線就重起一條軌跡
        tracker.buses.set(id, bus);
      }
      const last = bus.trace[bus.trace.length - 1];
      bus.duty = String(r.DutyStatus); bus.status = String(r.BusStatus); bus.goBack = String(r.GoBack);
      bus.speed = Number(r.Speed); bus.lon = Number(r.Longitude); bus.lat = Number(r.Latitude); bus.seenMs = t;
      if (last && last.t >= t) continue;
      const lastKm = last && last.km != null ? last.km : null;
      let pr;
      if (lastKm == null) pr = project(ent.line, bus.lon, bus.lat);
      else {
        // 視窗依經過時間放寬（約 42 km/h），中間斷線很久也不會把車丟掉；視窗內找不到再全線找
        const reach = Math.max(1, ((t - last.t) / 60e3) * 0.7 + 0.5);
        pr = project(ent.line, bus.lon, bus.lat, lastKm - 0.3, lastKm + reach);
        if (pr.offsetM > P.maxOffsetM) pr = project(ent.line, bus.lon, bus.lat);
      }
      const km = pr.offsetM <= P.maxOffsetM ? pr.km : null;
      bus.trace.push({ t, km, offsetM: pr.offsetM, duty: bus.duty });
      added++;
      if (lastKm != null && km != null && bus.duty === "1") recordPace(ent, lastKm, last.t, km, t);
    }
    const cut = nowMs - P.traceKeepMin * 60e3;
    for (const [id, bus] of tracker.buses) {
      bus.trace = bus.trace.filter((p) => p.t >= cut);
      if (!bus.trace.length) tracker.buses.delete(id);
    }
    return added;
  }

  function recordPace(ent, k1, t1, k2, t2) {
    const dk = k2 - k1, dtMin = (t2 - t1) / 60e3;
    if (dk <= 0.02 || dtMin <= 0 || dtMin > 4 || dk > 3) return;
    const pace = dtMin / dk;                                   // 分鐘/公里
    for (let b = Math.floor(k1 / P.binKm); b * P.binKm < k2; b++) ent.bins[b] = { pace, at: t2 };
  }

  /** 營運中、定位新鮮、在路線上、還沒到終點的車。 */
  function activeBuses(tracker, subRouteId, nowMs) {
    const ent = tracker.byId.get(String(subRouteId));
    const out = [];
    for (const b of tracker.buses.values()) {
      if (b.subRouteId !== String(subRouteId)) continue;
      const p = b.trace[b.trace.length - 1];
      if (!p || p.km == null || b.duty !== "1" || b.status === "99") continue;
      if (nowMs - p.t > P.staleFixMin * 60e3) continue;
      if (p.km >= ent.line.lengthKm - P.endZoneKm) continue;
      out.push({ id: b.id, km: p.km, t: p.t, lat: b.lat, lon: b.lon });
    }
    return out.sort((a, b) => b.km - a.km);                  // 前面的車在前
  }

  // ---------------------------------------------------------------- 推估
  function ownPace(bus) {
    if (!bus) return null;
    const pts = bus.trace.filter((p) => p.km != null);
    const last = pts[pts.length - 1];
    if (!last) return null;
    const ref = pts.filter((p) => last.t - p.t >= P.ownSpeedWindowMin * 60e3).pop();
    if (!ref || last.km - ref.km < 0.3) return null;
    const kmh = (last.km - ref.km) / ((last.t - ref.t) / 3600e3);
    return 60 / Math.min(P.maxKmh, Math.max(P.minKmh, kmh));
  }
  /**
   * 從 k0 走到 k1 要幾分鐘：有新鮮前車段速的分段用段速，其餘用 fallbackPace。
   * 共用路段上，本變體與同方向其他變體的段速取「最新的那筆」（例：西藏車少，借用莒光剛跑過的速度）。
   * 回傳 coverage（有段速的比例）與 borrowed（其中借自其他變體的比例）。
   */
  function travelMin(ent, k0, k1, fallbackPace, nowMs) {
    if (k1 <= k0) return { min: 0, coverage: 1, borrowed: 0 };
    const fresh = (x) => x && nowMs - x.at <= P.paceFreshMin * 60e3;
    let min = 0, covered = 0, borrowed = 0;
    for (let b = Math.floor(k0 / P.binKm); b * P.binKm < k1; b++) {
      const s = Math.max(k0, b * P.binKm), e = Math.min(k1, (b + 1) * P.binKm), len = e - s;
      let best = fresh(ent.bins[b]) ? { pace: ent.bins[b].pace, at: ent.bins[b].at, own: true } : null;
      for (const sh of ent.shared || []) {
        const m = mapKm(sh.segs, (s + e) / 2);
        if (!m) continue;
        const ob = sh.ent.bins[Math.floor(m.km / P.binKm)];
        if (fresh(ob) && (!best || ob.at > best.at)) best = { pace: ob.pace * m.ratio, at: ob.at, own: false };
      }
      if (best) { min += best.pace * len; covered += len; if (!best.own) borrowed += len; }
      else min += fallbackPace * len;
    }
    return { min, coverage: covered / (k1 - k0), borrowed: borrowed / (k1 - k0) };
  }

  /** 目前時段的班距（只有班距表的路線）。 */
  function headwayNow(variant, nowMs) {
    const s = variant.schedule;
    if (!s || s.type !== "frequency") return null;
    const sd = serviceDay(nowMs), m = (nowMs - sd.start) / 60e3;
    const w = s.windows.find((x) => x.days.includes(sd.dayKey) && hhmmToMin(x.start) <= m && m < hhmmToMin(x.end));
    return w ? { min: w.minHeadway, max: w.maxHeadway } : null;
  }
  /** 今天起點的所有發車時刻（只有逐班表的路線）。 */
  function departuresToday(variant, nowMs) {
    const s = variant.schedule;
    if (!s || s.type !== "timetable") return [];
    const sd = serviceDay(nowMs);
    return (s.byDay[sd.dayKey] || []).map((x) => sd.start + hhmmToMin(x) * 60e3);
  }
  /** 起點在 nowMs 之後的發車時刻。 */
  function upcomingDepartures(variant, nowMs, n) {
    return departuresToday(variant, nowMs).filter((t) => t > nowMs).slice(0, n);
  }

  /**
   * 一個變體所有車的到站推估。
   * 回傳 { active, perStop: [[{bus, ms, source}...] 依時刻排序], headway }
   *   bus 為 null 表示官方預估指的車我們沒追蹤到，或是班表上還沒發車的車
   */
  function routeArrivals(tracker, subRouteId, eta, nowMs) {
    const ent = tracker.byId.get(String(subRouteId));
    const v = ent.v, stops = v.stops;
    const active = activeBuses(tracker, subRouteId, nowMs);
    const perStop = stops.map(() => []);
    const officialUsed = stops.map(() => false);
    const officialAt = (s) => {
      const x = eta && eta.map.get(`${v.routeId}|${v.direction}|${s.id}`);
      return x != null && x >= 0 ? eta.updateMs + x * 1000 : null;
    };
    const horizon = nowMs + P.horizonMin * 60e3;
    const minPace = 60 / P.physMaxKmh;

    active.forEach((b, i) => {
      const kAhead = i > 0 ? active[i - 1].km : Infinity;    // 前一台車的位置
      const own = ownPace(tracker.buses.get(b.id));
      const fb = own != null ? { pace: own, src: "均速" } : { pace: 60 / P.defaultKmh, src: "預設" };
      let anchor = { ms: b.t, km: b.km, official: false }, prev = -Infinity;
      for (let si = 0; si < stops.length; si++) {
        const s = stops[si];
        if (s.km < b.km + P.passTolKm) continue;             // 已過站
        // 這台車是該站後方最近的車 → 官方預估指的就是它；但要過物理檢查
        const off = s.km <= kAhead - P.passTolKm ? officialAt(s) : null;
        const possible = off != null && off >= b.t + (s.km - b.km) * minPace * 60e3 - 60e3;
        let ms, source;
        if (off != null && possible) {
          ms = off; source = "官方"; officialUsed[si] = true;
          anchor = { ms: Math.max(off, prev), km: s.km, official: true };
        } else {
          const tp = travelMin(ent, anchor.km, s.km, fb.pace, nowMs);
          const src = tp.coverage >= P.paceCoverageMin ? "前車" : fb.src;
          ms = anchor.ms + tp.min * 60e3;
          source = anchor.official ? `官方→${src}` : src;
        }
        ms = Math.max(ms, prev); prev = ms;
        if (ms > horizon) break;
        perStop[si].push({ bus: b.id, ms, source });
      }
    });

    // 官方有預估、但該站後方沒有任何追蹤中的車 → 指的是沒定位到或還沒發車的車
    const rear = active.length ? active[active.length - 1].km : Infinity;
    stops.forEach((s, si) => {
      const off = officialAt(s);
      if (off != null && !officialUsed[si] && s.km < rear - P.passTolKm && off <= horizon) perStop[si].push({ bus: null, ms: off, source: "官方・未定位" });
    });

    // 逐班表路線：不足兩班的站用起點班表補。起點附近的車對到離它最近的發車時刻（已過或未來皆可），
    // 那一班就由這台車代表，不重複列（剛離站的車對到剛過的班次，不會吃掉下一班）
    const all = departuresToday(v, nowMs), used = new Set();
    for (const b of active) {
      if (b.km >= P.originKm || !all.length) continue;
      const near = all.reduce((x, y) => (Math.abs(y - nowMs) < Math.abs(x - nowMs) ? y : x));
      if (Math.abs(near - nowMs) <= P.originMatchMin * 60e3) used.add(near);
    }
    const deps = all.filter((t) => t > nowMs && !used.has(t)).slice(0, 3);
    const fbPace = 60 / P.defaultKmh;
    stops.forEach((s, si) => {
      if (perStop[si].length >= 2) return;
      for (const d of deps) {
        if (perStop[si].length >= 2) break;
        const ms = d + travelMin(ent, stops[0].km, s.km, fbPace, nowMs).min * 60e3;
        if (ms > horizon) break;
        if (perStop[si].some((x) => Math.abs(x.ms - ms) < 3 * 60e3)) continue;   // 已有接近的班次（多半是同一班）
        perStop[si].push({ bus: null, ms, source: "班表" });
      }
    });

    // 只有班距的路線：不足兩班的站補一筆「依班距」——下一班最晚在班距上限內從起點發車，再加上開到這站的時間
    const hw = headwayNow(v, nowMs);
    if (hw && hw.max) {
      stops.forEach((s, si) => {
        if (perStop[si].length >= 2) return;
        const bound = nowMs + (hw.max + travelMin(ent, stops[0].km, s.km, fbPace, nowMs).min) * 60e3;
        const lastMs = perStop[si].length ? perStop[si][perStop[si].length - 1].ms : -Infinity;
        perStop[si].push({ bus: null, ms: Math.max(bound, lastMs + hw.min * 60e3), source: "班距", upper: true });
      });
    }

    for (const list of perStop) list.sort((a, b) => a.ms - b.ms);
    return { active, perStop, headway: headwayNow(v, nowMs) };
  }

  /**
   * 同方向各變體的站合併成一條（以實體站位 StationID 對齊）。
   * 只有某變體停的站，插在它前一個已排入的站之後，所以分岔路段的順序依站序、不比公里數（各變體公里數基準不同）。
   * 回傳 [{key, name, lat, lon, by: {variantKey: 站序索引}}]
   */
  function mergeStops(variants) {
    const rows = [], index = new Map();
    variants.forEach((v, vi) => {
      let ptr = -1;
      v.stops.forEach((s, si) => {
        const k = s.station || s.name;
        let row = index.get(k);
        if (row && row.by[v.key] == null) {
          row.by[v.key] = si;
          ptr = rows.indexOf(row);
        } else {
          row = { key: k, name: s.name, lat: s.lat, lon: s.lon, by: { [v.key]: si } };
          if (vi === 0) rows.push(row); else rows.splice(ptr + 1, 0, row);
          ptr = rows.indexOf(row);
          if (!index.has(k)) index.set(k, row);
        }
      });
    });
    return rows;
  }

  return { P, tpeParts, serviceDay, hhmmToMin, fmtTime, parseTpe, prepLine, project, parseBlobJson, indexEta,
           createTracker, sharedSegments, ingestBusData, activeBuses, travelMin, headwayNow, departuresToday, upcomingDepartures, routeArrivals, mergeStops };
});
