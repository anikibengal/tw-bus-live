/* 307 末班車即時圖：每 20 秒抓台北市開放資料，追蹤車輛、找出末班車、推估各站末班。
 * 網址參數：?dir=0|1  方向；?sim=HH:MM  把這個時刻當成末班發車時刻（白天測試用）
 */
(function () {
  "use strict";
  const D = window.BUS_ROUTE_DATA, C = window.BusCore;
  const BLOB = "https://tcgbusfs.blob.core.windows.net/blobbus/";
  const POLL_MS = 20e3;
  const PALETTE = { 莒光: "#F5A524", 西藏: "#38BDF8" };
  const EXTRA = ["#A78BFA", "#F472B6", "#4ADE80"];
  const DARK_ROUTE = "#2B3448";
  const params = new URLSearchParams(location.search);
  const SIM = /^\d{1,2}:\d{2}$/.test(params.get("sim") || "") ? params.get("sim") : null;

  const state = { dir: params.get("dir") === "1" ? 1 : 0, viewOffsetMin: 0, eta: null, busUpdate: null,
                  etaUpdate: null, error: null, memos: {}, results: {}, lastPoll: null };
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmt = (ms) => (ms == null || !Number.isFinite(ms) ? "--:--" : C.fmtTime(ms));

  // ---------------------------------------------------------------- 資料整理
  let extraIdx = 0;
  const color = {};
  for (const v of D.variants) color[v.key] = PALETTE[v.label] || (color[v.label] = color[v.label] || EXTRA[extraIdx++ % EXTRA.length]);
  const toward = (v) => (v.subRouteName.split("往")[1] || v.to);
  const dirs = [...new Set(D.variants.map((v) => v.direction))].sort();
  const variantsOf = (d) => D.variants.filter((v) => v.direction === d);
  const routeIds = [...new Set(D.variants.map((v) => v.routeId))];
  const tracker = C.createTracker(D.variants);

  // ---------------------------------------------------------------- 保存（同一營運日內重新整理不丟軌跡）
  const storeKey = () => `bus-last-trip:${D.city}-${D.route}:${C.serviceDay(Date.now()).start}${SIM ? ":sim" + SIM : ""}`;
  function persist() {
    try {
      const buses = [...tracker.buses.values()];
      const bins = {};
      for (const [id, ent] of tracker.byId) bins[id] = ent.bins;
      localStorage.setItem(storeKey(), JSON.stringify({ buses, bins, memos: state.memos }));
    } catch (e) { /* 無痕模式或空間不足：只是不保存 */ }
  }
  function restore() {
    try {
      const raw = localStorage.getItem(storeKey());
      if (!raw) return;
      const s = JSON.parse(raw);
      for (const b of s.buses || []) tracker.buses.set(b.id, b);
      for (const [id, arr] of Object.entries(s.bins || {})) if (tracker.byId.has(id)) tracker.byId.get(id).bins = arr;
      state.memos = s.memos || {};
    } catch (e) { /* 忽略 */ }
  }

  // ---------------------------------------------------------------- 抓資料
  async function getBlob(name) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15e3);
    try {
      const res = await fetch(BLOB + name + ".gz", { cache: "no-store", signal: ctl.signal });
      if (!res.ok) throw new Error(`${name} HTTP ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      let text;
      if (buf[0] === 0x1f && buf[1] === 0x8b) {
        const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
        text = await new Response(stream).text();
      } else text = new TextDecoder().decode(buf);   // 已被瀏覽器自動解壓
      return C.parseBlobJson(text);
    } finally { clearTimeout(timer); }
  }

  async function poll() {
    const [bd, et] = await Promise.allSettled([getBlob("GetBusData"), getBlob("GetEstimateTime")]);
    const errs = [];
    const now = Date.now();
    if (bd.status === "fulfilled") { C.ingestBusData(tracker, bd.value, now); state.busUpdate = C.parseTpe(bd.value.EssentialInfo.UpdateTime); }
    else errs.push("車輛定位：" + bd.reason.message);
    if (et.status === "fulfilled") { state.eta = C.indexEta(et.value, routeIds); state.etaUpdate = state.eta.updateMs; }
    else errs.push("預估到站：" + et.reason.message);
    state.error = errs.length ? errs.join("；") : null;
    state.lastPoll = now;
    compute();
    render();
    persist();
  }

  function compute() {
    const now = Date.now();
    for (const v of D.variants) {
      const last = C.identifyLastBus(tracker, v.subRouteId, now, SIM, state.memos[v.key]);
      state.memos[v.key] = C.updateMemo(state.memos[v.key], last);
      const est = C.estimateStops(tracker, v.subRouteId, last, state.eta, now);
      state.results[v.key] = { v, last, est };
    }
  }

  // ---------------------------------------------------------------- 地圖
  const map = L.map("map", { zoomControl: true, attributionControl: true });
  // OpenStreetMap 標準圖磚（免金鑰），用 CSS 濾鏡轉成夜間色調（見 style.css .night-tiles）
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, className: "night-tiles",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> 貢獻者',
  }).addTo(map);

  const ll = ([lon, lat]) => [lat, lon];
  // 先給地圖視角再加圖層（Leaflet 要有視角才會建立線條元素）
  map.fitBounds(L.latLngBounds(D.variants.flatMap((v) => v.shape.map(ll))), { padding: [30, 30] });
  function pointAtKm(v, k) {
    const km = v.shapeKm, n = km.length;
    if (k <= 0) return v.shape[0];
    if (k >= km[n - 1]) return v.shape[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (km[m] <= k) lo = m; else hi = m; }
    const f = (k - km[lo]) / ((km[hi] - km[lo]) || 1), a = v.shape[lo], b = v.shape[hi];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  }
  function sliceShape(v, k0, k1) {
    k0 = Math.max(0, k0); k1 = Math.min(v.lengthKm, k1);
    if (!(k1 > k0)) return [];
    const out = [pointAtKm(v, k0)];
    for (let i = 0; i < v.shape.length; i++) if (v.shapeKm[i] > k0 && v.shapeKm[i] < k1) out.push(v.shape[i]);
    out.push(pointAtKm(v, k1));
    return out.map(ll);
  }

  const layers = {};
  for (const v of D.variants) {
    layers[v.key] = {
      base: L.polyline(v.shape.map(ll), { color: DARK_ROUTE, weight: 6, opacity: 1, interactive: false }),
      glow: L.polyline([], { color: color[v.key], weight: 12, opacity: 0.18, interactive: false }),
      lit: L.polyline([], { color: color[v.key], weight: 4, opacity: 1, interactive: false }),
      stops: L.layerGroup(),
      buses: L.layerGroup(),
    };
  }
  const groupFor = (d) => variantsOf(d).flatMap((v) => Object.values(layers[v.key]));
  let shownDir = null;
  function showDir(d) {
    if (shownDir === d) return;
    for (const v of D.variants) for (const l of Object.values(layers[v.key])) map.removeLayer(l);
    for (const l of groupFor(d)) l.addTo(map);
    // 亮線在上層
    for (const v of variantsOf(d)) { layers[v.key].glow.bringToFront(); layers[v.key].lit.bringToFront(); }
    shownDir = d;
  }

  const viewTime = () => (state.viewOffsetMin ? (state.lastPoll || Date.now()) + state.viewOffsetMin * 60e3 : Date.now());
  const live = () => state.viewOffsetMin === 0;

  function renderMap() {
    showDir(state.dir);
    const now = Date.now(), T = viewTime();
    for (const v of variantsOf(state.dir)) {
      const R = state.results[v.key];
      const lay = layers[v.key];
      if (!R) continue;
      const front = C.frontKmAt(R.est, R.last, now, T, v.lengthKm);
      const litPts = front === -Infinity ? v.shape.map(ll) : sliceShape(v, front, v.lengthKm);
      lay.lit.setLatLngs(litPts); lay.glow.setLatLngs(litPts);

      lay.stops.clearLayers();
      for (const r of R.est) {
        const dark = front !== -Infinity && r.stop.km <= front + C.P.passTolKm;
        L.circleMarker([r.stop.lat, r.stop.lon], {
          radius: 3.5, weight: 1.5, color: dark ? "#3a4560" : color[v.key], fillColor: dark ? "#1b2335" : "#ffffff", fillOpacity: 1,
        }).bindTooltip(`${esc(r.stop.name)}（${esc(v.label)}）<br>${stopText(r, true)}`, { direction: "top" }).addTo(lay.stops);
      }

      lay.buses.clearLayers();
      if (live()) {
        for (const b of tracker.buses.values()) {
          if (b.subRouteId !== String(v.subRouteId) || now - b.seenMs > 3 * 60e3) continue;
          if (b.id === R.last.bus && (R.last.state === "running" || R.last.state === "boarding")) continue;
          L.circleMarker([b.lat, b.lon], { radius: 4, weight: 1, color: "#fff", fillColor: color[v.key], fillOpacity: b.duty === "1" ? 0.9 : 0.25 })
            .bindTooltip(`${esc(b.id)}（${esc(v.label)}）勤務 ${esc(b.duty)}`, { direction: "top" }).addTo(lay.buses);
        }
      }
      // 末班車：即時看實際位置，未來看推估位置
      let pos = null, pred = false;
      if (live() && (R.last.state === "running" || R.last.state === "boarding")) {
        const b = tracker.buses.get(R.last.bus); pos = b ? [b.lat, b.lon] : null;
      } else if (!live() && front !== -Infinity && front < v.lengthKm && R.last.state !== "finished") {
        pos = ll(pointAtKm(v, front)); pred = true;
      }
      if (pos) {
        L.marker(pos, { icon: L.divIcon({ className: "", html: `<div class="lastbus${pred ? " pred" : ""}" style="--c:${color[v.key]}"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] }), zIndexOffset: 1000 })
          // 兩個變體的末班車常在同一區，標籤一左一右避免重疊
          .bindTooltip(`${esc(v.label)} 末班車${pred ? "（推估位置）" : "・" + esc(R.last.bus)}`, {
            permanent: true, direction: variantsOf(state.dir).indexOf(v) % 2 ? "left" : "right",
            offset: [variantsOf(state.dir).indexOf(v) % 2 ? -10 : 10, 0] })
          .addTo(lay.buses);
      }
    }
  }

  // ---------------------------------------------------------------- 文字
  const SRC_CLASS = { 官方: "official" };
  function stopText(r, plain) {
    if (r.passed) return `<span class="passed">已過</span>${plain ? `（${esc(r.passedBy)}）` : ""}`;
    if (!r.best) return `<span class="passed">無推估</span>`;
    const mins = Math.round((r.best.ms - Date.now()) / 60e3);
    const src = r.best.source;
    const rel = mins < 0 ? "應已到" : mins <= 90 ? `${mins} 分後` : `約 ${Math.round(mins / 60)} 小時後`;
    return `<span class="t">${fmt(r.best.ms)}</span><span class="in">${rel}</span>` +
      `<span class="tag ${SRC_CLASS[src] || ""}">${esc(src)}</span>`;
  }
  function stopTitle(r) {
    const parts = [];
    if (r.official) parts.push("官方預估：" + (r.official.ms != null ? fmt(r.official.ms) : `代碼 ${r.official.code}`));
    if (r.pace) parts.push(`前車段速：${fmt(r.pace.ms)}（涵蓋 ${Math.round(r.pace.coverage * 100)}%）`);
    if (r.avg) parts.push(`${r.avg.src}：${fmt(r.avg.ms)}`);
    return parts.join("\n");
  }
  const STATE_TEXT = { not_departed: "尚未發車", boarding: "停在起點", running: "行駛中", finished: "已收班", unknown: "狀態不明" };
  const CONF_TEXT = { high: ["高", "conf-high"], medium: ["中", "conf-medium"], low: ["低", "conf-low"], schedule: ["依班表", ""] };
  function nearestStopName(v, km) {
    let best = v.stops[0];
    for (const s of v.stops) if (s.km <= km + 0.05) best = s;
    return best.name;
  }

  function renderHeader() {
    const vs = variantsOf(state.dir);
    const sd = C.serviceDay(Date.now());
    const dayName = { sun: "日", mon: "一", tue: "二", wed: "三", thu: "四", fri: "五", sat: "六" }[sd.dayKey];
    $("#routeBadge").textContent = D.route;
    $("#sub").textContent = `今天週${dayName}・末班發車：` + D.variants.filter((v) => v.direction === state.dir)
      .map((v) => `${v.label} ${SIM || v.lastDeparture[sd.dayKey] || "—"}`).join("、") + `・${vs[0].from} → ${vs[0].to}`;
    const tog = $("#dirToggle");
    if (!tog.children.length) {
      for (const d of dirs) {
        const b = document.createElement("button");
        b.type = "button"; b.dataset.dir = d; b.textContent = "往" + toward(variantsOf(d)[0]);
        b.addEventListener("click", () => { state.dir = d; render(); });
        tog.appendChild(b);
      }
    }
    for (const b of tog.children) b.setAttribute("aria-pressed", String(Number(b.dataset.dir) === state.dir));
    const upd = state.busUpdate ? `資料 ${C.fmtTime(state.busUpdate)}:${String(new Date(state.busUpdate).getSeconds()).padStart(2, "0")}` : "等待資料";
    $("#status").innerHTML = (SIM ? `<span class="badge sim">模擬：把 ${esc(SIM)} 當末班時刻</span> ` : "") +
      `${upd}・每 20 秒更新` + (state.error ? `<br><span class="err">抓取失敗（顯示上次資料）：${esc(state.error)}</span>` : "");
  }

  function renderCards() {
    $("#cards").innerHTML = variantsOf(state.dir).map((v) => {
      const R = state.results[v.key];
      if (!R) return "";
      const L0 = R.last, [ct, cc] = CONF_TEXT[L0.confidence] || ["?", ""];
      let detail = `末班 ${fmt(L0.tLast)} 從 ${esc(v.from)} 發車`;
      if (L0.state === "running" || L0.state === "boarding") {
        const b = tracker.buses.get(L0.bus);
        detail = `${esc(L0.bus)}・約在「${esc(nearestStopName(v, L0.km))}」・定位 ${b ? fmt(b.seenMs) : "--:--"}`;
      } else if (L0.state === "finished") detail = `末班已到 ${esc(v.to)}`;
      else if (L0.state === "unknown" && L0.km != null) detail = `最後已知：「${esc(nearestStopName(v, L0.km))}」附近`;
      return `<div class="card vcard">
        <div class="vname"><span class="chip" style="background:${color[v.key]}"></span><span class="vlabel">${esc(v.label)}</span><span class="badge" title="是否確定這台就是末班車">辨識 <b class="${cc}">${ct}</b></span></div>
        <div class="state">${STATE_TEXT[L0.state] || L0.state}</div>
        <div class="detail">${detail}</div>
        ${L0.notes.map((n) => `<div class="note">${esc(n)}</div>`).join("")}
      </div>`;
    }).join("");
  }

  // 合併同方向各變體的站（以實體站位 StationID），依沿線公里排序
  function mergedStops(d) {
    const vs = variantsOf(d), rows = new Map();
    for (const v of vs) {
      const R = state.results[v.key];
      if (!R) continue;
      R.est.forEach((r) => {
        const k = r.stop.station || r.stop.name;
        if (!rows.has(k)) rows.set(k, { name: r.stop.name, km: r.stop.km, lat: r.stop.lat, lon: r.stop.lon, by: {} });
        rows.get(k).by[v.key] = r;
      });
    }
    return { vs, rows: [...rows.values()].sort((a, b) => a.km - b.km) };
  }

  function renderStopList() {
    const { vs, rows } = mergedStops(state.dir);
    const T = viewTime();
    const darkAt = (r) => r.passed || (r.best && r.best.ms <= T);
    $("#stoplist").innerHTML = `<table class="stops"><thead><tr><th>站名</th>${vs.map((v) => `<th style="color:${color[v.key]}">${esc(v.label)}</th>`).join("")}</tr></thead><tbody>` +
      rows.map((row, i) => {
        const served = vs.filter((v) => row.by[v.key]);
        const dark = served.every((v) => darkAt(row.by[v.key]));
        return `<tr class="${dark ? "dark" : ""}" data-i="${i}"><td class="name">${esc(row.name)}</td>` +
          vs.map((v) => { const r = row.by[v.key]; return r ? `<td title="${esc(stopTitle(r))}">${stopText(r)}</td>` : `<td class="passed">不停靠</td>`; }).join("") + "</tr>";
      }).join("") + "</tbody></table>";
    $("#stoplist").querySelectorAll("tr[data-i]").forEach((tr) => tr.addEventListener("click", () => {
      const row = rows[Number(tr.dataset.i)];
      map.setView([row.lat, row.lon], Math.max(map.getZoom(), 16));
    }));
  }

  function renderMarey() {
    const vs = variantsOf(state.dir);
    const now = Date.now(), T = viewTime();
    const t0 = now - 30 * 60e3, t1 = Math.max(now + 120 * 60e3, T + 10 * 60e3);
    const W = 400, H = 250, ml = 72, mr = 8, mt = 8, mb = 22;
    const maxKm = Math.max(...vs.map((v) => v.lengthKm));
    const x = (t) => ml + ((t - t0) / (t1 - t0)) * (W - ml - mr);
    const y = (k) => mt + (k / maxKm) * (H - mt - mb);
    const parts = [`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="時間與距離圖">`];
    // 時間刻度：每 30 分
    const first = Math.ceil(t0 / 1800e3) * 1800e3;
    for (let t = first; t <= t1; t += 1800e3) {
      parts.push(`<line class="axis" x1="${x(t)}" x2="${x(t)}" y1="${mt}" y2="${H - mb}" stroke-opacity=".5"/><text x="${x(t)}" y="${H - 6}" text-anchor="middle">${fmt(t)}</text>`);
    }
    // 站名刻度：起點、終點與三個四分位附近的站
    const v0 = vs[0];
    const picks = [0, 0.25, 0.5, 0.75, 1].map((q) => v0.stops.reduce((a, s) => (Math.abs(s.km - q * v0.lengthKm) < Math.abs(a.km - q * v0.lengthKm) ? s : a)));
    for (const s of picks) {
      const nm = s.name.replace(/\(.*?\)|（.*?）/g, "").slice(0, 6);
      parts.push(`<line class="axis" x1="${ml}" x2="${W - mr}" y1="${y(s.km)}" y2="${y(s.km)}" stroke-opacity=".35"/><text x="${ml - 4}" y="${y(s.km) + 3}" text-anchor="end">${esc(nm)}</text>`);
    }
    // 實際軌跡
    for (const v of vs) {
      const R = state.results[v.key];
      for (const b of tracker.buses.values()) {
        if (b.subRouteId !== String(v.subRouteId)) continue;
        const isLast = R && b.id === R.last.bus;
        let seg = [], prevT = null;
        const flush = () => { if (seg.length > 1) parts.push(`<polyline fill="none" stroke="${color[v.key]}" stroke-width="${isLast ? 2.6 : 1.1}" stroke-opacity="${isLast ? 1 : 0.5}" points="${seg.join(" ")}"/>`); seg = []; };
        for (const p of b.trace) {
          if (p.km == null || p.t < t0) { continue; }
          if (prevT != null && p.t - prevT > 3 * 60e3) flush();
          seg.push(`${x(p.t).toFixed(1)},${y(p.km).toFixed(1)}`); prevT = p.t;
        }
        flush();
      }
      // 末班車推估
      if (R && R.last.state !== "finished") {
        const pts = [];
        if (R.last.state === "running" || R.last.state === "boarding") pts.push([now, R.last.km]);
        else if (R.last.state === "not_departed") pts.push([Math.max(now, R.last.tLast), v.stops[0].km]);
        for (const r of R.est) if (!r.passed && r.best) pts.push([r.best.ms, r.stop.km]);
        pts.sort((a, b) => a[0] - b[0]);
        const vis = pts.filter(([t]) => t <= t1);
        if (vis.length > 1) parts.push(`<polyline fill="none" stroke="${color[v.key]}" stroke-width="2" stroke-dasharray="5 4" points="${vis.map(([t, k]) => `${x(t).toFixed(1)},${y(k).toFixed(1)}`).join(" ")}"/>`);
        if (R.last.tLast >= t0 && R.last.tLast <= t1) parts.push(`<circle cx="${x(R.last.tLast)}" cy="${y(v.stops[0].km)}" r="3" fill="${color[v.key]}"/>`);
      }
    }
    parts.push(`<line class="now" x1="${x(now)}" x2="${x(now)}" y1="${mt}" y2="${H - mb}"/>`);
    if (!live()) parts.push(`<line class="view" x1="${x(T)}" x2="${x(T)}" y1="${mt}" y2="${H - mb}"/>`);
    parts.push("</svg>");
    $("#marey").innerHTML = parts.join("");
  }

  function renderLegend() {
    $("#legend").innerHTML = variantsOf(state.dir).map((v) => `<span><span class="sw" style="background:${color[v.key]}"></span>${esc(v.label)}：還有末班車會經過</span>`).join("") +
      `<span><span class="sw" style="background:${DARK_ROUTE}"></span>末班已過</span>`;
  }

  function renderTimebar() {
    const T = viewTime();
    $("#viewLabel").textContent = live() ? "現在（即時）" : `預測：${state.viewOffsetMin} 分鐘後`;
    $("#viewTime").textContent = fmt(T);
    $("#nowBtn").disabled = live();
  }

  function renderNotes() {
    const v = D.variants;
    const how = [...new Set(v.map((x) => `${x.label}：${x.lastDepartureHow}`))];
    $("#notes").innerHTML = `
      <p><b>推估來源</b>（依優先序）：<span class="tag official">官方</span>台北市預估到站，只在末班車與該站之間沒有其他車時採用・<span class="tag">前車</span>前面車輛剛跑過同一段的實際速度（涵蓋六成以上路段才用）・<span class="tag">均速</span>末班車最近 5 分鐘的平均速度・<span class="tag">預設</span>假設夜間 18 km/h。加「＋班表」表示末班車還沒發車，從末班時刻起算。</p>
      <p><b>尚未驗證</b>：各推估的誤差；預估到站代碼 −3＝「末班車已過」；勤務狀態 2＝「結束營運」。今晚記錄後檢驗。</p>
      <p><b>資料</b>：台北市公車動態資訊（開放資料）・TDX 路線、線型與班表（快取於 ${esc((D.sources.Route || {}).fetched || "")}）。末班時刻：</p>
      <ul>${how.map((h) => `<li>${esc(h)}</li>`).join("")}</ul>`;
  }

  function render() {
    renderHeader(); renderMap(); renderCards(); renderMarey(); renderStopList(); renderLegend(); renderTimebar();
  }

  // ---------------------------------------------------------------- 互動
  $("#slider").addEventListener("input", (e) => { state.viewOffsetMin = Number(e.target.value); renderMap(); renderMarey(); renderStopList(); renderTimebar(); });
  $("#nowBtn").addEventListener("click", () => { state.viewOffsetMin = 0; $("#slider").value = 0; render(); });

  restore();
  compute();
  renderNotes();
  render();
  poll();
  setInterval(poll, POLL_MS);
  setInterval(() => { if (!document.hidden) { compute(); render(); } }, 5e3);
  window.__busApp = { state, tracker, D };   // 除錯用
})();
