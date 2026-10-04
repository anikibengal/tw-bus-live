/* 末班車核心邏輯（純函式，瀏覽器與 Node 共用）。
 *
 * 名詞：
 *   variant  路線變體＋方向（例：307莒光往撫遠街），資料來自 build_static.py
 *   km       沿該變體線型的公里數
 *   時間一律用 epoch 毫秒；台北時間用 UTC+8 換算，不依賴執行環境的時區
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
    endZoneKm: 0.3,                  // 起終點附近的緩衝
    boardingGraceMin: 8,             // 末班發車後幾分鐘內，停在起點的車仍視為末班車
    earlyDepartureMin: 5,            // 比末班時刻早這麼多就離站的車，不是末班車
    staleFixMin: 3,                  // 定位超過幾分鐘沒更新就不採用
    passTolKm: 0.03,                 // 車位超過站點這麼多才算「已過」
    binKm: 0.2,                      // 前車段速的分段長度
    paceFreshMin: 45,                // 前車段速多舊以內才用
    ownSpeedWindowMin: 5,            // 自身均速取最近幾分鐘
    defaultKmh: 18,                  // 沒有任何速度資料時的預設夜間車速（假設值）
    minKmh: 8, maxKmh: 40,
    paceCoverageMin: 0.6,            // 前車段速涵蓋率低於這個就退回均速
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
    const start = Date.UTC(p.y, p.mo, p.d) - TPE_OFFSET_MS;
    return { start, dayKey: DAY_KEYS[p.dow] };
  }
  function hhmmToMin(s) { const [h, m] = s.split(":").map(Number); return h * 60 + m; }
  function fmtTime(ms) { const p = tpeParts(ms); return String(p.h).padStart(2, "0") + ":" + String(p.mi).padStart(2, "0"); }
  /** "2026-10-03 07:46:49" 或 "2026/10/03 07:47:00"（台北時間）→ epoch 毫秒 */
  function parseTpe(s) {
    const m = /^(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s || "");
    if (!m) return NaN;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - TPE_OFFSET_MS;
  }
  /** 這個變體在 nowMs 所屬營運日的末班發車時刻。simLast（"HH:MM"）可覆寫，用於白天測試。 */
  function lastDepartureMs(variant, nowMs, simLast) {
    const sd = serviceDay(nowMs);
    const s = simLast || (variant.lastDeparture || {})[sd.dayKey];
    if (!s) return null;
    return sd.start + hhmmToMin(s) * 60e3;
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
  /** 預估到站 → Map("routeId|goBack|stopId" → {sec 或 code}) */
  function indexEta(blob, routeIds) {
    const want = new Set(routeIds.map(String));
    const map = new Map();
    for (const r of blob.BusInfo || []) {
      if (!want.has(String(r.RouteID))) continue;
      const v = Number(r.EstimateTime);
      map.set(`${r.RouteID}|${r.GoBack}|${r.StopID}`, v);
    }
    return { map, updateMs: parseTpe((blob.EssentialInfo || {}).UpdateTime) };
  }

  // ---------------------------------------------------------------- 車輛追蹤
  /** 跨多次輪詢保存每台車的軌跡與各變體的前車段速。 */
  function createTracker(variants) {
    const byId = new Map();
    for (const v of variants) byId.set(String(v.subRouteId), { v, line: prepLine(v), bins: [] });
    return { byId, buses: new Map() };
  }

  /** 吃一份 GetBusData，更新軌跡。回傳這次新增的定位筆數。 */
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
    // 修剪舊軌跡
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

  function isCandidate(bus, ent, nowMs) {
    const p = bus.trace[bus.trace.length - 1];
    return p && p.km != null && bus.duty === "1" && bus.status !== "99" &&
      nowMs - p.t <= P.staleFixMin * 60e3 && p.km < ent.line.lengthKm - P.endZoneKm;
  }
  function departedAt(bus) {
    // 軌跡中最後一次從起點區（< endZoneKm）離開的時間；軌跡沒涵蓋到就是 null
    for (let i = bus.trace.length - 1; i > 0; i--) {
      const a = bus.trace[i - 1], b = bus.trace[i];
      if (a.km != null && b.km != null && a.km < P.endZoneKm && b.km >= P.endZoneKm) return b.t;
    }
    return null;
  }

  /**
   * 找出這個變體今晚的末班車。
   * state: not_departed | boarding（停在起點）| running | finished | unknown
   *
   * 判斷不明確時，一律選「推估通過時刻較早」的解讀：說得太早頂多讓人多趕一下，說得太晚會讓人錯過車。
   * memo（呼叫端保存）：{busId, maxKm, lastKm}，用來判斷收班與定位中斷。
   */
  function identifyLastBus(tracker, subRouteId, nowMs, simLast, memo) {
    const ent = tracker.byId.get(String(subRouteId));
    const tLast = lastDepartureMs(ent.v, nowMs, simLast);
    const out = { tLast, state: "unknown", bus: null, km: null, confidence: "low", notes: [] };
    if (tLast == null) { out.notes.push("今天沒有末班資料"); return out; }
    if (nowMs < tLast - 60e3) { out.state = "not_departed"; out.km = ent.v.stops[0].km; out.confidence = "schedule"; return out; }

    const cands = [...tracker.buses.values()].filter((b) => b.subRouteId === String(subRouteId) && isCandidate(b, ent, nowMs));
    const at = (b) => b.trace[b.trace.length - 1].km;
    const boarding = cands.filter((b) => at(b) < P.endZoneKm);
    const moving = cands.filter((b) => at(b) >= P.endZoneKm).sort((a, b) => at(a) - at(b));
    const inGrace = nowMs <= tLast + P.boardingGraceMin * 60e3;
    const earliestOk = tLast - P.earlyDepartureMin * 60e3;

    if (moving.length) {
      const b = moving[0];                                   // 最後面那台營運中的車
      const d = departedAt(b);
      // 沒看到離站瞬間時，用「末班時刻後最快能開多遠」判斷它是否可能是末班車
      const plausible = d != null ? d >= earliestOk : at(b) <= ((nowMs - earliestOk) / 3600e3) * P.maxKmh;
      if (!(inGrace && !plausible)) {
        Object.assign(out, { state: "running", bus: b.id, km: at(b) });
        if (d != null && d >= earliestOk) out.confidence = "high";
        else if (d != null) { out.confidence = "low"; out.notes.push(`這台車 ${fmtTime(d)} 就離站，可能不是末班車（末班車定位缺漏）`); }
        else { out.confidence = "medium"; out.notes.push("開頁前就已離站，以最後面的營運車輛推定為末班車"); }
        return out;
      }
      // 寬限期內、最後面那台是更早的班次 → 末班車還在起點
    }
    if (inGrace) {
      if (boarding.length) { Object.assign(out, { state: "boarding", bus: boarding[0].id, km: at(boarding[0]), confidence: "medium" }); return out; }
      out.state = "not_departed"; out.km = ent.v.stops[0].km; out.confidence = "schedule";
      out.notes.push("已到末班時刻，還沒看到末班車離站");
      return out;
    }
    // 路上沒有候選車：看之前認定的末班車
    if (memo && memo.busId) {
      const b = tracker.buses.get(memo.busId);
      const p = b && b.trace[b.trace.length - 1];
      const reachedEnd = p && p.km != null && p.km >= ent.line.lengthKm - P.endZoneKm;
      const switched = b && b.subRouteId !== String(subRouteId);
      const goneNearEnd = (!b || (p && nowMs - p.t > 10 * 60e3)) && memo.maxKm > ent.line.lengthKm - 1;
      if (reachedEnd || switched || goneNearEnd) {
        Object.assign(out, { state: "finished", bus: memo.busId, km: ent.line.lengthKm, confidence: "medium" });
        return out;
      }
      Object.assign(out, { state: "unknown", bus: memo.busId, km: memo.lastKm });
      out.notes.push("末班車定位中斷，顯示最後已知位置");
      return out;
    }
    if (nowMs > tLast + 150 * 60e3) { out.state = "finished"; out.km = ent.line.lengthKm; out.notes.push("已超過末班時刻 150 分鐘且沒有營運車輛"); }
    else out.notes.push("沒有可用的營運車輛定位");
    return out;
  }

  /** 呼叫端每次輪詢後更新 memo。 */
  function updateMemo(memo, last) {
    const m = memo || {};
    if ((last.state === "running" || last.state === "boarding") && last.bus) {
      if (m.busId !== last.bus) { m.busId = last.bus; m.maxKm = -Infinity; }
      m.maxKm = Math.max(m.maxKm, last.km); m.lastKm = last.km;
    }
    return m;
  }

  // ---------------------------------------------------------------- 到站推估
  function ownPace(bus, nowMs) {
    if (!bus) return null;
    const pts = bus.trace.filter((p) => p.km != null);
    const last = pts[pts.length - 1];
    if (!last) return null;
    const ref = pts.filter((p) => last.t - p.t >= P.ownSpeedWindowMin * 60e3).pop();
    if (!ref || last.km - ref.km < 0.3) return null;
    const kmh = (last.km - ref.km) / ((last.t - ref.t) / 3600e3);
    return 60 / Math.min(P.maxKmh, Math.max(P.minKmh, kmh));
  }
  /** 從 k0 走到 k1 要幾分鐘：有新鮮的前車段速就用，沒有的段落用 fallbackPace。 */
  function travelMin(ent, k0, k1, fallbackPace, nowMs) {
    if (k1 <= k0) return { min: 0, coverage: 1 };
    let min = 0, covered = 0;
    for (let b = Math.floor(k0 / P.binKm); b * P.binKm < k1; b++) {
      const s = Math.max(k0, b * P.binKm), e = Math.min(k1, (b + 1) * P.binKm), len = e - s;
      const bin = ent.bins[b];
      if (bin && nowMs - bin.at <= P.paceFreshMin * 60e3) { min += bin.pace * len; covered += len; }
      else min += fallbackPace * len;
    }
    return { min, coverage: covered / (k1 - k0) };
  }

  /**
   * 每站的末班通過狀態與到站推估。
   * 回傳 [{stop, passed, passedBy, official:{ms|code}, pace:{ms,coverage}, avg:{ms}, best:{ms, source}}]
   */
  function estimateStops(tracker, subRouteId, last, eta, nowMs) {
    const ent = tracker.byId.get(String(subRouteId));
    const v = ent.v;
    const bus = last.bus ? tracker.buses.get(last.bus) : null;
    const own = ownPace(bus, nowMs);
    const fallback = own != null ? { pace: own, src: "均速" } : { pace: 60 / P.defaultKmh, src: "預設" };
    // t0/k0：推估的起點時刻與位置；t0 為 null 表示不推估（定位中斷或沒資料）
    let t0 = null, k0 = null;
    if (last.state === "not_departed") { t0 = Math.max(nowMs, last.tLast); k0 = v.stops[0].km; }
    else if (last.state === "boarding") { t0 = Math.max(nowMs, last.tLast); k0 = last.km; }
    else if (last.state === "running") { t0 = bus.trace[bus.trace.length - 1].t; k0 = last.km; }
    else if (last.state === "unknown" && last.km != null) { k0 = last.km; }
    const hasPosition = last.state === "running" || last.state === "boarding" || (last.state === "unknown" && k0 != null);

    // 末班車與某站之間若還有其他營運車輛，官方預估指的就是那台車
    const others = [...tracker.buses.values()].filter((b) => b.subRouteId === String(subRouteId) && b.id !== last.bus && isCandidate(b, ent, nowMs))
      .map((b) => b.trace[b.trace.length - 1].km);

    // 第一輪：各推估方法各自的值（從末班車目前位置起算），保留給畫面與事後驗證
    const rows = v.stops.map((s) => {
      const r = { stop: s, passed: false, passedBy: null, official: null, pace: null, avg: null, best: null };
      const code = eta && eta.map.get(`${v.routeId}|${v.direction}|${s.id}`);
      if (code != null) r.official = code >= 0 ? { ms: eta.updateMs + code * 1000, sec: code } : { code };
      if (last.state === "finished") { r.passed = true; r.passedBy = "收班"; }
      else if (hasPosition && k0 >= s.km + P.passTolKm) { r.passed = true; r.passedBy = "定位"; }
      if (r.official && r.official.code === -3 && !r.passed) { r.passed = true; r.passedBy = "官方-3"; }
      if (r.passed || t0 == null) return r;
      const tp = travelMin(ent, k0, s.km, fallback.pace, nowMs);
      r.pace = { ms: t0 + tp.min * 60e3, coverage: tp.coverage };
      r.avg = { ms: t0 + Math.max(0, s.km - k0) * fallback.pace * 60e3, src: fallback.src };
      return r;
    });
    if (t0 == null) return rows;

    // 第二輪：採用的推估。官方預估只在末班車與該站之間沒有別台車時有效（從末班車往前連續一段）；
    // 之後的站以最後一個有效官方預估為錨點接續推算，避免兩套時間尺度接不起來。時刻沿路線不倒退。
    let anchor = { ms: t0, km: k0, official: false };
    let prevMs = -Infinity;
    for (const r of rows) {
      if (r.passed) continue;
      const s = r.stop;
      const between = others.some((k) => k > k0 && k < s.km);
      const officialValid = r.official && r.official.ms != null && last.state === "running" && !between;
      let best;
      if (officialValid) {
        best = { ms: r.official.ms, source: "官方" };
        anchor = { ms: Math.max(r.official.ms, prevMs), km: s.km, official: true };
      } else {
        // travelMin 本身就是混合值：有前車段速的路段用段速，其餘用均速／預設；標籤依涵蓋率
        const tp = travelMin(ent, anchor.km, s.km, fallback.pace, nowMs);
        const src = tp.coverage >= P.paceCoverageMin ? "前車" : fallback.src;
        best = { ms: anchor.ms + tp.min * 60e3, source: anchor.official ? `官方→${src}` : src };
      }
      best.ms = Math.max(best.ms, prevMs);
      prevMs = best.ms;
      if (last.state === "not_departed" || last.state === "boarding") best.source += "＋班表";
      r.best = best;
    }
    return rows;
  }

  /** 給定時刻 T，末班車（推估）位置的 km。T ≤ 現在用實際位置，之後用各站推估時刻線性內插。 */
  function frontKmAt(stopsEst, last, nowMs, T, lengthKm) {
    if (last.state === "finished") return lengthKm;
    if (last.state === "unknown") return last.km != null ? last.km : -Infinity;
    const pts = [];
    if (last.state === "running" || last.state === "boarding") pts.push([nowMs, last.km]);
    for (const r of stopsEst) if (!r.passed && r.best) pts.push([r.best.ms, r.stop.km]);
    if (!pts.length) return lengthKm;
    pts.sort((a, b) => a[0] - b[0]);
    if (last.state === "not_departed" && T < pts[0][0]) return -Infinity;   // 還沒發車：全線亮
    if (T <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) {
      if (T <= pts[i][0]) { const [ta, ka] = pts[i - 1], [tb, kb] = pts[i]; return ka + (kb - ka) * (T - ta) / ((tb - ta) || 1); }
    }
    return lengthKm;
  }

  return { P, tpeParts, serviceDay, hhmmToMin, fmtTime, parseTpe, lastDepartureMs, prepLine, project,
           parseBlobJson, indexEta, createTracker, ingestBusData, identifyLastBus, updateMemo, estimateStops,
           travelMin, frontKmAt, departedAt };
});
