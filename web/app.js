/* 公車即時：常用站的到站看板（等車）＋即時地圖＋找公車＋路線條狀圖＋時距圖。
 * 資料：瀏覽器直接抓台北市與新北市的開放資料（車輛每 10 秒、預估到站每 20 秒）。
 *   data/app-data.js       內建路線與常用地點
 *   data/routes/*.json     其他路線：使用者在某個地點關注它時才載入（不用重新整理頁面）
 *   data/city-index.json   全市路線與站牌索引：站牌上有哪些路線、站牌的行車方位、搜尋、附近的站
 * 關注的單位是（地點、路線、方向）：每個地點各自記要看哪些路線往哪個方向，等車頁與地圖只列那幾條。
 * 一個地點的站牌分成幾個「候車位置」（馬路的這一側、那一側、第幾月台）；等車頁一次看一個位置，每個地點記住上次看的是哪一個。
 * 網址參數：?tab=wait|map|find|route|marey  初始分頁（手機預設等車、桌機預設地圖；時距圖沒有自己的分頁，從「路線」點進去）
 *
 * 每台車各一列、前方路況只講一次、資料年齡、暫停更新，這些做法來自 tw-bus。
 */
function startApp() {
  "use strict";
  const A = window.BUS_APP_DATA, C = window.BusCore;
  const CAL = window.BUS_CALIBRATION || null;          // 「最早可能」的偏移；沒有校準檔就不顯示
  // 「最早」有多可靠：用校準檔裡的樣本外檢查結果說話（各路線時段中最差到最好），不寫死
  const CAL_COVER = (() => {
    const cs = CAL && CAL.check && CAL.check.cells ? Object.values(CAL.check.cells).map((c) => Math.round((1 - c.miss) * 100)) : [];
    if (!cs.length) return "多數";
    const lo = Math.min(...cs), hi = Math.max(...cs);
    return lo === hi ? `約 ${lo}%` : `約 ${lo}–${hi}%`;
  })();
  // 即時資料來源：台北市與新北市放在同一個主機的不同資料夾，格式相同、編號互不重複
  const SOURCES = A.sources || { tpe: { name: "台北市", base: "https://tcgbusfs.blob.core.windows.net/blobbus/" } };
  const BUS_MS = 10e3, ETA_MS = 20e3;
  // 路線的顏色。紅色留給「快到了／現在出門」，路線不用紅。內建三條：黃、珊瑚、天藍（珊瑚和紅在地圖上太像，所以第三條用冷色）。
  // 其他路線照 EXTRA 的順序挑：這十三個顏色是算過的（CIEDE2000：前八個彼此差 22 以上、前十個 19 以上、十三個 15 以上；
  // 牌子上的深色字對比都在 5 以上）。分得清楚的顏色就十個左右，再多只能靠路線號碼分。
  const PALETTE = { "307": "#FFD253", "307西藏三民": "#FF8461", "265區": "#47B4EB" };
  const EXTRA = ["#DD47EB", "#47EBB4", "#E0A3BD", "#B4EB47", "#7881E2", "#91EBF3", "#E0BDA3", "#C29AEA", "#EB9947", "#E0E0A3"];
  const TABS = ["wait", "map", "find", "route", "marey"];
  const WALK_M_PER_MIN = 75, WALK_DETOUR = 1.3;        // 步行 4.5 km/h；直線距離乘 1.3 當實際路程
  const NEARBY_M = 500, NEARBY_N = 8;                  // 「附近的站牌」列出多遠以內、最多幾個站名
  const PLACE_NEAR_M = 150;                            // 定位後離常用站這麼近就直接切過去
  const FAR_M = 1500;                                  // 離正在看的站這麼遠：出門提醒沒有意義，改提示去看附近的站牌
  const REDUCED_MOTION = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const NARROW = window.matchMedia && window.matchMedia("(max-width: 700px)").matches;
  const params = new URLSearchParams(location.search);
  // 重播模式：?replay=2026-10-03-day&at=0940&speed=1。用記錄器存下的快照當資料來源，時鐘撥回當時（收班後也能測試與展示）
  const REPLAY = params.get("replay");
  const clock = { base: null, t0: 0, speed: Math.max(1, Number(params.get("speed")) || 1) };
  const nowMs = () => (clock.base == null ? Date.now() : clock.base + (Date.now() - clock.t0) * clock.speed);
  let replay = null;
  const $ = (s) => document.querySelector(s);
  /** 換掉一塊的內容；和上次一樣就不動（每幾秒重算一次，手指正按著的按鈕被換掉的話那一下就按空了）。 */
  const setHTML = (sel, html) => { const el = $(sel); if (el.__html !== html) { el.innerHTML = html; el.__html = html; } };
  // 動態：只在「畫面剛變了」的時候動一下，讓人看得出變了什麼。系統設成減少動態效果、或頁面不在前景時都不動。
  const canMove = () => !REDUCED_MOTION && !document.hidden && typeof Element.prototype.animate === "function";
  const EASE = "cubic-bezier(.2, .8, .2, 1)";
  const motion = { slides: 0, flips: 0, fades: 0 };      // 各做了幾次（除錯用）
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmt = (ms) => (ms == null || !Number.isFinite(ms) ? "--:--" : C.fmtTime(ms));
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 無痕模式或空間不足：只是不保存 */ } },
  };
  const BUS_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h14a2 2 0 0 1 2 2v11a2 2 0 0 1-1 1.7V20a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1v-1H7v1a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-2.3A2 2 0 0 1 3 16V5a2 2 0 0 1 2-2Zm0 3v5h14V6H5Zm2 8.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm10 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z"/></svg>';
  const LOC_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3"/><circle cx="12" cy="12" r="7.5" fill="none"/></svg>';

  const state = {
    tab: TABS.includes(params.get("tab")) ? params.get("tab") : (NARROW ? "wait" : "map"),
    place: ls.get("bus:placeId", null), temp: ls.get("bus:temp", null),      // temp＝臨時查看、還沒存起來的站名
    group: null, openStation: null, selBus: null, eta: null, etaBy: {}, busUpdate: null, results: {},
    me: null, geoNote: "", cityNote: "", q: "", routePage: null,
    openRow: null, filter: "", sheetOpen: false, pick: false, posMenu: false,
  };

  // ---------------------------------------------------------------- 資料整理（路線可以在執行中加進來）
  const V = [], byKey = new Map();
  const colorOf = {}, color = {};
  let colorMemo = ls.get("bus:color", {});              // 單位 → { 顯示名稱: 顏色 }：每條路線上次用的顏色，重新整理、隔天再開都沿用
  if (!colorMemo || typeof colorMemo !== "object" || Array.isArray(colorMemo)) colorMemo = {};
  let watchReady = false;             // 關注清單讀進來了沒（內建路線在那之前就要上色）
  /**
   * 替剛載入的變體上色（一個顯示名稱一個顏色）：內建的固定；其他的沿用上次的顏色，不能沿用才挑同一個站別的路線沒用過的，然後記起來。
   * 規則在 core.routeColors：結果不看路線載入的先後（原本看，重新整理後 897 和 577 的顏色會對調）。
   * 取消關注不會清掉記的顏色，加回來還是原本那個（除非這段時間同一個站有別的路線用了它）。
   */
  function paint(vs) {
    for (const v of vs) if (PALETTE[v.display]) colorOf[v.display] = PALETTE[v.display];
    const rows = vs.filter((v) => !PALETTE[v.display]).map((v) => ({ unit: C.unitKey(v), display: v.display }));
    const todo = rows.filter((x) => !colorOf[x.display]);
    if (todo.length) {
      const used = {};                // 已經載入的單位 → 各顯示名稱現在的顏色
      for (const [u, ws] of unitsOf) { used[u] = {}; for (const w of ws) used[u][w.display] = colorOf[w.display]; }
      Object.assign(colorOf, C.routeColors(EXTRA, todo, watchReady ? watch : {}, used, colorMemo));
    }
    const memo = C.rememberColors(colorMemo, rows, colorOf);
    if (JSON.stringify(memo) !== JSON.stringify(colorMemo)) ls.set("bus:color", memo);      // 沒變就不寫（每次打開都會經過這裡）
    colorMemo = memo;
  }
  const tracker = C.createTracker([]);
  let map = null;                     // 地圖分頁第一次打開才建
  const families = [];
  const unitsOf = new Map();          // 關注單位（來源:主路線|方向）→ 這個單位的變體（同方向的繞駛、區間變體算同一個）
  const loaded = new Set();           // 已載入的路線鍵（來源:主路線）
  let watchRev = 0;                   // 關注或載入的路線有變就加一：各種快取靠它判斷要不要重算
  // 群組＝同一家路線、同一方向（路線分頁與時距圖用）；各變體的站合併成一條
  const groups = [];
  const groupOf = (id) => groups.find((g) => g.id === id) || groups[0];
  // 實體站位：所有變體的站依 StationID 合併。地圖站牌與每根站牌的到站都以它為單位（一根站牌、多條路線）
  const stKey = (s) => String(s.station || `${s.name}@${s.lat},${s.lon}`);
  const stations = new Map();
  function buildGroups(fam) {
    for (let i = groups.length - 1; i >= 0; i--) if (groups[i].family === fam) groups.splice(i, 1);
    for (const d of [0, 1]) {
      const vs = V.filter((v) => v.family === fam && v.direction === d);
      if (!vs.length) continue;
      const rows = C.mergeStops(vs), rowOf = {};
      for (const v of vs) rowOf[v.key] = [];
      rows.forEach((r, ri) => { for (const [k, si] of Object.entries(r.by)) rowOf[k][si] = ri; });
      groups.push({ id: `${fam}|${d}`, family: fam, dir: d, vs, rows, rowOf, label: `${fam} 往${vs[0].toward}` });
    }
  }
  /** 把變體加進來：內建路線在啟動時、其他路線在使用者關注它時。 */
  function addVariants(list) {
    const vs = list.filter((v) => !byKey.has(v.key)), fams = new Set();
    paint(vs);
    for (const v of vs) {
      V.push(v); byKey.set(v.key, v);
      color[v.key] = colorOf[v.display];
      const u = C.unitKey(v);
      if (!unitsOf.has(u)) unitsOf.set(u, []);
      unitsOf.get(u).push(v);
      loaded.add(u.split("|")[0]);
      fams.add(v.family);
      if (!families.includes(v.family)) families.push(v.family);
      v.stops.forEach((s, si) => {
        const k = stKey(s);
        if (!stations.has(k)) stations.set(k, { station: k, name: s.name, lat: s.lat, lon: s.lon, entries: [] });
        stations.get(k).entries.push({ key: v.key, si });
      });
    }
    C.addVariants(tracker, vs);
    for (const f of fams) buildGroups(f);
    watchRev++;
    if (map) addMapLayers();
    return vs;
  }
  addVariants(A.variants);
  state.group = groupOf(params.get("group")).id;

  // 其他路線的資料檔：關注時載入並加入追蹤；「找公車」的路線頁只讀站序，不加入追蹤
  const routeFiles = new Map(), routeLoad = new Map(), routeErr = new Map();
  async function fetchRoute(key) {
    if (routeFiles.has(key)) return routeFiles.get(key);
    const res = await fetch(`data/routes/${key.replace(":", "-")}.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const f = await res.json();
    routeFiles.set(key, f);
    return f;
  }
  function ensureRoute(key) {
    if (loaded.has(key)) return Promise.resolve(true);
    if (!routeLoad.has(key)) {
      routeErr.delete(key);
      routeLoad.set(key, fetchRoute(key).then((f) => {
        const vs = addVariants(f.variants);
        restore(new Set(vs.flatMap((v) => (v.tids && v.tids.length ? v.tids : [C.tidOf(v)]))));
        fillGroupSelects(); compute(); render();
        return true;
      }).catch((e) => { routeErr.set(key, e.message); routeLoad.delete(key); render(); return false; }));
    }
    return routeLoad.get(key);
  }

  // ---------------------------------------------------------------- 全市索引（站牌上的路線、行車方位、搜尋、附近的站）
  let CITY = null;
  let SIB = new Map();               // 站名 → 合成同一個地點的那一組（站名只差括號、夠近；core.stopGroups）。全市索引載入後才有
  const sibNames = (n) => (SIB.has(n) ? SIB.get(n).names : [n]);
  const sibLabel = (n) => (SIB.has(n) ? SIB.get(n).label : n);
  const sibKey = (n) => (SIB.has(n) ? SIB.get(n).key : n);
  const cityPlat = new Map();        // 站牌編號 → 索引列 [編號, 站名, 緯度, 經度, [[路線序號, 方向, 站牌編號]...], 行車方位, 短地址, 月台（有才有）]
  const routeByKey = new Map();      // 路線鍵 → 索引列 [鍵, 名稱, 來源, 主路線編號, 起點, 終點]
  const polesCache = new Map(), posCache = new Map();
  async function loadCity() {
    try {
      const res = await fetch("data/city-index.json");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      for (const p of d.plats) cityPlat.set(String(p[0]), p);
      for (const r of d.routes) routeByKey.set(r[0], r);
      CITY = d;
      SIB = C.stopGroups(d.plats);
      mergeSiblingStops();
    } catch (e) { state.cityNote = "全市路線與站牌資料讀不到（" + e.message + "），只能看已經載入的路線"; }
    polesCache.clear(); posCache.clear();
    render();
    ensureHelpers();
  }

  // ---------------------------------------------------------------- 幫忙量路況的路線
  // 別條路線的車跑過同一段路，一樣說明那一段現在好不好走。所以除了關注的路線，另外在背景載入幾條「和它們共用路段」的路線，
  // 只拿它們的車來量段速：不上畫面、不算到站、不出現在任何清單。剛打開頁面、自己路線的車還沒跑過時最有用。
  // 只挑和關注的路線同一個城市的（另一個城市的車輛資料要另外抓，為了幫手多抓一份不划算），最多 HELPER_MAX 條。
  const HELPER_MAX = 24;
  const helpers = new Set();          // 已經當幫手加進追蹤器的路線鍵
  let helperRev = -1, helperBusy = false;
  async function ensureHelpers() {
    if (!CITY || helperBusy || helperRev === watchRev) return;
    helperBusy = true;
    try {
      const rev = watchRev;
      const mine = V.filter((v) => activeKeys.has(v.key)), srcs = new Set(mine.map((v) => v.src || "tpe"));
      const stopsAt = { get: (id) => (cityPlat.get(String(id)) || [])[4] };
      const skip = new Set();
      CITY.routes.forEach((r, i) => { if (loaded.has(r[0]) || !srcs.has(r[2])) skip.add(i); });
      for (const ri of C.helperRoutes(mine, stopsAt, skip, HELPER_MAX, 2)) {
        const key = CITY.routes[ri][0];
        if (helpers.has(key) || loaded.has(key)) continue;
        try {
          const f = await fetchRoute(key);
          if (loaded.has(key)) continue;                           // 等的時候使用者剛好關注了它：已經由關注那邊加進去了
          const added = C.addVariants(tracker, f.variants, true);
          helpers.add(key);
          restore(new Set(added.flatMap((e) => e.tids)));
        } catch (e) { /* 這條幫手的資料讀不到：少一條而已，不影響畫面 */ }
      }
      helperRev = rev;
    } finally { helperBusy = false; }
    if (helperRev !== watchRev) ensureHelpers();                   // 載入的時候關注的路線又變了：再挑一次
  }

  // ---------------------------------------------------------------- 地點與關注
  let saved = ls.get("bus:saved", []);                  // 使用者存的常用站（站名）
  if (!Array.isArray(saved)) saved = [];
  let watch = ls.get("bus:watch", null);                // 地點 → [關注單位…]；順序就是畫面上的順序，第一個所在的那一側排最上面
  if (!watch || typeof watch !== "object" || Array.isArray(watch)) {
    // 第一次使用：設定檔裡每個常用地點的路線，兩個方向都先關注（不搭的那一側自己關掉）
    watch = {};
    for (const p of A.places) {
      const us = [];
      for (const pf of p.platforms || []) for (const e of pf.entries || []) {
        const v = byKey.get(e.key);
        if (v && !us.includes(C.unitKey(v))) us.push(C.unitKey(v));
      }
      watch["cfg:" + p.name] = us;
    }
  }
  watchReady = true;
  const saveWatch = () => { ls.set("bus:watch", watch); watchRev++; };
  let posSel = ls.get("bus:pos", {});                   // 地點 → 上次看的候車位置（那個位置第一根站牌的編號；ALL＝「全部」）
  if (!posSel || typeof posSel !== "object" || Array.isArray(posSel)) posSel = {};
  const ALL = "*";                                      // 「全部」：這個站關注的路線不分候車位置列在一起
  function setPos(placeId, posId) {
    if (posSel[placeId] === posId) return;
    posSel[placeId] = posId;
    ls.set("bus:pos", posSel);
  }
  /** 設定檔裡一個常用地點包含的站名：自己列的，加上和它們合成同一個地點的（站名只差括號）。 */
  const namesOf = (p) => [...new Set((p.match && p.match.length ? p.match : [p.name]).flatMap(sibNames))];
  /** 畫面上的地點。存起來的站與臨時站：key＝存的那個站名（地點的編號用它），name＝畫面上寫的，names＝合成同一個地點的全部站名。 */
  function allPlaces() {
    const ps = A.places.map((p) => ({ id: "cfg:" + p.name, name: p.name, names: namesOf(p), fixed: true }));
    const add = (n, temp) => { if (!ps.some((p) => p.names.includes(n))) ps.push({ id: "stop:" + n, key: n, name: sibLabel(n), names: sibNames(n), ...(temp ? { temp: true } : {}) }); };
    for (const n of saved) add(n);
    if (state.temp) add(state.temp, true);
    return ps;
  }
  /**
   * 全市索引載入後做一次：存起來的站（或臨時站）裡，有的現在和前面的地點算同一個（站名只差括號，或已經在常用站裡）——
   * 把它關注的路線併進前面那個地點，站只留一個。不併的話後面那個會從畫面上消失，它關注的路線也跟著不見。
   */
  function mergeSiblingStops() {
    const owners = A.places.map((p) => ({ id: "cfg:" + p.name, names: namesOf(p) })), keep = [];
    let changed = false;
    const fold = (n) => {
      const to = owners.find((o) => o.names.includes(n)), from = "stop:" + n;
      if (!to) return false;
      if (watch[from]) watch[to.id] = [...new Set([...(watch[to.id] || []), ...watch[from]])];
      delete watch[from]; delete posSel[from];
      if (state.place === from) state.place = to.id;
      if (ls.get("bus:placeId", null) === from) ls.set("bus:placeId", to.id);
      return (changed = true);
    };
    for (const n of saved) if (!fold(n)) { keep.push(n); owners.push({ id: "stop:" + n, names: sibNames(n) }); }
    if (state.temp && fold(state.temp)) { state.temp = null; ls.set("bus:temp", null); }
    if (!changed) return;
    saved = keep; ls.set("bus:saved", saved); ls.set("bus:pos", posSel);
    saveWatch();
  }
  function currentPlace() {
    const ps = allPlaces();
    return ps.find((p) => p.id === state.place) || ps[0] || null;
  }
  /** 一個地點的站牌（同站名的每一根）與各站牌上能搭的（路線、方向）。索引還沒載入或讀不到時，只知道已載入路線的站牌。 */
  function placePoles(pl) {
    const ck = pl.id + (CITY ? "+" : "-") + (CITY ? "" : watchRev);
    if (polesCache.has(ck)) return polesCache.get(ck);
    const poles = [];
    if (CITY) {
      for (const p of CITY.plats) {
        if (!pl.names.includes(p[1])) continue;
        const pole = { id: String(p[0]), name: p[1], lat: p[2], lon: p[3], heading: p[5] != null && p[5] >= 0 ? p[5] : null, addr: p[6] || "", bay: p[7] || "", items: [] };
        for (const [ri, g, stopId] of p[4]) {
          const r = CITY.routes[ri];
          pole.items.push({ unit: `${r[0]}|${g}`, routeKey: r[0], routeId: r[3], name: r[1], dir: g, stopId, toward: (g === 0 ? r[5] : r[4]) || "", pole });
        }
        poles.push(pole);
      }
    } else {
      for (const st of stations.values()) {
        if (!pl.names.includes(st.name)) continue;
        const pole = { id: st.station, name: st.name, lat: st.lat, lon: st.lon, heading: null, addr: "", bay: "", items: [] };
        for (const e of st.entries) {
          const v = byKey.get(e.key), unit = C.unitKey(v);
          if (e.si >= v.stops.length - 1 || pole.items.some((it) => it.unit === unit)) continue;      // 終點站只下不上
          pole.items.push({ unit, routeKey: unit.split("|")[0], routeId: v.routeId, name: v.family, dir: v.direction, stopId: v.stops[e.si].id, toward: v.toward, pole });
        }
        if (pole.items.length) poles.push(pole);
      }
    }
    polesCache.set(ck, poles);
    return poles;
  }
  /** 這個（路線、方向）在這根站牌上的即時部分：已載入的變體、顯示的名稱與顏色。 */
  function itemInfo(it) {
    const st = stations.get(it.pole.id);
    const entries = st ? st.entries.filter((e) => { const v = byKey.get(e.key); return C.unitKey(v) === it.unit && e.si < v.stops.length - 1; }) : [];
    const shows = [...new Set(entries.map((e) => byKey.get(e.key).display))];
    const v0 = entries.length ? byKey.get(entries[0].key) : null;
    return { entries, label: shows.length === 1 ? shows[0] : it.name, toward: v0 ? v0.toward : it.toward, col: v0 ? color[v0.key] : null };
  }
  /** 這個（路線、方向）接下來到這根站牌的車。路線已載入：每台車一筆；還沒載入：只有官方的下一班。 */
  function itemArrivals(it, info) {
    if (info.entries.length) return stationArrivals({ entries: info.entries }).map((a) => ({ ...a, label: a.v.display }));
    const n = C.officialNext(state.eta, it.routeId, it.stopId, it.dir);
    return n && n.ms != null ? [{ ms: n.ms, source: n.onLeg ? "官方" : "官方・未發車", v: null, label: info.label }] : [];
  }
  /** 一個地點的候車位置（順序固定，見 core.positions），各帶它的站牌與在那裡能搭的（路線、方向）。 */
  function placePositions(pl) {
    const ck = pl.id + (CITY ? "+" : "-" + watchRev);
    if (posCache.has(ck)) return posCache.get(ck);
    const poles = placePoles(pl), poleOf = new Map(poles.map((p) => [p.id, p]));
    const pos = C.positions(poles.map((p) => ({ id: p.id, heading: p.heading, lat: p.lat, lon: p.lon, bay: p.bay, addr: p.addr, name: p.name, units: p.items.map((it) => it.unit) })));
    for (const x of pos) {
      const seen = new Set();
      x.poles = x.ids.map((id) => poleOf.get(id));
      x.items = x.poles.flatMap((p) => p.items).filter((it) => !seen.has(it.unit) && seen.add(it.unit));      // 同一條路線停這個位置的兩根站牌：算第一根
    }
    posCache.set(ck, pos);
    return pos;
  }
  /**
   * 一個地點的畫面資料：全部的候車位置、那一排怎麼排、現在看的是哪一個、它關注的路線各一列。
   * 現在看哪一個：記住的那一個 → 第一個有關注路線的 → 離你最近的（有定位時）→ 第一個。
   * 記住的是「全部」時，cur 是湊出來的一個位置（all: true）：列是每個有關注路線的位置的列接起來（照位置的固定順序），每一列帶著它自己的位置（at）。
   */
  function placeView(pl) {
    const poles = placePoles(pl), wk = watch[pl.id] || [];
    const pos = placePositions(pl).map((x) => {
      const watched = wk.map((u) => x.items.find((it) => it.unit === u)).filter(Boolean);       // 這裡的順序＝關注的先後；等車頁畫的時候再照到站時間排（renderWait）
      return { ...x, watched, rows: watched.map((it) => {
        const info = itemInfo(it);
        return { it, info, label: info.label, toward: info.toward, col: info.col, arr: itemArrivals(it, info) };
      }) };
    });
    const withRows = pos.filter((x) => x.watched.length);
    const dist = (x) => Math.min(...x.poles.map((p) => distM(state.me, p)));
    const bar = C.positionBar(pos, withRows.map((x) => x.id), posSel[pl.id] === ALL);
    let cur;
    if (bar.all && posSel[pl.id] === ALL) {
      const once = (key) => { const seen = new Set(); return (x) => !seen.has(key(x)) && seen.add(key(x)); };      // 同一條路線停兩個位置：算前面那一個
      const rows = withRows.flatMap((x) => x.rows.map((r) => ({ ...r, at: x }))).filter(once((r) => r.it.unit));
      cur = { id: ALL, all: true, label: "全部", long: "全部", addr: "", poles: withRows.flatMap((x) => x.poles),
              items: pos.flatMap((x) => x.items).filter(once((it) => it.unit)), watched: rows.map((r) => r.it), rows };
    } else {
      cur = pos.find((x) => x.id === posSel[pl.id]) || withRows[0] ||
        (state.me ? [...pos].sort((a, b) => dist(a) - dist(b))[0] : pos[0]) || null;
    }
    // 地圖底下的清單：現在看的位置排最前面，其餘有關注路線的位置接在後面（「全部」：每個位置一段，照固定順序）
    const secs = !cur ? [] : cur.all ? withRows : [cur, ...withRows.filter((x) => x !== cur)].filter((x) => x.watched.length);
    return { poles, pos, bar, cur, rows: cur ? cur.rows : [], secs, watched: pos.flatMap((x) => x.watched) };
  }
  /** 目前地點關注中的單位（地圖只畫這幾條）。 */
  const shownUnits = () => new Set((state.place && watch[state.place]) || []);
  const isShown = (v) => shownUnits().has(C.unitKey(v));
  /** 所有地點關注到的路線都載進來（啟動時、關注有變時）。 */
  function ensureWatchedRoutes() {
    for (const us of Object.values(watch)) for (const u of us) ensureRoute(u.split("|")[0]);
  }

  // ---------------------------------------------------------------- 保存
  const trackKey = () => `bus:track:${C.serviceDay(nowMs()).start}`;
  let lastPersist = 0;
  function persist(force) {
    if (REPLAY) return;                                           // 重播不寫入，免得蓋掉即時軌跡
    const now = nowMs();
    if (!force && now - lastPersist < 30e3) return;
    lastPersist = now;
    const bins = {};
    for (const ent of tracker.ents) bins[ent.tid] = ent.bins;
    const keep = now - 20 * 60e3;                               // 只存最近 20 分鐘的軌跡：追蹤的路線變多後，存太久會超過瀏覽器的儲存上限
    const shown = new Set(V.flatMap((v) => (v.tids && v.tids.length ? v.tids : [C.tidOf(v)])));     // 幫手路線的車不存軌跡（只存段速），不然很快就超過上限
    const buses = [...tracker.buses.values()].filter((b) => shown.has(b.tid)).map((b) => ({ ...b, trace: b.trace.filter((p) => p.t >= keep) }));
    ls.set(trackKey(), { buses, bins });
  }
  /** 把存起來的軌跡放回去。only＝只放這些車輛回報編號的（之後才載入的路線）；已經有即時資料的不蓋掉。 */
  function restore(only) {
    if (REPLAY) return;
    const s = ls.get(trackKey(), null);
    if (!s) return;
    const ok = (tid) => tracker.byId.has(tid) && (!only || only.has(tid));
    for (const b of s.buses || []) if (b.tid && ok(b.tid) && !tracker.buses.has(b.id)) tracker.buses.set(b.id, b);
    for (const [id, arr] of Object.entries(s.bins || {})) if (ok(id) && !tracker.byId.get(id).bins.length) tracker.byId.get(id).bins = arr;
  }

  // ---------------------------------------------------------------- 抓資料
  async function initReplay() {
    const text = await (await fetch(`/logs/${encodeURIComponent(REPLAY)}/manifest.jsonl`, { cache: "no-store" })).text();
    const rows = text.split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.ok && r.saved);
    const pick = (f) => rows.filter((r) => r.file === f).map((r) => ({ t: C.parseTpe(r.updateTime), path: r.saved }))
      .filter((r) => Number.isFinite(r.t)).sort((a, b) => a.t - b.t);
    replay = { GetBusData: pick("GetBusData"), GetEstimateTime: pick("GetEstimateTime") };
    const at = (params.get("at") || "").replace(":", "");
    const first = replay.GetBusData.find((r) => !at || C.fmtTime(r.t).replace(":", "") >= at) || replay.GetBusData[0];
    clock.base = first.t; clock.t0 = Date.now();
  }
  /** 重播：取「重播時鐘」當下最新的一份快照。 */
  function replayUrl(name) {
    const list = replay[name], now = nowMs();
    let hit = list[0];
    for (const r of list) { if (r.t <= now) hit = r; else break; }
    return `/logs/${encodeURIComponent(REPLAY)}/${hit.path}`;
  }
  const etaSources = () => (replay ? ["tpe"] : Object.keys(SOURCES));           // 重播記錄只有台北市
  const liveBusSources = () => (replay ? ["tpe"] : [...new Set(V.map((v) => v.src || "tpe"))]);
  async function getBlob(name, src) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15e3);
    try {
      const res = await fetch(replay ? replayUrl(name) : SOURCES[src].base + name + ".gz", { cache: "no-store", signal: ctl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      let text;
      if (buf[0] === 0x1f && buf[1] === 0x8b) text = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
      else text = new TextDecoder().decode(buf);     // 已被瀏覽器自動解壓
      return C.parseBlobJson(text);
    } finally { clearTimeout(timer); }
  }
  const errs = { bus: null, eta: null };
  /** 哪些來源抓失敗（其餘來源照常顯示）。 */
  const failNote = (label, rs, ids) => {
    const bad = rs.map((r, i) => (r.status === "rejected" ? `${(SOURCES[ids[i]] || {}).name || ids[i]} ${r.reason.message}` : null)).filter(Boolean);
    return bad.length ? `${label}：${bad.join("、")}` : null;
  };
  async function pollBuses() {
    const ids = liveBusSources();
    const rs = await Promise.allSettled(ids.map((src) => getBlob("GetBusData", src)));
    for (const r of rs) {
      if (r.status !== "fulfilled") continue;
      C.ingestBusData(tracker, r.value, nowMs());
      const u = C.parseTpe((r.value.EssentialInfo || {}).UpdateTime);
      if (Number.isFinite(u)) state.busUpdate = Math.max(state.busUpdate || 0, u);
    }
    errs.bus = failNote("車輛定位", rs, ids);
    compute(); render(); persist();
  }
  async function pollEta() {
    const ids = etaSources();
    const rs = await Promise.allSettled(ids.map((src) => getBlob("GetEstimateTime", src)));
    rs.forEach((r, i) => { if (r.status === "fulfilled") state.etaBy[ids[i]] = C.indexEta(r.value, null); });   // 全部路線都收：站牌看板要查沒追蹤的路線
    state.eta = C.mergeEta(Object.values(state.etaBy));
    errs.eta = failNote("預估到站", rs, ids);
    compute(); render();
  }
  /** 要推算到站的變體：任何地點關注中的路線，加上路線／時距圖分頁正在看的那一組。 */
  let activeKeys = new Set(), activeRev = -1;
  function compute() {
    const now = nowMs();
    if (activeRev !== watchRev) {
      activeKeys = new Set();
      for (const us of Object.values(watch)) for (const u of us) for (const v of unitsOf.get(u) || []) activeKeys.add(v.key);
      activeRev = watchRev;
      ensureHelpers();                                             // 關注的路線變了：幫手路線跟著重挑（在背景載入）
    }
    const extra = state.tab === "route" || state.tab === "marey" ? groupOf(state.group).vs : [];
    for (const v of V) {
      if (activeKeys.has(v.key) || extra.includes(v)) state.results[v.key] = C.routeArrivals(tracker, v.tid, state.eta, now);
      else delete state.results[v.key];                          // 沒人看的路線不算推估（仍照常收定位，前車段速繼續累積）
    }
  }
  let busTimer = null, etaTimer = null;
  function stopPolling() { clearInterval(busTimer); clearInterval(etaTimer); busTimer = etaTimer = null; }
  function startPolling() {
    stopPolling();
    if (document.hidden) return;                                // 分頁在背景時不抓（省電、省流量）
    pollBuses(); pollEta();
    busTimer = setInterval(pollBuses, BUS_MS);
    etaTimer = setInterval(pollEta, ETA_MS);
  }

  // ---------------------------------------------------------------- 到站清單（一根站牌、多條路線）
  /** 這根站牌接下來的每一台車，依到站時刻排序。 */
  function stationArrivals(st) {
    const out = [];
    for (const e of st.entries) {
      const v = byKey.get(e.key), R = state.results[v.key];
      if (!R) continue;
      for (const a of R.perStop[e.si]) out.push({ ...a, v, si: e.si, info: a.bus ? R.active.find((x) => x.id === a.bus) : null });
    }
    out.sort((x, y) => x.ms - y.ms);
    // 「依班距」只是上限，不是一台看得到的車：該路線已有兩班真實資料就不列，否則只留最早一筆
    const real = {}, seen = new Set();
    for (const a of out) if (a.source !== "班距") real[a.v.display] = (real[a.v.display] || 0) + 1;
    return out.filter((a) => {
      if (a.source !== "班距") return true;
      if ((real[a.v.display] || 0) >= 2 || seen.has(a.v.display)) return false;
      seen.add(a.v.display);
      return true;
    });
  }
  /** 這個時間怎麼來的（滑鼠移上去才看得到；畫面上不放標籤，自己估的只在時間前面寫「約」）。 */
  function srcTitle(source) {
    if (!source) return "";
    if (source === "官方") return "官方預估到站";
    if (source === "官方・未發車") return "官方預估到站；這班車還沒開始跑這個方向（尚未發車，或還在對向那一趟）";
    if (source.startsWith("官方・")) return "官方預估到站；這台車目前沒有定位資料";
    if (source === "班表") return "起點還沒發車，依班表估算";
    if (source === "班距") return "這條路線只公布班距：下一班最晚在班距上限內從起點發車，再加上開到這站的時間";
    const detail = { 前車: "前面幾台車跑過這一段的時間（平均）", 均速: "這台車近 5 分鐘均速", 預設: "預設車速" };
    return "估算：" + source.replace("官方→", "以官方預估為起點，接續用").replace(/前車|均速|預設/g, (m) => detail[m]);
  }
  function etaText(a, now) {
    if (a.upper) return { text: `≤ ${Math.max(1, Math.round((a.ms - now) / 60e3))} 分`, soon: false };
    const s = (a.ms - now) / 1000;
    if (s < 60) return { text: "即將到站", soon: true };
    const m = Math.round(s / 60), about = a.source && C.isApprox(a.source) ? "約 " : "";      // 自己估的寫「約」；官方報的照寫
    return { text: about + (m <= 90 ? `${m} 分` : fmt(a.ms)), soon: m <= 3 };
  }
  const who = (a) => (a.bus ? a.bus : a.source === "班表" || a.source === "官方・未發車" ? "未發車" : a.source === "班距" ? "依班距" : "未定位");
  /** 「最早可能」到站時刻：校準表依這班車的路線與現在是白天或夜間挑。 */
  const earliestOf = (a, now) => C.earliestMs(a, now, C.calibFor(CAL, a.v && a.v.family, now));
  /** 「最早可能」幾分後；與預測差不到 1 分、或已即將到站時不顯示。 */
  function earliestText(a, now) {
    const em = earliestOf(a, now);
    if (em == null || (a.ms - now) < 60e3) return "";
    const eMin = Math.round((em - now) / 60e3), pMin = Math.round((a.ms - now) / 60e3);
    if (pMin - eMin < 1) return "";
    return eMin <= 0 ? "最早隨時" : `最早 ${eMin} 分`;
  }
  /** 這台車離這一站還有幾站、多遠。 */
  function whereText(a) {
    if (!a.info) return "";
    const stop = a.v.stops[a.si], km = stop.km - a.info.km;
    const n = a.v.stops.filter((s) => s.km > a.info.km + C.P.passTolKm && s.km <= stop.km + 1e-9).length;
    const dist = km < 1 ? `${Math.max(0, Math.round(km * 1000))} m` : `${km.toFixed(1)} km`;
    return n <= 1 ? `下一站就到・${dist}` : `還有 ${n} 站・${dist}`;
  }
  function rowHTML(a, now) {
    const e = etaText(a, now), early = earliestText(a, now), where = whereText(a);
    const age = a.info && a.info.ageS > 45 ? `<span class="age">定位 ${Math.round(a.info.ageS)} 秒前</span>` : "";
    return `<li class="arow${a.info && a.info.ageS > 90 ? " stale" : ""}"${a.bus ? ` data-bus="${esc(a.bus)}" tabindex="0" role="button" title="在地圖上看這台車"` : ""}>` +
      `<div class="eta${e.soon ? " soon" : ""}" title="${esc(srcTitle(a.source))}">${e.text}${early ? `<span class="early" title="依驗證資料，${CAL_COVER}的情況車不會比這更早到">${early}</span>` : ""}</div>` +
      `<div class="whom"><span class="vchip" style="--c:${color[a.v.key]}">${esc(a.v.display)}</span><span class="plate">${esc(who(a))}</span></div>` +
      `<div class="sub">${a.upper ? "" : fmt(a.ms)}${where ? `<span>${where}</span>` : ""}${age}</div></li>`;
  }

  // ---------------------------------------------------------------- 等車：一個地點、每條關注的路線一列
  const distM = C.distM;
  const CODE_TEXT = { "-1": "尚未發車", "-2": "交管不停靠", "-3": "末班已過", "-4": "今日未營運" };
  /** 路線牌：號碼大字、後綴小字（307／莒光）。沒有顏色的是還沒載入的路線。 */
  function badgeHTML(label, col, cls) {
    const [main, suffix] = C.splitRouteName(label);
    if (main.length > 5) cls = (cls ? cls + " " : "") + "long";
    return `<span class="badge${cls ? " " + cls : ""}${col ? "" : " plain"}"${col ? ` style="--c:${col}"` : ""}><b>${esc(main)}</b>${suffix ? `<small>${esc(suffix)}</small>` : ""}</span>`;
  }
  /** 大數字：幾分後到。 */
  /** 大數字的分鐘數：沒有車 null、不到一分鐘（到站）0、依班距的是「≤」後面那個數。列的上下順序也照它排，數字和順序才不會打架。 */
  function shownMin(a, now) {
    if (!a) return null;
    const m = Math.round((a.ms - now) / 60e3);
    return a.upper ? Math.max(1, m) : a.ms - now < 60e3 ? 0 : m;
  }
  function bigOf(a, now) {
    const m = shownMin(a, now);
    if (m == null) return { num: "—", unit: "", soon: false };
    if (a.upper) return { num: "≤" + m, unit: "分", soon: false };
    if (m === 0) return { num: "到站", unit: "", soon: true };
    const about = C.isApprox(a.source);
    return m <= 90 ? { num: String(m), unit: "分", soon: m <= 3, about } : { num: fmt(a.ms), unit: "", soon: false, about };
  }
  /** 沒有車時說明原因（官方的代碼：尚未發車、末班已過…）。 */
  function idleText(it) {
    const n = C.officialNext(state.eta, it.routeId, it.stopId, it.dir);
    return (n && n.code != null && CODE_TEXT[n.code]) || "目前沒有車";
  }
  /** 站牌前 2 km 的路況：取量到最多的那條路線；低速或停滯才說，接在出門提醒的小字後面（不另外佔一行，免得出現時下面的列往下掉）。 */
  function roadText(rows, now) {
    let best = null;
    for (const r of rows) for (const e of r.info.entries) {
      const v = byKey.get(e.key), x = C.roadAhead(tracker, v.tid, v.stops[e.si].km, now);
      if (x && (!best || x.coverage > best.coverage)) best = x;
    }
    if (!best || best.coverage < 0.4 || best.kmh == null || best.kmh >= 10) return "";
    return `・<span class="road ${best.kmh < 5 ? "jam" : "slow"}" title="公車在站牌前 2 km 實際跑的速度，含靠站與紅燈">前方${best.kmh < 5 ? "停滯" : "低速"} ${Math.round(best.kmh)} km/h</span>`;
  }
  /**
   * 出門提醒：走到站牌要幾分，對上「最早可能到站」，告訴你現在該不該走。算的是現在看的那個候車位置；
   * 「全部」時每一班車用它自己那個位置的走路時間，小字寫的是要搭的那一班在哪裡等。這一塊永遠在，下面的列才不會上下跳。
   */
  function leaveHTML(pv, now) {
    if (!pv.rows.length) return `<div class="leave none">還沒選路線</div>`;
    if (!state.me) return `<button type="button" class="leave ask" data-locate>${LOC_SVG}<span>${esc(state.geoErr || (state.geoNote === "定位中…" ? "定位中…" : "定位，看幾分後出門"))}</span></button>`;
    const at = (r) => r.at || pv.cur, dOf = (x) => Math.min(...x.poles.map((p) => distM(state.me, p)));
    const near = [...new Set(pv.rows.map(at))].reduce((a, b) => (dOf(b) < dOf(a) ? b : a));
    const dm = dOf(near);
    if (dm > FAR_M) return `<div class="leave none">你離這個站約 ${(dm / 1000).toFixed(1)} km<small><button type="button" class="link" data-go-find>看附近的站牌</button></small></div>`;
    // 小字：哪個位置（分頁上的短標籤才寫；選單上已經是完整地址，再寫一次會把後面的分鐘數擠掉）＋走過去幾分＋前方路況
    const walkMin = (x) => (dOf(x) * WALK_DETOUR) / WALK_M_PER_MIN, least = (a) => ((earliestOf(a, now) || a.ms) - now) / 60e3;
    const arr = pv.rows.flatMap((r) => r.arr.filter((a) => !a.upper).map((a) => ({ a, x: at(r) }))).sort((p, q) => p.a.ms - q.a.ms);
    const found = arr.find(({ a, x }) => least(a) >= walkMin(x)), spot = found ? found.x : near, w = walkMin(spot);
    const where = pv.cur.all || pv.bar.mode === "tabs" || pv.bar.mode === "more" ? esc(spot.label) + "・" : "";
    const walk = `${where}走到站牌約 ${Math.max(1, Math.round(w))} 分` + roadText(pv.rows, now);
    if (!found) return `<div class="leave none">目前沒有趕得上的車<small>${walk}</small></div>`;
    const hit = found.a, slack = least(hit) - w;
    const which = `${esc(hit.label)}（${etaText(hit, now).text}）`;
    return slack <= 1.5 ? `<div class="leave go">現在出門・搭 ${which}<small>${walk}</small></div>`
                        : `<div class="leave">${Math.floor(slack)} 分鐘後出門・搭 ${which}<small>${walk}</small></div>`;
  }
  function rowDetailHTML(r, now) {
    const key = r.it.routeKey;
    const body = r.info.entries.length
      ? (r.arr.length ? `<ul class="arows">${r.arr.slice(0, 6).map((a) => rowHTML(a, now)).join("")}</ul>` : `<p class="empty">${esc(idleText(r.it))}</p>`)
      : `<p class="empty">${routeErr.has(key) ? `這條路線的資料讀不到（${esc(routeErr.get(key))}），只能顯示官方的下一班` : "正在載入這條路線，稍後會列出每一台車"}</p>`;
    // 起站的末班發車時刻：這一列每個變體都有今天的資料才寫（是從起站發車的時刻，不是到這一站的時刻）
    const last = C.lastDepartureToday([...new Set(r.info.entries.map((e) => byKey.get(e.key)))], now);
    return `<div class="rt-more">${body}<div class="rt-acts">${last ? `<span class="rt-last">起站末班 ${last}</span>` : ""}` +
      `<button type="button" class="btn" data-unwatch="${esc(r.it.unit)}">不再關注</button></div></div>`;
  }
  /** 一條關注的路線一列：下一班幾分（大字）、往哪裡、再來兩班。點了展開看每一台車。「全部」時往哪裡那一行改放在最下面、前面寫在哪裡等（r.at）。 */
  function routeRowHTML(r, now, hot) {
    const a = r.arr[0], big = bigOf(a, now), early = a ? earliestText(a, now) : "";
    const later = r.arr.slice(1).filter((x) => !x.upper && x.ms - now <= 90 * 60e3).slice(0, 2).map((x) => Math.max(1, Math.round((x.ms - now) / 60e3)));
    const open = state.openRow === r.it.unit;
    const src = !a ? "" : a.source === "官方・未發車" || a.source === "班表" ? "未發車" : a.source === "班距" ? "依班距" : "";
    const sub = !a ? idleText(r.it) : [early, src].filter(Boolean).join("・");
    return `<article class="rt${hot ? " hot" : ""}"><button type="button" class="rt-main" data-row="${esc(r.it.unit)}" aria-expanded="${open}">` +
      `<span class="rt-id">${badgeHTML(r.label, r.col)}${r.at ? "" : `<span class="rt-to">往 ${esc(r.toward)}</span>`}</span>` +
      `<span class="rt-eta"><span class="big${big.soon ? " soon" : ""}"${a ? ` title="${esc(srcTitle(a.source))}"` : ""}>${big.about ? "<small>約</small>" : ""}<span class="num" data-num="${esc(big.num)}">${esc(big.num)}</span>${big.unit ? `<small>${big.unit}</small>` : ""}</span><span class="rt-sub">${esc(sub)}</span></span>` +
      `<span class="rt-later"><small>再來</small><b>${later.length ? later.join("、") + " 分" : "—"}</b></span>` +
      (r.at ? `<span class="rt-where">${esc(r.at.label)}・往 ${esc(r.toward)}</span>` : "") + `</button>` +
      (open ? rowDetailHTML(r, now) : "") + `</article>`;
  }
  const CHEV_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
  /**
   * 候車位置那一排：左邊是位置（文字、分頁、或選單，規則見 core.positionBar），最右邊一顆「選路線」。
   * 位置的順序固定，不隨關注變動；「其他」與選單打開的是同一份清單，有關注路線的位置前面有一個點。
   * 有關注路線的位置不只一個時最前面多一顆「全部」（分頁時是第一顆，整個用選單時是選單的第一項）。
   */
  function posRowHTML(pv) {
    const { bar, cur } = pv, inRest = bar.rest.includes(cur);
    const allTab = bar.all ? `<button type="button" data-pos="${ALL}" aria-pressed="${!!cur.all}" aria-label="這個站關注的路線全部列出來">全部</button>` : "";
    const allItem = bar.all && bar.mode === "drop" ? `<button type="button" role="menuitemradio" aria-checked="${!!cur.all}" data-pos="${ALL}"><i class="on"></i><span>全部</span><small>${pv.watched.length} 條</small></button>` : "";
    let left;
    if (bar.mode === "plain") left = `<div class="posplain">${esc(cur.long)}</div>`;
    else if (bar.mode === "drop") left = `<button type="button" class="posdrop" data-pos-menu aria-expanded="${state.posMenu}" aria-label="換候車位置"><span>${esc(cur.long)}</span>${CHEV_SVG}</button>`;
    else left = `<div class="seg dirs postabs" role="group" aria-label="候車位置">` + allTab +
      bar.tabs.map((x) => `<button type="button" data-pos="${esc(x.id)}" aria-pressed="${x === cur}" aria-label="候車位置 ${esc(x.long)}">${esc(x.label)}</button>`).join("") +
      (bar.mode === "more" ? `<button type="button" data-pos-menu aria-pressed="${inRest}" aria-expanded="${state.posMenu}" aria-label="其他候車位置">${esc(inRest ? cur.label : "其他")}<i class="caret"></i></button>` : "") + `</div>`;
    const menu = state.posMenu && bar.rest.length ? `<div class="posmenu" role="menu">` + allItem + bar.rest.map((x) =>
      `<button type="button" role="menuitemradio" aria-checked="${x === cur}" data-pos="${esc(x.id)}"><i${x.watched.length ? ' class="on"' : ""}></i><span>${esc(x.long)}</span><small>${x.items.length} 條</small></button>`).join("") + `</div>` : "";
    return left + `<button type="button" class="pickbtn" data-pick-open><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h10M4 12h16M4 18h7M18 4v4M15 16v4"/></svg>選路線</button>` + menu;
  }
  /** 「選路線」面板：只列現在這個候車位置停的路線（「全部」時是這個站每個位置的），順序固定（照路線號碼），每列一顆關注開關；沒關注的只列官方的下一班。 */
  function renderPick(pv, pl, now) {
    const box = $("#picker"), cur = pv.cur;
    showPicker(!!(state.pick && cur));
    if (box.hidden || box.classList.contains("out")) return;
    const wk = watch[pl.id] || [], items = cur.items;
    $("#pickTitle").textContent = pl.name;
    $("#pickSub").textContent = (pv.pos.length > 1 || cur.addr ? cur.long + "・" : "") + items.length + " 條";
    $("#fltRow").hidden = items.length <= 8;
    const f = (items.length > 8 ? state.filter : "").trim().toLowerCase();
    const hit = (it) => !f || itemInfo(it).label.toLowerCase().includes(f) || it.name.toLowerCase().includes(f);
    const rows = items.filter(hit).map((it) => ({ it, info: itemInfo(it) }))
      .sort((a, b) => C.routeCompare(a.info.label, b.info.label) || a.it.dir - b.it.dir);
    // 這個位置沒有要找的路線：列出這個站有那條路線的其他位置，點了就換過去（大站要找的路線常在另一根站牌）
    const elsewhere = rows.length || !f ? [] : pv.pos.filter((x) => x !== cur && x.items.some(hit));
    setHTML("#pickList", rows.map(({ it, info }) => {
      const on = wk.includes(it.unit);
      let eta;
      if (on && info.entries.length) {
        const a = itemArrivals(it, info)[0];
        eta = a ? `<span class="eta${etaText(a, now).soon ? " soon" : ""}">${etaText(a, now).text}</span>` : `<span class="eta off">${esc(idleText(it))}</span>`;
      } else {
        const n = C.officialNext(state.eta, it.routeId, it.stopId, it.dir);
        eta = n && n.ms != null ? `<span class="eta${etaText({ ms: n.ms }, now).soon ? " soon" : ""}">${etaText({ ms: n.ms }, now).text}${n.onLeg ? "" : "<small>未發車</small>"}</span>`
                                : `<span class="eta off">${(n && CODE_TEXT[n.code]) || "沒有資料"}</span>`;
      }
      return `<div class="all-row">${badgeHTML(info.label, info.col, "sm")}<span class="to">往 ${esc(info.toward)}</span>${eta}` +
        `<button type="button" class="wbtn" data-watch="${esc(it.unit)}" aria-pressed="${on}" aria-label="${on ? "取消關注" : "關注"} ${esc(info.label)} 往${esc(info.toward)}">${on ? "已關注" : "關注"}</button></div>`;
    }).join("") || `<p class="empty">${elsewhere.length ? "這個位置沒有，在：" : "沒有符合的路線"}</p>` + elsewhere.map((x) =>
      `<button type="button" class="pick" data-pos="${esc(x.id)}"><span><b>${esc(x.long)}</b></span><em>${x.items.filter(hit).length} 條 ›</em></button>`).join(""));
    setHTML("#pickFoot", !pl.fixed && !pl.temp ? `<button type="button" class="link" data-unsave="${esc(pl.key)}">把「${esc(pl.name)}」從常用站移除</button>` : "");
  }
  /** 選路線面板開或關。關的時候先滑下去再藏起來（不能動的時候直接藏）。 */
  function showPicker(on) {
    const box = $("#picker");
    if (on) { box.classList.remove("out"); box.hidden = false; return; }
    if (box.hidden || box.classList.contains("out")) return;
    if (!canMove()) { box.hidden = true; return; }
    box.classList.add("out");
    setTimeout(() => { if (box.classList.contains("out")) { box.hidden = true; box.classList.remove("out"); } }, 190);
  }
  function openPick() {
    const pl = currentPlace(), pv = pl && placeView(pl);
    if (!pv || !pv.cur) return;
    setPos(pl.id, pv.cur.id);                             // 面板開著時關注的變動不會讓「現在看的位置」換掉
    state.pick = true; state.posMenu = false; state.filter = ""; $("#flt").value = "";
    render();
    $("#pickList").scrollTop = 0;
  }
  function closePick() {
    if (!state.pick) return;
    state.pick = false; state.filter = ""; $("#flt").value = "";
    render();
  }
  let lastPlaceShown = null;
  let lastOrder = { id: "", units: [] };                // 等車頁上一次畫出來的上下順序（哪個地點、哪個候車位置的）
  let lastNums = { id: "", by: new Map() };             // 上一次每一列的大數字（翻牌要知道原本是什麼）
  let lastOpenShown = null, pressing = false;           // 上一次展開的是哪一列；手指是不是正按在清單上
  /** 列換了上下位置：從原本的位置滑到新的位置（內容是整塊換掉的，所以先記下每一列原本在哪）。 */
  function slideRows(board, tops) {
    for (const b of board.querySelectorAll("[data-row]")) {
      const el = b.closest(".rt"), was = tops.get(b.dataset.row);
      if (was == null) continue;
      const dy = was - el.getBoundingClientRect().top;
      if (Math.abs(dy) < 2) continue;
      el.style.position = "relative"; el.style.zIndex = dy > 0 ? "2" : "1";      // 往上超車的那一列蓋在上面
      el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 300, easing: EASE }).onfinish = () => { el.style.position = ""; el.style.zIndex = ""; };
      motion.slides++;
    }
  }
  /**
   * 一格翻牌：上半片（舊的）往下翻、蓋住的下半片（新的）跟著翻下來，像老車站的看板。
   * 靜止時仍然是一般的字，翻的那 0.4 秒才有上下兩片。
   */
  function flipNum(el, was, now) {
    const half = 210;
    const widthOf = (txt) => { el.textContent = txt; return el.getBoundingClientRect().width; };
    const cells = C.flapCells(was, now), wide = cells.length === 1 ? Math.max(widthOf(was), widthOf(now)) : 0;      // 整個一起翻：舊的可能比新的寬（10 → 9），翻的時候先留舊的寬度
    el.textContent = "";
    for (const [a, b] of cells) {
      const cell = document.createElement("span"); cell.className = "flap"; cell.textContent = b;
      if (wide) cell.style.minWidth = wide + "px";
      el.appendChild(cell);
      if (a === b) continue;
      const piece = (cls, ch) => { const p = document.createElement("span"); p.className = "flap-h " + cls; p.textContent = ch; p.setAttribute("aria-hidden", "true"); cell.appendChild(p); return p; };
      const oldBot = piece("bot", a), oldTop = piece("top", a), newBot = piece("bot", b);
      cell.classList.add("on");
      oldTop.animate([{ transform: "rotateX(0deg)" }, { transform: "rotateX(-90deg)" }], { duration: half, easing: "ease-in", fill: "forwards" });
      newBot.animate([{ transform: "rotateX(90deg)" }, { transform: "rotateX(0deg)" }], { duration: half, delay: half, easing: "ease-out", fill: "both" })
        .onfinish = () => { for (const p of [oldBot, oldTop, newBot]) p.remove(); cell.classList.remove("on"); cell.style.minWidth = ""; };
    }
    motion.flips++;
  }
  /** 每一列的大數字和上一次比：同一個清單裡數字變了的翻牌。換了地點或候車位置不翻（那是換一整份清單）。 */
  function flipNumbers(board, listId) {
    const els = new Map([...board.querySelectorAll("[data-row]")].map((b) => [b.dataset.row, b.querySelector(".num")]));
    if (lastNums.id === listId && canMove()) for (const [u, el] of els) {
      const was = lastNums.by.get(u);
      if (el && was != null && was !== el.dataset.num) flipNum(el, was, el.dataset.num);
    }
    lastNums = { id: listId, by: new Map([...els].filter(([, el]) => el).map(([u, el]) => [u, el.dataset.num])) };
  }
  /** 一塊內容淡進來（換地點、換候車位置、展開一列）。 */
  function fadeIn(el, dy) {
    if (!el || !canMove()) return;
    el.animate([{ opacity: 0, transform: `translateY(${dy}px)` }, { opacity: 1, transform: "none" }], { duration: 200, easing: EASE });
    motion.fades++;
  }
  const placeChipsHTML = (pl) => allPlaces().map((p) =>
    `<button type="button" data-place="${esc(p.id)}" aria-pressed="${!!pl && p.id === pl.id}"${p.temp ? ' class="temp"' : ""}>${esc(p.name)}</button>`).join("");
  /** 橫向捲動的那一列：右邊還有東西時加上淡出，提示可以往右滑。 */
  const syncFade = (seg) => seg.classList.toggle("more-right", seg.scrollWidth - seg.clientWidth - seg.scrollLeft > 4);
  /** 把選中的站捲進那一排看得到的範圍（只在換站或那一排的寬度變了的時候做，不跟使用者自己的左右滑動搶）。 */
  function revealChip() {
    const pseg = $("#placeSeg"), on = pseg.querySelector('[aria-pressed="true"]');
    if (!on) return;
    const b = pseg.getBoundingClientRect(), c = on.getBoundingClientRect();
    if (c.right > b.right - 8) pseg.scrollLeft += c.right - b.right + 8;
    else if (c.left < b.left + 8) pseg.scrollLeft -= b.left - c.left + 8;
    syncFade(pseg);
  }
  function renderWait() {
    const pl = currentPlace(), now = nowMs();
    state.place = pl ? pl.id : null;
    const pseg = $("#placeSeg");
    pseg.innerHTML = placeChipsHTML(pl);
    if (state.place !== lastPlaceShown) { lastPlaceShown = state.place; revealChip(); }      // 換了地點：把選中的那顆捲進畫面（不然選了卻看不到是哪一顆）
    syncFade(pseg);
    $("#tempBar").hidden = !(pl && pl.temp);
    $("#geoNote").innerHTML = esc(state.geoNote) + (state.me ? ` <button type="button" class="link" data-relocate>重新定位</button>` : "");
    // 即時資料還沒到就先不畫（只靠班距會看到「≤ 93 分」）；站牌的方位在全市索引裡，也等它（不然先畫一次、索引到了又重排一次）
    if ((!state.busUpdate && !state.eta) || (!CITY && !state.cityNote) || !pl) {
      $("#posRow").hidden = true; $("#picker").hidden = true;
      setHTML("#leave", "");
      setHTML("#board", `<p class="empty">${errs.bus && errs.eta ? "連不上即時資料，按右上角重新整理" : "讀取即時資料中…"}</p>`);
      return;
    }
    const pv = placeView(pl);
    $("#posRow").hidden = !pv.cur;
    setHTML("#posRow", pv.cur ? posRowHTML(pv) : "");
    setHTML("#leave", pv.cur ? leaveHTML(pv, now) : "");
    // 越快到的越上面（規則在 core.arrivalOrder）。「全部」也是整個一起排，不分候車位置，每一列自己寫在哪裡等
    const byUnit = new Map(pv.rows.map((r) => [r.it.unit, r])), listId = pv.cur ? pl.id + "|" + pv.cur.id : "";
    const mins = Object.fromEntries(pv.rows.map((r) => [r.it.unit, shownMin(r.arr[0], now)]));
    // 有一列展開著、或手指正按在清單上：先不換順序（要按的那一列跑掉就按錯了）
    const sameList = lastOrder.id === listId, before = lastOrder.units;
    const order = C.arrivalOrder([...byUnit.keys()], mins, sameList ? before : null, !!state.openRow || pressing);
    lastOrder = { id: listId, units: order };
    const board = $("#board"), reordered = sameList && before.length > 0 && before.join("\n") !== order.join("\n");
    const tops = reordered && canMove() ? new Map([...board.querySelectorAll("[data-row]")].map((b) => [b.dataset.row, b.closest(".rt").getBoundingClientRect().top])) : null;
    // 最快到的那一列外框加深：確定有車的（依班距的那一筆不算）裡面分鐘數最小的；一樣的話是排在上面的那一列
    const sure = order.filter((u) => mins[u] != null && !byUnit.get(u).arr[0].upper);
    const hot = sure.find((u) => mins[u] === Math.min(...sure.map((x) => mins[x])));
    setHTML("#board", order.map((u) => routeRowHTML(byUnit.get(u), now, u === hot)).join("") +
      (!pv.cur ? `<p class="empty">${esc(state.cityNote || "找不到這個站名的站牌")}</p>` : ""));
    if (tops) slideRows(board, tops);
    if (!sameList && lastNums.id) { fadeIn(board, 8); fadeIn($("#leave"), 8); }      // 換了地點或候車位置：整份清單淡進來
    flipNumbers(board, listId);
    if (state.openRow && state.openRow !== lastOpenShown) { const b = [...board.querySelectorAll("[data-row]")].find((x) => x.dataset.row === state.openRow); fadeIn(b && b.closest(".rt").querySelector(".rt-more"), -6); }
    lastOpenShown = state.openRow;
    renderPick(pv, pl, now);
  }
  /** 關注或取消一條路線（選路線面板裡的開關、展開列裡的「不再關注」）。 */
  function toggleWatch(unit) {
    const pl = currentPlace();
    if (!pl) return;
    const at = placeView(pl).cur;
    if (at) setPos(pl.id, at.id);                         // 還沒自己選過位置時看的是「第一個有關注路線的位置」；關注一變它可能換掉，所以先記住現在這一個
    const cur = watch[pl.id] || [], on = cur.includes(unit);
    watch[pl.id] = on ? cur.filter((u) => u !== unit) : [...cur, unit];
    saveWatch();
    state.openRow = null;
    if (!on) ensureRoute(unit.split("|")[0]);
    compute(); render();
  }
  function setPlace(id) {
    state.place = id;
    state.openRow = null; state.pick = false; state.posMenu = false; state.filter = ""; $("#flt").value = "";
    const pl = currentPlace();
    if (pl && !pl.temp) ls.set("bus:placeId", pl.id);     // 臨時的站不記成預設
    compute(); render();
    if (state.tab === "map") focusPlace();
  }
  /**
   * 打開一個站名：是常用站（或存起來的站）就切過去，不是就當成臨時站。unit＝從路線頁選來的（路線、方向），順便關注。
   * 站名只差括號、合成同一個地點的（板橋夜市(南雅南路)、板橋夜市(縣民大道)）：打開哪一個都是同一個地點；
   * 已經存起來的用當初存的那個站名當編號，新開的用那一組的代表站名（sibKey）。
   */
  function openStop(name, unit) {
    const cfg = A.places.find((p) => namesOf(p).includes(name));
    const had = cfg ? null : saved.find((n) => sibNames(n).includes(name)) || (state.temp && sibNames(state.temp).includes(name) ? state.temp : null);
    const key = had || sibKey(name), names = cfg ? namesOf(cfg) : sibNames(key);
    const id = cfg ? "cfg:" + cfg.name : "stop:" + key, keep = !!cfg || saved.includes(key);
    if (!keep) {
      if (state.temp && state.temp !== key && !saved.includes(state.temp)) delete watch["stop:" + state.temp];      // 臨時站一次只留一個
      state.temp = key; ls.set("bus:temp", key);
    }
    if (watch[id] === undefined) {
      // 第一次打開這個站：把別的站已經關注、這裡也有停的路線先帶進來（使用者 10/4：不要每到一個站都重新選一次）
      const here = placePoles({ id, names }).flatMap((p) => p.items.map((it) => it.unit));
      watch[id] = C.carryOver(watch, here, unit || null);
      for (const u of watch[id]) ensureRoute(u.split("|")[0]);
    } else if (unit) {
      const cur = watch[id];
      if (!cur.includes(unit)) watch[id] = keep ? [...cur, unit] : [unit, ...cur];      // 臨時站：剛選的排最上面
      ensureRoute(unit.split("|")[0]);
    }
    saveWatch();
    state.routePage = null; state.q = ""; $("#q").value = "";
    if (unit) {                                           // 從路線頁選來的：直接看它停的那個候車位置
      const at = placePositions({ id, names }).find((x) => x.items.some((it) => it.unit === unit));
      if (at && posSel[id] !== ALL) setPos(id, at.id);      // 這個站看的是「全部」就留在「全部」（新關注的那一條會出現在它的位置底下）
    }
    setTab("wait");
    setPlace(id);
    $("#view-wait").scrollTop = 0;
  }
  function saveTemp() {
    if (!state.temp) return;
    if (!saved.includes(state.temp)) saved.push(state.temp);
    ls.set("bus:saved", saved);
    ls.set("bus:placeId", "stop:" + state.temp);
    state.temp = null; ls.set("bus:temp", null);
    render();
  }
  function dropStop(name) {
    saved = saved.filter((n) => n !== name); ls.set("bus:saved", saved);
    if (state.temp === name) { state.temp = null; ls.set("bus:temp", null); }
    delete watch["stop:" + name];
    delete posSel["stop:" + name]; ls.set("bus:pos", posSel);
    saveWatch();
    setPlace((allPlaces()[0] || {}).id || null);
  }
  /** 定位。auto＝打開頁面時自動做的（使用者先前按過一次並同意）。 */
  function locate(auto) {
    if (!navigator.geolocation) { state.geoNote = "這個瀏覽器不支援定位"; render(); return; }
    state.geoNote = "定位中…"; state.geoErr = ""; render();
    navigator.geolocation.getCurrentPosition((p) => {
      state.me = { lat: p.coords.latitude, lon: p.coords.longitude };
      state.geoNote = `已定位・誤差約 ${Math.round(p.coords.accuracy)} m`;
      ls.set("bus:autoGeo", true);                       // 之後打開頁面自動定位
      if (auto) placeByLocation();                       // 自己按的不換地點：正在看哪裡就留在哪裡
      render();
    }, (e) => {
      state.geoNote = state.geoErr = e.code === 1 ? "沒有定位權限（到瀏覽器設定開啟）" : "定位失敗，再按一次";
      if (e.code === 1) ls.set("bus:autoGeo", false);
      render();
    }, { enableHighAccuracy: true, timeout: 10e3, maximumAge: auto ? 120e3 : 30e3 });
  }
  /** 自動定位後：人就在某個常用站旁邊就切過去；不在任何常用站附近就留在原本看的站（附近的站牌在「找公車」）。 */
  function placeByLocation() {
    const hit = allPlaces().filter((p) => !p.temp).map((p) => ({ p, d: Math.min(Infinity, ...placePoles(p).map((x) => distM(state.me, x))) }))
      .filter((x) => x.d <= PLACE_NEAR_M).sort((a, b) => a.d - b.d)[0];
    if (hit && hit.p.id !== state.place) setPlace(hit.p.id);
  }

  // ---------------------------------------------------------------- 找公車：路線號碼、站名、附近的站牌 → 選方向與站
  let recent = ls.get("bus:recent", []);
  if (!Array.isArray(recent)) recent = [];
  function pushRecent(x) {
    recent = [x, ...recent.filter((r) => !(r.k === x.k && r.name === x.name))].slice(0, 6);
    ls.set("bus:recent", recent);
  }
  const cityName = (src) => (CITY && (CITY.sources[src] || {}).name) || src;
  function renderFind() {
    const rp = CITY && state.routePage && routeByKey.has(state.routePage.key) ? state.routePage : null;
    $("#findHome").hidden = !!rp; $("#routePage").hidden = !rp;
    if (rp) { renderRoutePage(rp); return; }
    const q = state.q.trim(), box = $("#findBody");
    $("#qClear").hidden = !q;
    if (!CITY) { box.innerHTML = `<p class="empty">${esc(state.cityNote || "路線與站牌資料載入中…")}</p>`; return; }
    const stopRow = (x, right) => `<button type="button" class="pick" data-stop="${esc(x.name)}"><span><b>${esc(x.label)}</b><small>${esc(routesAt(x.plats))}</small></span><em>${esc(right)}</em></button>`;
    const routesAt = (plats) => {
      const names = [...new Set(plats.flatMap((p) => p[4].map((e) => CITY.routes[e[0]][1])))].sort(C.routeCompare);
      return `${names.slice(0, 4).join("、")}${names.length > 4 ? ` 等 ${names.length} 條` : ""}`;
    };
    if (!q) {
      const near = state.me ? C.nearestStops(CITY.plats, state.me, NEARBY_M, NEARBY_N, SIB) : null;
      box.innerHTML =
        (recent.length ? `<h2>最近找過</h2><div class="chips">${recent.map((r) => (r.k === "r"
          ? `<button type="button" data-route="${esc(r.key)}">${esc(r.name)}</button>` : `<button type="button" data-stop="${esc(r.name)}">${esc(sibLabel(r.name))}</button>`)).join("")}</div>` : "") +
        `<h2>附近的站牌${state.me ? `<button type="button" class="link" data-locate>重新定位</button>` : ""}</h2>` +
        (!near ? `<button type="button" class="leave ask" data-locate>${LOC_SVG}<span>${esc(state.geoErr || (state.geoNote === "定位中…" ? "定位中…" : "用定位找附近的站牌"))}</span></button>`
          : near.length ? `<div class="card">${near.map((x) => stopRow(x, `${Math.round(x.d)} m`)).join("")}</div>`
          : `<p class="empty">${NEARBY_M} 公尺內沒有站牌</p>`);
      return;
    }
    const rs = C.searchRoutes(CITY.routes, q, 14), ss = C.searchStops(CITY.plats, q, 6, SIB);
    box.innerHTML =
      (rs.length ? `<h2>路線</h2><div class="card">${rs.map((r) => `<button type="button" class="pick route" data-route="${esc(r[0])}">${badgeHTML(r[1], null, "sm")}` +
        `<span><b>${esc(r[4])} ↔ ${esc(r[5])}</b><small>${esc(cityName(r[2]))}</small></span><em>›</em></button>`).join("")}</div>` : "") +
      (ss.length ? `<h2>站名</h2><div class="card">${ss.map((x) => stopRow(x, "›")).join("")}</div>` : "") +
      (!rs.length && !ss.length ? `<p class="empty">找不到「${esc(q)}」。目前涵蓋${Object.values(CITY.sources).map((x) => x.name).join("、")}的路線與站牌。</p>` : "");
  }
  function routePageOf(key) {
    const rp = { key, dir: 0, file: routeFiles.get(key) || null, error: null };
    if (!rp.file) fetchRoute(key).then((f) => { rp.file = f; }, (e) => { rp.error = e.message; }).then(() => { if (state.routePage === rp) render(); });
    return rp;
  }
  function openRoute(key) {
    const r = routeByKey.get(key);
    if (!r) return;
    state.routePage = routePageOf(key);
    pushRecent({ k: "r", key, name: r[1] });
    setTab("find");
    $("#view-find").scrollTop = 0;
  }
  /** 這個方向用哪個變體的站序：名稱和路線相同的優先（其餘是繞駛、區間）。 */
  const routeVariant = (rp) => {
    const vs = rp.file.variants.filter((v) => v.direction === rp.dir);
    return vs.find((v) => v.display === rp.file.name) || vs[0] || null;
  };
  function renderRoutePage(rp) {
    const r = routeByKey.get(rp.key), box = $("#routePage"), now = nowMs();
    const head = `<div class="rp-h"><button type="button" class="btn icon" data-route-back aria-label="回到找公車" title="回到找公車"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg></button>` +
      `${badgeHTML(r[1], null)}<div><b>${esc(r[4])} ↔ ${esc(r[5])}</b><small>${esc(cityName(r[2]))}</small></div></div>`;
    if (!rp.file) { box.innerHTML = head + `<p class="empty">${rp.error ? `這條路線的資料讀不到（${esc(rp.error)}）` : "載入這條路線的站序中…"}</p>`; return; }
    const dirs = [0, 1].filter((d) => rp.file.variants.some((v) => v.direction === d));
    if (!dirs.includes(rp.dir)) rp.dir = dirs[0];
    const v = routeVariant(rp), stops = v.stops.slice(0, -1);              // 終點站只下不上
    const etaOf = (s) => {
      const n = C.officialNext(state.eta, r[3], s.id, rp.dir);
      if (n && n.ms != null) { const t = etaText({ ms: n.ms }, now); return `<em class="${t.soon ? "soon" : ""}">${t.text}</em>`; }
      return `<em class="off">${(n && CODE_TEXT[n.code]) || "—"}</em>`;
    };
    let nearest = "";
    if (state.me) {
      const best = stops.map((s, i) => ({ s, i, d: distM(state.me, s) })).sort((a, b) => a.d - b.d)[0];
      if (best && best.d <= 1000) nearest = `<button type="button" class="pick nearest" data-pick="${best.i}"><span><small>離你最近的站・${Math.round(best.d)} m</small><b>${esc(best.s.name)}</b></span>` +
        `<span class="sec-r">${etaOf(best.s)}<small>在這站等</small></span></button>`;
    }
    box.innerHTML = head +
      `<div class="seg dirs" role="group" aria-label="方向">${dirs.map((d) => `<button type="button" data-dir="${d}" aria-pressed="${d === rp.dir}">往 ${esc((rp.file.variants.find((x) => x.direction === d) || {}).toward || "")}</button>`).join("")}</div>` +
      nearest + `<p class="hint">點你要等車的站</p>` +
      `<div class="card">${stops.map((s, i) => `<button type="button" class="pick stop-pick" data-pick="${i}"><i>${i + 1}</i><b>${esc(s.name)}</b>${etaOf(s)}</button>`).join("")}` +
      `<div class="pick end"><i>${stops.length + 1}</i><b>${esc(v.stops[v.stops.length - 1].name)}</b><em class="off">終點・只下車</em></div></div>`;
  }

  // ---------------------------------------------------------------- 地圖
  let selLine = null, meMarker = null;
  const lines = {};                 // 變體 → 路線
  const stMarkers = new Map();      // 站位 → { hit, dot }
  const busMarkers = new Map();     // 車牌 → { marker, v, tw, settled, deg }
  const ll = ([lon, lat]) => [lat, lon];

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
  /** 車頭方向：取路線在該位置的走向（比 GPS 方位角穩定，停車時也不會亂轉）。0＝北，順時針。 */
  function bearingAt(v, km) {
    const k0 = Math.min(km, v.lengthKm - 0.05), a = pointAtKm(v, k0), b = pointAtKm(v, k0 + 0.05);
    const dx = (b[0] - a[0]) * Math.cos(a[1] * Math.PI / 180), dy = b[1] - a[1];
    return dx || dy ? (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360 : 0;
  }
  /** 車的標記：平常只有箭頭＋幾分後到這個地點（顏色＝路線）；選中才展開成路線名與車牌。車擠在一起時長條會疊成一團。 */
  function busIcon(v, id, deg) {
    return L.divIcon({ className: "", iconSize: [0, 0], html:
      `<div class="busm d${v.direction}" style="--c:${color[v.key]}">` +
      `<span class="arrow" style="transform:rotate(${deg}deg)"><svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5 0 9.5 10 5 7.4.5 10Z"/></svg></span>` +
      `<span class="bm"></span><span class="bv">${esc(v.display)}</span><span class="bp">${esc(id)}</span></div>` });
  }
  /** 一根站牌的副標：月台，不然「往東・民族路290號」（和等車頁的候車位置同一種寫法）。 */
  const poleWord = (key) => {
    const p = cityPlat.get(String(key));
    return (p && (p[7] || [p[5] != null && p[5] >= 0 ? "往" + C.compass8(p[5]) : "", p[6]].filter(Boolean).join("・"))) || "站牌";
  };
  function stationPopupHTML(st) {
    const now = nowMs(), arr = stationArrivals({ entries: st.entries.filter((e) => isShown(byKey.get(e.key))) }).slice(0, 4);
    return `<div class="pop"><div class="pop-h"><div><b>${esc(st.name)}</b><span class="pop-dir">${esc(poleWord(st.station))}</span></div></div>` +
      (arr.length ? `<ul class="arows">${arr.map((a) => rowHTML(a, now)).join("")}</ul>` : `<p class="empty">目前沒有車</p>`) +
      `<p class="pop-f"><button type="button" class="link" data-stop="${esc(st.name)}">到等車頁看這一站</button></p></div>`;
  }
  /** 路線與站牌的圖層：地圖建好時、之後每加一條路線時補上。 */
  function addMapLayers() {
    // 每條路線兩層：底下一圈深色的邊（放在自己的圖層，壓在所有路線顏色的下面），上面才是路線的顏色。
    // 淺色地圖上，黃、萊姆這類淺色的線沒有這圈邊幾乎看不見（黃對淺灰底的對比只有 1.15）
    for (const v of V) if (!lines[v.key]) lines[v.key] = L.layerGroup([
      L.polyline(v.shape.map(ll), { pane: "casing", color: "#251615", weight: 7, opacity: 0.3, interactive: false }),
      L.polyline(v.shape.map(ll), { color: color[v.key], weight: 4, opacity: 0.9, interactive: false })]);
    for (const st of stations.values()) {
      if (stMarkers.has(st.station)) continue;
      // 看得見的小圓不接收點擊；外面套一個看不見的大圓當點擊範圍（手指好點）
      const dot = L.circleMarker([st.lat, st.lon], { radius: 4.5, weight: 2, fillOpacity: 1, interactive: false, color: "#251615", fillColor: "#ffffff", className: "stop-dot" });
      const hit = L.circleMarker([st.lat, st.lon], { radius: 13, stroke: false, fillOpacity: 0 });
      hit.bindPopup("", { className: "stop-pop", minWidth: Math.min(300, window.innerWidth - 56), maxWidth: 340,   // 夠寬，每台車才排得成一列
        autoPanPaddingTopLeft: [12, 12], autoPanPaddingBottomRight: [12, NARROW ? 184 : 12] });                    // 手機：小視窗避開底下的清單
      hit.on("popupopen", () => {
        state.openStation = st.station; hit.setPopupContent(stationPopupHTML(st));
        if (NARROW && (state.selBus || state.sheetOpen)) { state.selBus = null; state.sheetOpen = false; render(); }      // 清單拉高時點站牌：收回去，小視窗才有地方放
      });
      hit.on("popupclose", () => { if (state.openStation === st.station) state.openStation = null; });
      stMarkers.set(st.station, { hit, dot, st });
    }
  }
  /** 把地圖對準目前的地點（手機：底下被清單蓋住一截，所以往上讓一點）。 */
  function focusPlace() {
    const pl = currentPlace(), poles = pl ? placePoles(pl) : [];
    if (!map || !poles.length) return false;
    map.setView(L.latLngBounds(poles.map((p) => [p.lat, p.lon])).getCenter(), Math.max(15, Math.min(map.getZoom() || 15, 17)), { animate: false });
    if (NARROW) map.panBy([0, 60], { animate: false });
    return true;
  }
  function ensureMap() {
    if (map) { map.invalidateSize({ pan: false }); return; }
    map = L.map("map", { zoomControl: false });
    L.control.zoom({ position: "topright" }).addTo(map);
    const casing = map.createPane("casing");                    // 路線的深色邊：在底圖之上、所有路線與標記之下
    casing.style.zIndex = 390; casing.style.pointerEvents = "none";
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, className: "night-tiles", attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> 貢獻者',
    }).addTo(map);
    // 容器可能在寬度 0 時就初始化（分頁在背景載入）：先給暫時視角，拿到有效尺寸再對準；大小一變就重算
    const fitVs = V.some(isShown) ? V.filter(isShown) : V;
    const bounds = L.latLngBounds(fitVs.flatMap((v) => v.shape.map(ll)));
    let fitted = false;
    const onSize = () => {
      const el = map.getContainer();
      if (!el.clientWidth || !el.clientHeight) return;
      map.invalidateSize({ pan: false });
      if (fitted) return;
      fitted = true;
      // 整條路線縮到看不清車：先對準目前的等車地點（周邊約 1 km）
      if (!focusPlace()) map.fitBounds(bounds, { padding: [24, 24], animate: false });
    };
    map.setView(bounds.getCenter(), 12);
    onSize();
    new ResizeObserver(onSize).observe(map.getContainer());
    addMapLayers();
    // 縮放越小標記越精簡：<13 不畫站牌、<14 車只剩箭頭
    const syncZoom = () => {
      const c = map.getContainer().classList, z = map.getZoom();
      c.toggle("zoom-far", z < 13);                                    // 看全區時不畫站牌圓點（幾百個點會蓋住路線）
      c.toggle("zoom-min", z < 14);
    };
    map.on("zoomend", syncZoom); syncZoom();
    map.getContainer().addEventListener("click", (e) => {
      const st = e.target.closest("[data-stop]");
      if (st) { openStop(st.dataset.stop); return; }
      const row = e.target.closest(".arow[data-bus]");
      if (row) selectBus(row.dataset.bus, true);
    });
    requestAnimationFrame(animate);
  }
  function setLayer(layer, on) {
    if (on && !map.hasLayer(layer)) layer.addTo(map);
    else if (!on && map.hasLayer(layer)) map.removeLayer(layer);
  }
  // ---- 車輛平滑移動：每秒約 20 次，把還在補間中的車沿路線往前挪，箭頭跟著路線走向轉
  function placeBus(e, km) {
    e.marker.setLatLng(ll(pointAtKm(e.v, km)));
    const deg = Math.round(bearingAt(e.v, km));
    if (Math.abs(((deg - e.deg + 540) % 360) - 180) >= 3) {
      const el = e.marker.getElement(), arrow = el && el.querySelector(".arrow");
      if (arrow) { arrow.style.transform = `rotate(${deg}deg)`; e.deg = deg; }
    }
  }
  let lastFrame = 0, lastSelLine = 0;
  function animate(ts) {
    requestAnimationFrame(animate);
    if (state.tab !== "map" || document.hidden || ts - lastFrame < 50) return;
    lastFrame = ts;
    const now = nowMs();
    for (const [id, e] of busMarkers) {
      if (e.settled === e.tw) continue;                          // 這段已經走完
      placeBus(e, C.tweenKm(e.tw, now));
      if (now >= e.tw.t0 + e.tw.dur) e.settled = e.tw;
      if (id === state.selBus && ts - lastSelLine > 1000) { lastSelLine = ts; updateSelLine(); }
    }
  }
  let lastHere = null;
  function renderMap() {
    if (!map) return;
    const now = nowMs(), pl = currentPlace(), pv = pl ? placeView(pl) : { secs: [], poles: [], watched: [], pos: [], cur: null };
    if (state.me) {                                              // 我的位置（定位後才有；只畫在這台裝置上）
      if (!meMarker) meMarker = L.circleMarker([state.me.lat, state.me.lon], { radius: 7, color: "#fff", weight: 2.5, fillColor: "#2563eb", fillOpacity: 1, interactive: false }).addTo(map);
      else meMarker.setLatLng([state.me.lat, state.me.lon]);
    }
    const shown = shownUnits(), on = (v) => shown.has(C.unitKey(v));
    for (const v of V) setLayer(lines[v.key], on(v));
    // 目前地點的站牌畫大一點（關注或地點有變才重設樣式）
    const hereSig = (pl ? pl.id : "") + "|" + watchRev + "|" + pv.poles.length, here = new Set(pv.poles.map((p) => p.id));
    for (const { hit, dot, st } of stMarkers.values()) {
      const vis = st.entries.some((e) => on(byKey.get(e.key)));
      setLayer(dot, vis); setLayer(hit, vis);
      if (hereSig !== lastHere) dot.setStyle(here.has(st.station) ? { radius: 8, weight: 4 } : { radius: 4.5, weight: 2 });
    }
    lastHere = hereSig;
    // 每台車幾分後到這個地點（清單與地圖上的數字用同一份）
    const busEta = new Map();
    for (const sec of pv.secs) for (const r of sec.rows) for (const a of r.arr) if (a.bus && !busEta.has(a.bus)) busEta.set(a.bus, a.ms);
    const seen = new Set();
    for (const v of V) {
      const R = state.results[v.key];
      if (!R || !on(v)) continue;
      for (const b of R.active) {
        seen.add(b.id);
        const next = v.stops.find((s) => s.km > b.km + C.P.passTolKm);
        const tip = `${esc(v.display)} 往${esc(v.toward)}・${esc(b.id)}` + (next ? `<br>下一站 ${esc(next.name)}（${Math.round((next.km - b.km) * 1000)} m）` : "");
        let e = busMarkers.get(b.id);
        if (!e || e.v !== v) {                         // 新出現，或換了子路線：直接放到定位，不做動畫
          if (e) map.removeLayer(e.marker);
          const deg = Math.round(bearingAt(v, b.km));
          e = { v, deg, tw: C.planTween(null, b.km, b.t, now), settled: null,
                marker: L.marker(ll(pointAtKm(v, b.km)), { icon: busIcon(v, b.id, deg), zIndexOffset: 500 }).addTo(map) };
          e.marker.bindTooltip(tip, { direction: "top", offset: [0, -14] });
          e.marker.on("click", () => selectBus(b.id));
          busMarkers.set(b.id, e);
        } else {
          // 沿路線從目前顯示的位置滑到最新定位（規則見 core.js planTween）；偏好減少動態效果時直接跳
          e.tw = C.planTween(REDUCED_MOTION ? null : e.tw, b.km, b.t, now);
          e.marker.setTooltipContent(tip);
        }
      }
    }
    for (const [id, e] of busMarkers) if (!seen.has(id)) { map.removeLayer(e.marker); busMarkers.delete(id); }
    if (state.selBus && !busMarkers.has(state.selBus)) state.selBus = null;      // 收班、定位中斷或不再關注
    for (const [id, e] of busMarkers) {
      const el = e.marker.getElement(), pill = el && el.querySelector(".busm");
      if (pill) {
        const ms = busEta.get(id), bm = pill.querySelector(".bm");
        const txt = ms == null || ms - now > 60 * 60e3 ? "" : ms - now < 60e3 ? "到" : String(Math.round((ms - now) / 60e3));
        if (bm.textContent !== txt) bm.textContent = txt;
        pill.classList.toggle("past", ms == null);               // 已經過了這個地點、或不會到這裡的車：淡一點
        pill.classList.toggle("sel", id === state.selBus);
      }
      e.marker.setZIndexOffset(id === state.selBus ? 900 : busEta.has(id) ? 600 : 500);
    }
    updateSelLine();
    renderSheet(pv, pl, now);
    const open = state.openStation && stMarkers.get(state.openStation);
    if (open) open.hit.setPopupContent(stationPopupHTML(open.st));
  }
  let adhocPopup = null;
  function openStationOnMap(key) {
    if (state.tab !== "map") setTab("map");
    if (NARROW && (state.selBus || state.sheetOpen)) { state.selBus = null; state.sheetOpen = false; render(); }      // 手機：清單收回去，站牌的小視窗才有地方放
    const m = stMarkers.get(key);
    if (!m || !map.hasLayer(m.hit)) {          // 沒有關注的路線會停的站牌：地圖上沒有標記，直接對準位置並標出站名
      const p = cityPlat.get(String(key)), st = stations.get(String(key));
      const at = p ? { name: p[1], lat: p[2], lon: p[3] } : st;
      if (!at || !map) return;
      map.setView([at.lat, at.lon], Math.max(map.getZoom(), 17), { animate: false });
      adhocPopup = L.popup({ className: "stop-pop", maxWidth: 300 }).setLatLng([at.lat, at.lon])
        .setContent(`<div class="pop"><div class="pop-h"><div><b>${esc(at.name)}</b><span class="pop-dir">${esc(poleWord(key))}</span></div></div>` +
          `<p class="pop-f"><button type="button" class="link" data-stop="${esc(at.name)}">到等車頁看這一站</button></p></div>`).openOn(map);
      return;
    }
    map.setView(m.hit.getLatLng(), Math.max(map.getZoom(), 16), { animate: false });
    m.hit.openPopup();
  }

  // ---- 點車（地圖上或清單裡）看它接下來各站
  function selectBus(id, reveal) {
    state.selBus = state.selBus === id && !reveal ? null : id;       // 再點一次同一台＝取消
    if (state.tab !== "map") setTab("map");                          // 先選好車再換分頁：瀏覽記錄只多一筆，按返回直接回到原本那一頁
    if (map) map.closePopup();
    render();
    const e = state.selBus && busMarkers.get(state.selBus);
    if (e && reveal) map.setView(e.marker.getLatLng(), Math.max(map.getZoom(), 15), { animate: false });
    revealSelected();
  }
  /** 選中的車若被清單蓋住，平移地圖讓它露出來（手機：移到清單上方；桌機：移到清單旁邊）。 */
  function revealSelected() {
    const e = state.selBus && busMarkers.get(state.selBus), card = $("#sheet");
    if (!e) return;
    card.style.transition = "none";                     // 清單拉高有動畫：量的是動畫結束後的位置，不是當下還在半路的位置
    const mr = map.getContainer().getBoundingClientRect(), cr = card.getBoundingClientRect();
    card.style.transition = "";
    const p = map.latLngToContainerPoint(e.marker.getLatLng());
    const x = p.x + mr.left, y = p.y + mr.top, pad = 28;
    if (x < cr.left - pad || x > cr.right + pad || y < cr.top - pad || y > cr.bottom + pad) return;     // 沒被蓋住
    const opt = { animate: !document.hidden && !REDUCED_MOTION };       // 頁面不在前景時動畫不會跑，直接移
    if (cr.width > mr.width * 0.8) map.panBy([0, y - (mr.top + (cr.top - mr.top) / 2)], opt);
    else map.panBy([x - (cr.right + 90), 0], opt);
  }
  /** 選中的車前方的路段（從它目前顯示的位置到終點）。 */
  function updateSelLine() {
    const e = state.selBus && busMarkers.get(state.selBus);
    if (!e) { if (selLine) { map.removeLayer(selLine.casing); map.removeLayer(selLine.inner); } return; }
    if (!selLine) selLine = { casing: L.polyline([], { color: "#ffffff", weight: 9, opacity: 0.45, interactive: false }),
                              inner: L.polyline([], { color: "#fff", weight: 5, opacity: 1, interactive: false }) };
    const pts = sliceShape(e.v, C.tweenKm(e.tw, nowMs()), e.v.lengthKm);
    selLine.casing.setLatLngs(pts); selLine.inner.setLatLngs(pts); selLine.inner.setStyle({ color: color[e.v.key] });
    selLine.casing.addTo(map); selLine.inner.addTo(map);
  }
  /** 選中的那台車：接下來各站。 */
  function busCardHTML(id, now) {
    const e = busMarkers.get(id), v = e.v;
    const up = C.upcomingForBus(state.results[v.key], id) || [];
    const rows = up.map((x) => {
      const stop = v.stops[x.si], a = { ms: x.ms, source: x.source, v }, early = earliestText(a, now);
      return `<li><button type="button" class="bc-stop" data-station="${esc(stKey(stop))}">` +
        `<span class="bc-name">${esc(stop.name)}${x.rank > 1 ? `<small>前面還有 ${x.rank - 1} 班</small>` : ""}</span>` +
        `<span class="bc-eta" title="${esc(srcTitle(x.source))}"><b>${etaText(a, now).text}</b>${early ? `<small>${early}</small>` : ""}</span></button></li>`;
    });
    return `<div class="bc-h"><div><span class="vchip" style="--c:${color[v.key]}">${esc(v.display)}</span><b>${esc(id)}</b>` +
      `<span class="bc-dir">往${esc(v.toward)}</span></div><button type="button" class="bc-x" aria-label="回到清單" title="回到清單">×</button></div>` +
      (rows.length ? `<p class="bc-sub">接下來 ${rows.length} 站（90 分鐘內）・點站名看那一站</p><ol class="bc-list">${rows.join("")}</ol>`
                   : `<p class="bc-sub">90 分鐘內沒有可推估的站（快到終點了）</p>`);
  }
  let lastSheetMode = "";
  /** 地圖底下的清單：這個地點關注的路線接下來的每一台車；點一列就在地圖上標出那台車。選中一台車時改列它接下來各站。 */
  function renderSheet(pv, pl, now) {
    const body = $("#sheetBody"), sel = state.selBus && busMarkers.has(state.selBus) ? state.selBus : null;
    const mode = sel ? "bus:" + sel : "list:" + (pl ? pl.id : ""), keep = mode === lastSheetMode ? body.scrollTop : 0;
    lastSheetMode = mode;
    const open = state.sheetOpen || !!sel;
    $("#view-map").classList.toggle("sheet-open", open);
    const tg = $("#sheetToggle");
    tg.setAttribute("aria-expanded", String(open));
    const here = pv.cur && pv.pos.length > 1 && pv.cur.label.length <= 5 ? pv.cur.label : "";      // 現在看的候車位置（標籤短才放得下）
    tg.innerHTML = `<i class="grip"></i><span class="sheet-t"><b>${esc(pl ? pl.name : "")}${here ? `<small>${esc(here)}</small>` : ""}</b>` +
      `<small>${sel ? "回清單" : open ? "收起" : "拉高看清單"}</small></span>`;
    if (sel) { body.innerHTML = busCardHTML(sel, now); body.scrollTop = keep; return; }
    const list = pv.secs.map((sec, i) => {
      const arr = sec.rows.flatMap((r) => r.arr.filter((a) => a.v)).sort((x, y) => x.ms - y.ms).filter((a) => a.ms - now <= 45 * 60e3).slice(0, 10);
      const title = sec === pv.cur ? "" : `<h3 class="all-g">${esc(sec.long)}</h3>`;
      return title + (arr.length ? `<ul class="arows">${arr.map((a) => rowHTML(a, now)).join("")}</ul>` : `<p class="empty">45 分鐘內沒有車</p>`);
    }).join("");
    body.innerHTML = `<div class="seg places" role="group" aria-label="地點">${placeChipsHTML(pl)}</div>` +
      (pv.watched.length ? list : `<p class="empty">這個站還沒有關注的路線</p>`);
    body.scrollTop = keep;
  }

  // ---------------------------------------------------------------- 路線條狀圖
  let rdirBy = ls.get("bus:rdir", {});                  // 路線 → 上次看的方向
  if (!rdirBy || typeof rdirBy !== "object" || Array.isArray(rdirBy)) rdirBy = {};
  let rideTo = ls.get("bus:rideTo", {});                // 路線方向 → 上次點的下車站（站牌編號）
  if (!rideTo || typeof rideTo !== "object" || Array.isArray(rideTo)) rideTo = {};
  /** 目前地點在這個路線方向上是第幾列（這個地點有站牌在這條路線上才有）；沒有回傳 -1。終點站不算（只下不上）。 */
  function mineRow(g) {
    const pl = currentPlace(), ids = new Set(pl ? placePoles(pl).map((p) => p.id) : []);
    return g.rows.findIndex((row, ri) => ids.has(String(row.key)) && ri < g.rows.length - 1);
  }
  /**
   * 從 from 列搭到 to 列要多久：兩站都有停的變體各算一次（core.rideEstimate），取最早到的那一個。
   * 回傳 { min, arriveMs, v }；沒有哪個變體兩站都停就回傳 null。
   */
  function rideOf(g, from, to, now) {
    let best = null;
    for (const v of g.vs) {
      const a = g.rows[from].by[v.key], b = g.rows[to].by[v.key];
      if (a == null || b == null || !(b > a)) continue;
      const e = C.rideEstimate(tracker, v.tid, state.results[v.key], a, b, now);
      if (!e) continue;
      const key = (x) => (x.arriveMs == null ? Infinity : x.arriveMs);
      if (!best || key(e) < key(best) || (key(e) === key(best) && e.min < best.min)) best = { ...e, v };
    }
    return best;
  }
  /** 合併後某一列（站）在這個群組裡的到站，依時刻排序。 */
  function rowArrivals(g, row) {
    const st = { entries: g.vs.filter((v) => row.by[v.key] != null).map((v) => ({ key: v.key, si: row.by[v.key] })) };
    return stationArrivals(st);
  }
  function stripArrival(a, now, cls) {
    const e = etaText(a, now), early = earliestText(a, now);
    return `<div class="arr ${cls}"><div class="eta${e.soon ? " soon" : ""}" title="${esc(srcTitle(a.source))}">${e.text}${early ? `<span class="early">${early}</span>` : ""}</div>` +
      `<div class="meta"><span class="vchip" style="--c:${color[a.v.key]}">${esc(a.v.display)}</span><span>${esc(who(a))}</span>${a.upper ? "" : `<span>${fmt(a.ms)}</span>`}</div></div>`;
  }
  function renderStrip() {
    const g = groupOf(state.group), now = nowMs();
    const before = new Map();          // 每台營運中的車畫在它下一站的上方
    for (const v of g.vs) {
      const R = state.results[v.key];
      if (!R) continue;
      for (const b of R.active) {
        const next = v.stops.findIndex((s) => s.km > b.km + C.P.passTolKm);
        if (next < 0) continue;
        const ri = g.rowOf[v.key][next];
        if (!before.has(ri)) before.set(ri, []);
        before.get(ri).push({ b, v, distM: Math.round((v.stops[next].km - b.km) * 1000) });
      }
    }
    const html = [], mine = mineRow(g), dest = mine < 0 ? -1 : g.rows.findIndex((row, ri) => ri > mine && String(row.key) === rideTo[g.id]);
    const multi = new Set(g.vs.map((v) => v.display)).size > 1;
    const rideEst = dest >= 0 ? rideOf(g, mine, dest, now) : null;
    g.rows.forEach((row, ri) => {
      for (const { b, v, distM: dm } of (before.get(ri) || []).sort((x, y) => y.distM - x.distM)) {
        html.push(`<li class="bus-row" style="--c:${color[v.key]}"><span class="rail"><span class="bdot"></span></span>` +
          `<span><button type="button" class="bus" data-bus="${esc(b.id)}" title="在地圖上看這台車">${BUS_SVG}${esc(v.display)} <span class="plate">${esc(b.id)}</span>` +
          `<span class="dist">${dm <= 80 ? "進站中" : `距下一站 ${dm} m`}</span></button></span></li>`);
      }
      const displays = [...new Set(g.vs.filter((v) => row.by[v.key] != null).map((v) => v.display))];
      const all = [...new Set(g.vs.map((v) => v.display))];
      const only = displays.length < all.length ? displays : null;
      const arr = rowArrivals(g, row);
      // 這個地點之後的站可以點：看從這裡搭過去要多久、幾點到。下車站那一列寫車程；自己這一站也寫一次（一進路線頁就看得到，不用捲到下車站）
      let ride = "";
      if (rideEst && (ri === dest || ri === mine)) {
        const e = rideEst, mins = `約 ${Math.max(1, Math.round(e.min))} 分${e.arriveMs != null ? `・${fmt(e.arriveMs)} 到` : ""}`;
        ride = `<span class="ride">${multi ? `<span class="vchip" style="--c:${color[e.v.key]}">${esc(e.v.display)}</span>` : ""}${ri === dest ? "車程" + mins : `→ ${esc(g.rows[dest].name)} ${mins}`}</span>`;
      }
      html.push(`<li class="stop${ri === mine ? " mine" : ""}${mine >= 0 && ri > mine ? " can-ride" : ""}" id="row-${ri}"${mine >= 0 && ri > mine ? ` data-ride="${esc(row.key)}"` : ""}>` +
        `<span class="rail"><span class="dot"></span></span>` +
        `<span class="sname"><b>${esc(row.name)}</b>${only ? `<span class="only-tag">只停 ${esc(only.join("、"))}</span>` : ""}${ride}</span>` +
        (arr[0] ? stripArrival(arr[0], now, "first") : `<div class="arr first"><span class="none">目前沒有車</span></div>`) +
        (arr[1] ? stripArrival(arr[1], now, "second") : `<div class="arr second"></div>`) +
        `<button type="button" class="star" data-stop="${esc(row.name)}" data-unit="${esc(C.unitKey(g.vs.find((v) => row.by[v.key] != null)))}" aria-label="到等車頁看 ${esc(row.name)}" title="到等車頁等這條路線">›</button></li>`);
    });
    $("#strip").innerHTML = html.join("");
    // 換了路線、方向或地點：把這個地點的那一站捲到看得到的地方（只做一次，之後不跟使用者自己的捲動搶）
    const sig = g.id + "|" + (currentPlace() || {}).id;
    if (sig !== lastStripSig) {
      lastStripSig = sig;
      const el = mine >= 0 ? document.getElementById(`row-${mine}`) : null;
      if (el) el.scrollIntoView({ block: "center" }); else $("#view-route").scrollTop = 0;
    }
  }
  let lastStripSig = "";
  function jumpTo(ri) {
    const el = document.getElementById(`row-${ri}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("flash"); setTimeout(() => el.classList.remove("flash"), 1600);
  }

  // ---------------------------------------------------------------- 時距圖
  function renderMarey() {
    const g = groupOf(state.group), vs = g.vs, now = nowMs();
    // 手機：圖寬跟著螢幕（字才不會被縮到看不清），時間範圍也縮短、圖拉高
    const t0 = now - (NARROW ? 15 : 40) * 60e3, t1 = now + (NARROW ? 40 : 60) * 60e3;
    const W = NARROW ? Math.max(320, Math.min(700, window.innerWidth - 24)) : 820, H = NARROW ? 520 : 460;
    const ml = NARROW ? 78 : 96, mr = 12, mt = 14, mb = 26;
    const maxKm = Math.max(...vs.map((v) => v.lengthKm));
    const x = (t) => ml + ((t - t0) / (t1 - t0)) * (W - ml - mr);
    const y = (k) => mt + (k / maxKm) * (H - mt - mb);
    const P = [`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="時間與距離圖">`];
    for (let t = Math.ceil(t0 / 900e3) * 900e3; t <= t1; t += 900e3) {
      P.push(`<line class="axis" x1="${x(t)}" x2="${x(t)}" y1="${mt}" y2="${H - mb}" stroke-opacity=".5"/><text x="${x(t)}" y="${H - 8}" text-anchor="middle">${fmt(t)}</text>`);
    }
    const v0 = vs[0];
    for (const q of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
      const s = v0.stops.reduce((a, b) => (Math.abs(b.km - q * v0.lengthKm) < Math.abs(a.km - q * v0.lengthKm) ? b : a));
      P.push(`<line class="axis" x1="${ml}" x2="${W - mr}" y1="${y(s.km)}" y2="${y(s.km)}" stroke-opacity=".35"/><text x="${ml - 6}" y="${y(s.km) + 4}" text-anchor="end">${esc(s.name.replace(/\(.*?\)|（.*?）/g, "").slice(0, NARROW ? 6 : 7))}</text>`);
    }
    for (const v of vs) {
      for (const b of tracker.buses.values()) {
        if (b.tid !== v.tid) continue;
        let seg = [], prevT = null;
        const flush = () => { if (seg.length > 1) P.push(`<polyline fill="none" stroke="${color[v.key]}" stroke-width="1.6" points="${seg.join(" ")}"/>`); seg = []; };
        for (const p of b.trace) {
          if (p.km == null || p.t < t0 || p.duty !== "1") { flush(); prevT = null; continue; }
          if (prevT != null && p.t - prevT > 3 * 60e3) flush();
          seg.push(`${x(p.t).toFixed(1)},${y(p.km).toFixed(1)}`); prevT = p.t;
        }
        flush();
      }
      const R = state.results[v.key];
      if (!R) continue;
      for (const b of R.active) {
        const pts = [[b.t, b.km]];
        R.perStop.forEach((list, si) => { const a = list.find((z) => z.bus === b.id); if (a && a.ms <= t1) pts.push([a.ms, v.stops[si].km]); });
        if (pts.length > 1) P.push(`<polyline fill="none" stroke="${color[v.key]}" stroke-width="1.4" stroke-dasharray="4 4" stroke-opacity=".8" points="${pts.map(([t, k]) => `${x(t).toFixed(1)},${y(k).toFixed(1)}`).join(" ")}"/>`);
      }
    }
    P.push(`<line class="now" x1="${x(now)}" x2="${x(now)}" y1="${mt}" y2="${H - mb}"/><text class="nowt" x="${x(now) + 4}" y="${mt + 10}">現在</text></svg>`);
    $("#marey").innerHTML = P.join("");
  }

  // ---------------------------------------------------------------- 頁首、說明、分頁
  function renderHeader() {
    const err = [errs.bus, errs.eta].filter(Boolean).join("；");
    const age = state.busUpdate ? Math.max(0, Math.round((nowMs() - state.busUpdate) / 1000)) : null;
    const when = state.busUpdate ? `${fmt(state.busUpdate)}・${age < 60 ? age + " 秒前" : Math.round(age / 60) + " 分鐘前"}` : "等待資料";
    $("#status").innerHTML = (REPLAY ? `<span class="warn">重播 ${esc(REPLAY)}（非即時）・</span>` : "") +
      (age != null && age > 60 ? `<span class="warn">資料較舊：</span>` : "") + esc(when) +
      (err ? ` <span class="err" title="${esc(err)}">連不上${state.busUpdate ? "，顯示舊資料" : ""}</span>` : "");
    document.body.classList.toggle("old-data", age != null && age > 90);        // 數字是舊的：整片變淡，不要看起來和即時的一樣可信
  }
  const familyOf = (id) => groupOf(id).family;
  /** 路線選單只列路線；方向用分頁，只有一個方向的路線不出分頁。 */
  function fillGroupSelects() {
    if (!groups.some((g) => g.id === state.group)) state.group = groups[0].id;
    const fam = familyOf(state.group), dirs = groups.filter((g) => g.family === fam);
    const opts = families.filter((f) => groups.some((g) => g.family === f)).map((f) => `<option value="${esc(f)}">${esc(f)}</option>`).join("");
    const seg = dirs.length > 1 ? dirs.map((g) => `<button type="button" data-group="${esc(g.id)}" aria-pressed="${g.id === state.group}">往 ${esc(g.vs[0].toward)}</button>`).join("") : "";
    for (const k of ["", "2"]) {
      $("#routeSel" + k).innerHTML = opts; $("#routeSel" + k).value = fam;
      $("#dirSeg" + k).innerHTML = seg; $("#dirSeg" + k).hidden = !seg;
    }
    $("#stopNames").innerHTML = groupOf(state.group).rows.map((r) => `<option value="${esc(r.name)}">`).join("");
  }
  /** 換路線：回到這條路線上次看的方向。 */
  function setFamily(fam) {
    const dirs = groups.filter((g) => g.family === fam);
    if (!dirs.length) return;
    state.group = (dirs.find((g) => g.dir === rdirBy[fam]) || dirs[0]).id;
    fillGroupSelects(); compute(); render();
  }
  function setGroup(id) {
    const g = groups.find((x) => x.id === id);
    if (!g) return;
    state.group = g.id;
    rdirBy[g.family] = g.dir; ls.set("bus:rdir", rdirBy);
    fillGroupSelects(); compute(); render();
  }
  function setTab(t) {
    state.tab = t;
    const lit = t === "marey" ? "route" : t;                    // 時距圖是從「路線」點進去的，底下亮的是路線
    for (const b of document.querySelectorAll(".tabs button")) b.setAttribute("aria-selected", String(b.dataset.tab === lit));
    for (const id of TABS) $(`#view-${id}`).hidden = id !== t;
    if (t !== "wait") { state.pick = false; state.posMenu = false; $("#picker").hidden = true; }
    if (t === "route") lastStripSig = "";                       // 每次進路線頁：先看到這個地點的那一站
    if (t === "map") ensureMap();
    if (t === "route" || t === "marey") compute();              // 這兩頁看的那一組路線不一定有人關注：切過來時算一次
    render();
  }
  function render() {
    renderHeader();
    if (state.tab === "wait") renderWait();
    else if (state.tab === "map") renderMap();
    else if (state.tab === "find") renderFind();
    else if (state.tab === "route") renderStrip();
    else renderMarey();
    syncNav();
  }

  // ---------------------------------------------------------------- 返回鍵
  // 手機按返回＝回到上一個畫面（分頁、路線頁、選中的車各算一個畫面），在最開始的畫面按返回才離開。
  // 做法：畫面變深（等車 → 其他分頁 → 路線頁或某台車）就在瀏覽記錄多記一筆；同一層換來換去只改寫當前那一筆；
  // 要回到剛才待過的畫面（按畫面上的返回、×、回等車）就真的往回走，這樣畫面上的返回和手機的返回鍵走的是同一條路。
  const snap = () => ({ tab: state.tab, route: state.tab === "find" && state.routePage ? state.routePage.key : null, bus: state.tab === "map" ? state.selBus : null,
    pick: state.tab === "wait" && state.pick });
  const sameNav = (a, b) => !!a && !!b && a.tab === b.tab && a.route === b.route && a.bus === b.bus && !!a.pick === !!b.pick;
  const depthOf = (x) => (x.tab === "wait" ? 0 : 1) + (x.route || x.bus || x.pick || x.tab === "marey" ? 1 : 0);      // 時距圖是路線分頁裡再進去的一層；選路線面板是等車頁上面的一層
  const navStack = [];              // 這次打開頁面後自己記的：記錄裡第 i 筆是哪個畫面（重新整理後前面幾筆不知道，就當作對不上）
  let navBusy = false;
  function syncNav() {
    if (navBusy) return;
    const x = snap(), cur = history.state;
    if (!cur || typeof cur.i !== "number") { navStack.length = 0; navStack[0] = x; history.replaceState({ ...x, i: 0 }, ""); return; }
    const at = cur.i;
    if (sameNav(cur, x)) { navStack[at] = x; return; }
    for (let j = at - 1; j >= 0; j--) {
      if (!sameNav(navStack[j], x)) continue;
      navBusy = true;                                        // 剛才待過這個畫面：往回走到那一筆
      history.go(j - at);
      setTimeout(() => { if (navBusy) { navBusy = false; syncNav(); } }, 800);       // 萬一沒走成（記錄和自己記的對不上），不要卡住
      return;
    }
    if (depthOf(x) > depthOf(cur)) { navStack.length = at + 1; navStack[at + 1] = x; history.pushState({ ...x, i: at + 1 }, ""); }
    else { navStack[at] = x; history.replaceState({ ...x, i: at }, ""); }
  }
  window.addEventListener("popstate", (e) => {
    const h = e.state && typeof e.state.i === "number" ? e.state : null;
    if (navBusy) {                                            // 是自己往回走的：到了；畫面已經是對的，確認這一筆寫的也是它
      navBusy = false;
      if (h && !sameNav(h, snap())) history.replaceState({ ...snap(), i: h.i }, "");
      if (h) navStack[h.i] = snap();
      return;
    }
    const x = h || { tab: "wait", route: null, bus: null, pick: false };
    if (h) navStack[h.i] = { tab: x.tab, route: x.route, bus: x.bus, pick: !!x.pick };
    navBusy = true;                                           // 套用記錄裡的畫面時不要又去改記錄
    state.selBus = x.bus || null;
    state.pick = !!x.pick; state.posMenu = false;
    state.routePage = x.route ? (state.routePage && state.routePage.key === x.route ? state.routePage : routePageOf(x.route)) : null;
    setTab(TABS.includes(x.tab) ? x.tab : "wait");
    navBusy = false;
  });

  // ---------------------------------------------------------------- 互動
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.tab === "find") state.routePage = null;         // 按分頁＝回到找公車的首頁
    setTab(b.dataset.tab);
  }));
  $("#mareyBtn").addEventListener("click", () => setTab("marey"));
  $("#mareyBack").addEventListener("click", () => setTab("route"));
  $("#onceBtn").addEventListener("click", () => { pollBuses(); pollEta(); });
  $("#placeSeg").addEventListener("scroll", (e) => syncFade(e.currentTarget), { passive: true });
  new ResizeObserver(revealChip).observe($("#placeSeg"));
  const placeClick = (e) => {
    const b = e.target.closest("button[data-place]");
    if (b) setPlace(b.dataset.place);
    return !!b;
  };
  $("#placeSeg").addEventListener("click", placeClick);
  $("#findBtn").addEventListener("click", () => { state.routePage = null; setTab("find"); });
  $("#saveTemp").addEventListener("click", saveTemp);
  $("#dropTemp").addEventListener("click", () => state.temp && dropStop(state.temp));
  $("#flt").addEventListener("input", (e) => { state.filter = e.target.value; render(); });
  $("#view-wait").addEventListener("click", (e) => {
    const t = (sel) => e.target.closest(sel);
    let x;
    if (state.posMenu && !t("[data-pos-menu]") && !t(".posmenu")) { state.posMenu = false; render(); if (!t("[data-pos]") && !t("[data-pick-open]")) return; }     // 點選單以外的地方：收起選單
    if (t("[data-pos-menu]")) { state.posMenu = !state.posMenu; return render(); }
    if ((x = t("[data-pos]"))) { setPos(state.place, x.dataset.pos); state.posMenu = false; state.openRow = null; return render(); }
    if (t("[data-pick-open]")) return openPick();
    if ((x = t("[data-unwatch]"))) return toggleWatch(x.dataset.unwatch);
    if ((x = t("[data-row]"))) { state.openRow = state.openRow === x.dataset.row ? null : x.dataset.row; return render(); }
    if (t("[data-locate]") || t("[data-relocate]")) return locate(false);
    if (t("[data-go-find]")) { state.routePage = null; return setTab("find"); }
    if ((x = t(".arow[data-bus]"))) return selectBus(x.dataset.bus, true);
  });
  $("#board").addEventListener("pointerdown", () => { pressing = true; });
  for (const ev of ["pointerup", "pointercancel"]) window.addEventListener(ev, () => { pressing = false; });
  $("#picker").addEventListener("click", (e) => {
    const t = (sel) => e.target.closest(sel);
    let x;
    if (t("[data-pick-close]")) return closePick();
    if ((x = t("[data-pos]"))) { setPos(state.place, x.dataset.pos); render(); $("#pickList").scrollTop = 0; return; }
    if ((x = t("[data-watch]"))) return toggleWatch(x.dataset.watch);
    if ((x = t("[data-unsave]"))) return dropStop(x.dataset.unsave);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (state.pick) closePick();
    else if (state.posMenu) { state.posMenu = false; render(); }
  });
  $("#q").addEventListener("input", (e) => { state.q = e.target.value; renderFind(); });
  $("#q").addEventListener("keydown", (e) => { if (e.key === "Enter") e.target.blur(); });       // 按鍵盤上的「搜尋」：收起鍵盤，結果才不會被擋住
  $("#qClear").addEventListener("click", () => { state.q = ""; $("#q").value = ""; renderFind(); $("#q").focus(); });
  $("#view-find").addEventListener("click", (e) => {
    const t = (sel) => e.target.closest(sel);
    let x;
    if (t("[data-route-back]")) { state.routePage = null; return render(); }
    if ((x = t("[data-dir]"))) { state.routePage.dir = Number(x.dataset.dir); return render(); }
    if ((x = t("[data-pick]"))) {
      const rp = state.routePage, s = routeVariant(rp).stops[Number(x.dataset.pick)];
      return openStop(s.name, `${rp.key}|${rp.dir}`);
    }
    if ((x = t("[data-route]"))) return openRoute(x.dataset.route);
    if ((x = t("[data-stop]"))) { pushRecent({ k: "s", name: x.dataset.stop }); return openStop(x.dataset.stop); }
    if (t("[data-locate]")) return locate(false);
  });
  // 清單的標題列：點一下切換；也可以用手指上下滑（往上＝拉高，往下＝收起並回到清單）
  let sheetDrag = null, sheetSwiped = false;
  $("#sheetToggle").addEventListener("pointerdown", (e) => { sheetDrag = e.clientY; e.currentTarget.setPointerCapture(e.pointerId); });
  $("#sheetToggle").addEventListener("pointerup", (e) => {
    const dy = sheetDrag == null ? 0 : e.clientY - sheetDrag;
    sheetDrag = null;
    if (Math.abs(dy) < 24) return;                        // 沒滑多遠：當成點一下，交給 click
    sheetSwiped = true;
    setTimeout(() => { sheetSwiped = false; }, 400);       // 觸控滑動之後不會有 click，旗標自己清掉
    if (dy < 0) state.sheetOpen = true; else { state.sheetOpen = false; state.selBus = null; }
    render();
  });
  $("#sheetToggle").addEventListener("click", () => {
    if (sheetSwiped) { sheetSwiped = false; return; }     // 滑鼠拖完放開會多一個 click：不要再切一次
    if (state.selBus) state.selBus = null; else state.sheetOpen = !state.sheetOpen;
    render();
  });
  $("#sheetBody").addEventListener("click", (e) => {
    if (placeClick(e)) return;
    if (e.target.closest(".bc-x")) { state.selBus = null; render(); return; }
    const st = e.target.closest(".bc-stop");
    if (st) { openStationOnMap(st.dataset.station); return; }
    const row = e.target.closest(".arow[data-bus]");
    if (row) selectBus(row.dataset.bus, true);
  });
  $("#strip").addEventListener("click", (e) => {
    const st = e.target.closest("[data-stop]");
    if (st) { openStop(st.dataset.stop, st.dataset.unit); return; }
    const bus = e.target.closest(".bus[data-bus]");
    if (bus) { selectBus(bus.dataset.bus, true); return; }
    const row = e.target.closest(".stop[data-ride]");      // 這個地點之後的站：點一下看車程，再點一下收起來
    if (row) {
      const g = groupOf(state.group);
      if (rideTo[g.id] === row.dataset.ride) delete rideTo[g.id]; else rideTo[g.id] = row.dataset.ride;
      ls.set("bus:rideTo", rideTo);
      render();
    }
  });
  for (const k of ["", "2"]) {
    $("#routeSel" + k).addEventListener("change", (e) => setFamily(e.target.value));
    $("#dirSeg" + k).addEventListener("click", (e) => { const b = e.target.closest("[data-group]"); if (b) setGroup(b.dataset.group); });
  }
  $("#find").addEventListener("change", (e) => {
    const q = e.target.value.trim(), rows = groupOf(state.group).rows;
    let ri = rows.findIndex((r) => r.name === q);
    if (ri < 0) ri = rows.findIndex((r) => r.name.includes(q));
    if (q && ri >= 0) jumpTo(ri);
  });
  document.addEventListener("visibilitychange", startPolling);

  async function boot() {
    if (REPLAY) {
      try { await initReplay(); } catch (e) { errs.bus = "重播資料讀不到：" + e.message; }
    }
    restore();
    ensureWatchedRoutes();
    compute();
    if (!params.get("group")) {                                      // 路線頁：回到這條路線上次看的方向
      const fam = familyOf(state.group), g = groups.find((x) => x.family === fam && x.dir === rdirBy[fam]);
      if (g) state.group = g.id;
    }
    fillGroupSelects();
    const h = history.state;                                        // 重新整理：回到原本那個分頁（網址有指定分頁就照網址）
    if (h && typeof h.i === "number" && TABS.includes(h.tab) && !params.get("tab")) {
      state.tab = h.tab;
      if (h.route) state.routePage = routePageOf(h.route);
    }
    setTab(state.tab);
    startPolling();
    loadCity();
    if (!REPLAY && ls.get("bus:autoGeo", false)) locate(true);     // 按過一次「定位」並同意之後，每次打開自動定位
  }
  boot();
  setInterval(() => { if (!document.hidden) { compute(); render(); } }, 5e3);
  window.__busApp = { state, tracker, A, V, groups, stations, stMarkers, busMarkers, unitsOf, loaded, get watch() { return watch; }, get map() { return map; }, get city() { return CITY; },
    get posSel() { return posSel; }, helpers, placeView, allPlaces, currentPlace, openStop, openRoute, ensureRoute, motion, flipNum };   // 除錯用
}
startApp();
