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
    // 段速用卡爾曼濾波（v3.8）。10/3 兩段記錄量到：同一個分段上，相隔 3 分鐘的兩台車步調差多少（半方差 4.7），和相隔一小時的（5.1）
    // 幾乎一樣——前一台車在這一段跑多快，多半是它自己的運氣（紅燈、靠站），不是路況在變；穩定的是各分段自己的平均（有站、有紅燈的本來就慢）。
    // 所以把同一段看過的每一台車平均起來，不是只信最新的那一台；沒看過、或太久沒車經過，就往預設車速靠。
    paceVar: 6,                      // 一個分段真正的步調偏離預設車速多少（變異數，(分/公里)²）：量到的「分段之間」的變異
    paceNoise: 4.7,                  // 單一台車在一個分段的雜訊（變異數）：同一段、相隔 5 分鐘內兩台車的半方差
    paceTauMin: 60,                  // 沒有新的車經過時多久退回預設車速（分鐘）。白天長一點準、夜間短一點準，60 是兩邊都顧到的
    ownSpeedWindowMin: 5,            // 自身均速取最近幾分鐘
    // 沒有任何速度資料時（剛打開頁面、前面沒有車跑過）的預設車速。10/3（六）重播、完全沒有歷史時的非官方推估：
    //   白天 09–11 時 18→14 km/h：10–20 分 MAE 3.3→2.5、20–40 分 6.7→4.0；深夜 22–00 時 18→17：2.1→2.0、3.4→3.2
    //   平日尖峰沒有記錄，可能更慢（未驗證）
    defaultKmh: 17,                  // 夜間（dayStartH～dayEndH 以外）
    defaultKmhDay: 14,               // 白天
    dayStartH: 7, dayEndH: 21,       // 白天的範圍（假設值：只有上午與深夜兩段記錄，分界沒有資料支撐）
    minKmh: 8, maxKmh: 40,
    paceCoverageMin: 0.6,            // 前車段速涵蓋率低於這個就標成均速／預設
    physMaxKmh: 50,                  // 官方預估若比這個速度還快才做得到，就判定指的是別台車
    physMinKmh: 5,                   // 官方預估若慢到低於這個速度（且超過 slowFloorMin），也判定指的是別台車
    slowFloorMin: 5,                 //   （10/3 驗證：官方說 10–30 分、實際 0–3 分到的案例，換算時速多在 1–4 km/h）
    horizonMin: 90,                  // 只推算到這麼遠的未來
    speedFreshS: 45,                 // 每台車的「現在時速」：定位超過這麼久沒更新就不寫
    speedMaxKmh: 110,                //   超過這個速度當成壞值不寫
    siblingM: 200,                   // 站名只差括號的兩個站，最近的站牌相隔這麼近才算同一個地點（約走 3 分鐘；見 stopGroups）
    siblingShare: 0.5,               //   兩邊都停的（路線、方向）占較少那一邊的比例到這麼高，就當成沿線的前後兩站，不合
    originKm: 0.5,                   // 起點附近：有車停在這裡就不再用班表補同一班
    originMatchMin: 12,              // 起點附近的車對到 ±12 分內最近的班表發車時刻
    traceKeepMin: 180,
    helperKeepMin: 10,               // 幫手路線（只拿來量段速、不上畫面）的車，軌跡只留這麼久：夠算段速就好，省記憶體
    gapResetMin: 4,                  // 相鄰定位間隔超過這個就不算段速
    maxBinMin: 5,                    // 單一 0.2 km 分段最多算 5 分鐘
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
  /**
   * 預估到站的索引。routeIds 不給就全部收（站牌看板要查任何路線）。
   *   map：    "routeId|goBack|stopId" → 秒數或負的代碼
   *   byStop： "routeId|stopId" → [秒數或代碼, goBack]
   * 這個檔的 GoBack 不是站牌的方向，而是「下一班車現在在哪」：0／1＝正在跑去程／返程，2＝尚未發車，3＝末班已駛離。
   * 所以 GoBack 與站牌方向相同＝下一班就在這個方向上（map 用這個鍵，對到後方最近的車）；
   * 不同＝那班車還沒開始跑這個方向（尚未發車，或還在對向那一趟），仍可能有預估秒數（byStop 查得到）。
   * 站牌編號每條路線每個方向各自獨立，所以「路線|站牌」不會重複（10/4 兩市實測）。
   */
  function indexEta(blob, routeIds) {
    const want = routeIds ? new Set(routeIds.map(String)) : null;
    const map = new Map(), byStop = new Map();
    for (const r of blob.BusInfo || []) {
      if (want && !want.has(String(r.RouteID))) continue;
      const sec = Number(r.EstimateTime);
      map.set(`${r.RouteID}|${r.GoBack}|${r.StopID}`, sec);
      byStop.set(`${r.RouteID}|${r.StopID}`, [sec, String(r.GoBack)]);
    }
    return { map, byStop, updateMs: parseTpe((blob.EssentialInfo || {}).UpdateTime) };
  }
  /**
   * 把幾個來源（台北市、新北市）的預估到站併成一份。各來源的更新時刻差幾秒，
   * 所以把秒數都換算成「從最新那份的更新時刻起算」；負的代碼（未發車、末班已過）原樣保留。
   * 兩市的路線編號與站牌編號互不重複（建置時檢查），鍵不會相撞。
   */
  function mergeEta(list) {
    const ok = list.filter((e) => e && Number.isFinite(e.updateMs));
    if (!ok.length) return null;
    const ref = Math.max(...ok.map((e) => e.updateMs));
    const map = new Map(), byStop = new Map();
    for (const e of ok) {
      const lag = (ref - e.updateMs) / 1000;
      const adj = (sec) => (sec >= 0 ? Math.max(0, sec - lag) : sec);
      for (const [k, sec] of e.map) map.set(k, adj(sec));
      for (const [k, [sec, gb]] of e.byStop || []) byStop.set(k, [adj(sec), gb]);
    }
    return { map, byStop, updateMs: ref };
  }
  /**
   * 一根站牌上某條路線的官方下一班（不需要載入那條路線的資料）。stopDir 是這根站牌在該路線上的方向。
   * 回傳 {ms, onLeg}＝預估到站時刻；onLeg 為 false 表示那班車還沒開始跑這個方向（尚未發車，或還在對向那一趟）。
   *      {code}＝-1 尚未發車、-2 交管不停靠、-3 末班車已過、-4 今日未營運；沒有資料回傳 null。
   */
  function officialNext(eta, routeId, stopId, stopDir) {
    const x = eta && eta.byStop && eta.byStop.get(`${routeId}|${stopId}`);
    if (!x || Number.isNaN(x[0])) return null;
    return x[0] >= 0 ? { ms: eta.updateMs + x[0] * 1000, onLeg: x[1] === String(stopDir) } : { code: x[0] };
  }

  // ---------------------------------------------------------------- 全市索引：附近站牌、搜尋
  /** 兩點距離（公尺）。 */
  function distM(a, b) {
    return Math.hypot((a.lat - b.lat) * 110540, (a.lon - b.lon) * 111320 * Math.cos(a.lat * Math.PI / 180));
  }
  /**
   * 離 me 最近的站牌，依距離排序。plats 是全市索引的站牌列 [編號, 站名, 緯度, 經度, 停靠]。
   * 對向站牌常只差 20–30 公尺、站名也不一定相同，定位分不出來，所以不替使用者挑方向，照距離全列。
   */
  function nearestPlatforms(plats, me, maxM, limit) {
    const out = [];
    for (const p of plats) {
      if (Math.abs(p[2] - me.lat) > 0.02 || Math.abs(p[3] - me.lon) > 0.02) continue;      // 先用經緯度粗篩（約 2 km）
      const d = distM(me, { lat: p[2], lon: p[3] });
      if (d <= maxM) out.push({ plat: p, d });
    }
    out.sort((a, b) => a.d - b.d);
    return out.slice(0, limit);
  }
  /** 路線搜尋：名稱含關鍵字。開頭相符的排前面，其中名稱短的優先（完全相符自然最前）。routes 是索引的路線列 [鍵, 名稱, ...]。 */
  function searchRoutes(routes, q, limit) {
    const k = String(q || "").trim().toLowerCase();
    if (!k) return [];
    const rank = (n) => (n.startsWith(k) ? 0 : 1);
    return routes.filter((r) => r[1].toLowerCase().includes(k))
      .sort((a, b) => rank(a[1].toLowerCase()) - rank(b[1].toLowerCase()) || a[1].length - b[1].length || a[1].localeCompare(b[1], "zh-Hant"))
      .slice(0, limit);
  }
  /**
   * 站名搜尋：同名的站牌歸在一起（一個站名通常有兩個方向以上的站牌）；給了 groups（stopGroups 的結果）時，合成同一個地點的幾個站名算一筆——
   * 其中一個站名符合就列出來，站牌是整組的。回傳 [{name, label, plats}]：name＝打開這個站用的站名（一組的代表），label＝畫面上寫的。
   */
  function searchStops(plats, q, limit, groups) {
    const k = String(q || "").trim().toLowerCase();
    if (!k) return [];
    const of = (n) => (groups && groups.get(n)) || { key: n, label: n };
    const hit = new Set();
    for (const p of plats) if (p[1].toLowerCase().includes(k)) hit.add(of(p[1]).key);
    const by = new Map();
    for (const p of plats) {
      const g = of(p[1]);
      if (!hit.has(g.key)) continue;
      if (!by.has(g.key)) by.set(g.key, { name: g.key, label: g.label, plats: [] });
      by.get(g.key).plats.push(p);
    }
    const rank = (n) => (n.startsWith(k) ? 0 : 1);
    return [...by.values()]
      .sort((a, b) => rank(a.label.toLowerCase()) - rank(b.label.toLowerCase()) || a.label.length - b.label.length || a.label.localeCompare(b.label, "zh-Hant"))
      .slice(0, limit);
  }

  /** 附近的站：把同名的站牌（給了 groups 時是同一個地點的站牌）歸成一筆，依最近那根站牌的距離排序。回傳 [{name, label, d, plats}]。 */
  function nearestStops(plats, me, maxM, limit, groups) {
    const by = new Map();
    for (const x of nearestPlatforms(plats, me, maxM, Infinity)) {
      const g = (groups && groups.get(x.plat[1])) || { key: x.plat[1], label: x.plat[1] };
      if (!by.has(g.key)) by.set(g.key, { name: g.key, label: g.label, d: x.d, plats: [] });
      by.get(g.key).plats.push(x.plat);
    }
    return [...by.values()].slice(0, limit);
  }

  // ---------------------------------------------------------------- 站名只差括號的站：合成一個地點
  /** 站名拆成括號前面的字與括號裡的字：「新北板橋公車站(新府路)」→ ["新北板橋公車站", "新府路"]；沒有括號 → [站名, ""]。全形括號也認得。 */
  function splitStopName(n) {
    const m = /^(.+?)\s*[(（]([^)）]+)[)）]$/.exec(n);
    return m ? [m[1], m[2]] : [n, ""];
  }
  /**
   * 站名只差括號的站，夠近就算同一個地點（使用者 2026-10-06：板橋公車站與板橋公車站(新府路) 那樣的站，其他地方也自動合起來）。
   * 兩個站名要在同一組，三件事都要成立，而且是和那一組裡的每一個站名比（只和其中一個比的話，臺北車站的七個站名會一個接一個串成 700 公尺長）：
   *   括號前面的字相同；
   *   最近的兩根站牌相隔 maxM 公尺以內；
   *   不是沿線的前後兩站：兩邊都停的（路線、方向）不到較少那一邊的 maxShare（自強隧道與自強隧道(大直教會)：24 條裡 22 條兩站都停）。
   * 從最近的一對開始合；距離一樣照站名排，所以結果和站牌的順序無關。
   * plats：全市索引的站牌 [編號, 站名, 緯度, 經度, [[路線序號, 方向, …]…], …]
   * 回傳 Map：站名 → { key, label, names }（同一組的站名拿到同一個物件；沒有合的站名不在裡面）。
   *   key  ＝代表這一組的站名：照站名排最前面的那個（沒有括號的那個在這一組裡的話就是它）。
   *   label＝畫面上叫什麼：括號前面的字（「板橋夜市」）。同一個括號前面還有另一組、或沒括號的那個站名自己是另一個站，
   *         就把這一組括號裡的字列出來（「臺北車站(重慶・開封)」），不然兩個地點會同名。
   */
  function stopGroups(plats, maxM = P.siblingM, maxShare = P.siblingShare) {
    const by = new Map(), fam = new Map(), out = new Map();
    for (const p of plats) {
      if (!by.has(p[1])) {
        by.set(p[1], { at: [], units: new Set() });
        const b = splitStopName(p[1])[0];
        if (!fam.has(b)) fam.set(b, []);
        fam.get(b).push(p[1]);
      }
      const x = by.get(p[1]);
      x.at.push({ lat: p[2], lon: p[3] });
      for (const e of p[4] || []) x.units.add(e[0] + "|" + e[1]);
    }
    for (const [base, names] of fam) {
      if (names.length < 2) continue;
      names.sort();
      const near = (a, b) => Math.min(...by.get(a).at.flatMap((x) => by.get(b).at.map((y) => distM(x, y))));
      const share = (a, b) => {
        const A = by.get(a).units, B = by.get(b).units, n = Math.min(A.size, B.size);
        return n ? [...A].filter((u) => B.has(u)).length / n : 0;
      };
      const pairs = [], fits = new Set();
      for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
        const a = names[i], b = names[j], d = near(a, b);
        pairs.push({ a, b, d });
        if (d <= maxM && share(a, b) < maxShare) fits.add(a + "\n" + b);
      }
      const fit = (x, y) => fits.has(x < y ? x + "\n" + y : y + "\n" + x);
      pairs.sort((x, y) => x.d - y.d || (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : 1));
      let groups = names.map((n) => [n]);
      for (const { a, b } of pairs) {
        const ga = groups.find((g) => g.includes(a)), gb = groups.find((g) => g.includes(b));
        if (ga === gb || !ga.every((x) => gb.every((y) => fit(x, y)))) continue;
        ga.push(...gb);
        groups = groups.filter((g) => g !== gb);
      }
      const multi = groups.filter((g) => g.length > 1);
      for (const g of multi) {
        g.sort();                                                    // 沒括號的那個站名在這一組裡的話，一定排最前面（它是其他站名的開頭）
        const plain = g[0] === base, only = multi.length === 1 && !by.has(base);
        const group = { key: g[0], label: plain || only ? base : `${base}(${g.map((n) => splitStopName(n)[1]).join("・")})`, names: g };
        for (const n of g) out.set(n, group);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- 站牌的行車方位、關注的單位
  const COMPASS = ["北", "東北", "東", "東南", "南", "西南", "西", "西北"];
  /** 方位角（0＝北、90＝東，順時針）→ 八方位。 */
  function compass8(deg) { return COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8]; }
  /** 兩個方位角差幾度（0–180）。 */
  function headingDiff(a, b) { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }
  /** 月台名 → 編號（「第三月台」→ 3、「第12月台」→ 12）；不是月台名回傳 null。排序用。 */
  function bayNo(bay) {
    const m = /^第([一二三四五六七八九十]+|\d+)月台$/.exec(bay || "");
    if (!m) return null;
    if (/^\d/.test(m[1])) return Number(m[1]);
    const d = (c) => "一二三四五六七八九".indexOf(c) + 1, s = m[1], i = s.indexOf("十");
    if (i < 0) return s.length === 1 ? d(s) : null;
    if (i !== s.lastIndexOf("十") || i > 1 || s.length - i > 2) return null;
    return (i === 0 ? 1 : d(s[0])) * 10 + (i === s.length - 1 ? 0 : d(s[i + 1]));
  }
  /** 幾個方位角的平均（整數度）。繞一圈的地方要用向量平均：350 與 10 的平均是 0，不是 180。 */
  function meanHeading(hs) {
    let x = 0, y = 0;
    for (const h of hs) { x += Math.sin(h * Math.PI / 180); y += Math.cos(h * Math.PI / 180); }
    return ((Math.round(Math.atan2(x, y) * 180 / Math.PI) % 360) + 360) % 360;
  }
  /**
   * 一個地點的候車位置：把同名的站牌分成「人站在同一處等」的幾組。
   * 兩根站牌要併在同一組，下面五件事都要成立，而且是和那一組裡的每一根比（只和其中一根比的話，一長排站牌會一路串下去）：
   *   行車方位差 45 度以內、相隔 80 公尺以內（沒給座標就不比距離）、
   *   沒有哪條路線去程停這一根而返程停另一根（那是馬路兩側、或折返點的兩根，方位算出來可能很接近）、
   *   地址寫的月台不同也不併（板橋公車站的四個月台出站都往西北、彼此相隔十幾公尺）、
   *   站名不同也不併（一個地點可以包含幾個站名：板橋公車站＋板橋公車站(新府路)。新府路那一根離第三月台 70 公尺、方位只差 14 度，
   *   原本被併進第三月台，577 就被寫成在第三月台搭——使用者 2026-10-05 回報）。
   * 方位不明的站牌自己一組。站牌先照編號排再分，所以結果和傳入的順序無關。
   * poles: [{id, heading（度；不明給 null）, lat, lon, bay, addr, name（站名，可不給）, units: ["路線鍵|方向"…]}]
   * 回傳 [{id, ids, heading, bay, addr, label, long}]，順序固定：站名沒有多出一段的先（見 nameTags），同一個站名裡月台照編號、
   *   其餘照方位（北、東北…西北），方位不明的最後。
   *   label＝分頁上的短標籤：月台名；不然「往東」（同一個站名只有一組往東才用）；不然短地址。
   *         站名多出一段的（新府路）：那個站名只有一個位置就寫「新府路」，不只一個就寫「新府路 往西北」。
   *   long ＝選單與標題用的完整寫法：月台名，或「往東・民族路290號」；站名多出一段的寫在最前面（「新府路・往西北・板橋火車站西側門」）。
   */
  /**
   * 一個地點包含幾個站名時，每個站名多出來的那一段：括號前面都一樣就取括號裡的字（「新北板橋公車站(新府路)」→「新府路」，
   * 沒有括號的那個是空字串）；括號前面不一樣就用整個站名。只有一個站名時都是空字串。回傳「站名 → 那一段」的函式。
   */
  function nameTags(names) {
    const split = splitStopName;
    const same = names.every((n) => split(n)[0] === split(names[0])[0]);
    return (n) => (names.length < 2 || !n ? "" : same ? split(n)[1] : n);
  }
  function positions(poles) {
    const num = (p) => (/^\d+$/.test(String(p.id)) ? Number(p.id) : Infinity);
    const uniq = [...new Map(poles.map((p) => [String(p.id), p])).values()]
      .sort((a, b) => num(a) - num(b) || String(a.id).localeCompare(String(b.id)));
    const flip = (u) => { const i = u.lastIndexOf("|"); return u.slice(0, i + 1) + (u.slice(i + 1) === "0" ? "1" : "0"); };
    const facing = (a, b) => { const B = new Set(b.units || []); return (a.units || []).some((u) => B.has(flip(u))); };
    const fits = (g, p) => g.every((q) => q.heading != null && headingDiff(q.heading, p.heading) <= 45 &&
      (q.lat == null || p.lat == null || distM(q, p) <= 80) && !facing(q, p) && !(q.bay && p.bay && q.bay !== p.bay) &&
      (q.name || "") === (p.name || ""));
    const tagOf = nameTags([...new Set(uniq.map((p) => p.name).filter(Boolean))]);
    const groups = [];
    for (const p of uniq) {
      const g = p.heading == null ? null : groups.find((x) => fits(x, p));
      if (g) g.push(p); else groups.push([p]);
    }
    const out = groups.map((g, i) => {
      const heading = g[0].heading == null ? null : meanHeading(g.map((p) => p.heading));
      const bay = (g.find((p) => p.bay) || {}).bay || "", no = bayNo(bay);
      const word = heading == null ? "" : compass8(heading);
      return { id: String(g[0].id), ids: g.map((p) => String(p.id)), heading, bay, addr: (g.find((p) => p.addr) || {}).addr || "", word, tag: tagOf(g[0].name),
               rank: no != null ? no : bay ? 99 : 100 + (word ? COMPASS.indexOf(word) : 50), i };
    }).sort((a, b) => (a.tag > b.tag) - (a.tag < b.tag) || a.rank - b.rank || a.i - b.i);
    const count = (k, v) => out.filter((x) => x[k] === v).length;
    out.forEach((x, n) => {
      const way = x.word ? "往" + x.word : "", mates = out.filter((y) => y.tag === x.tag);                 // mates＝同一個站名的位置
      const own = x.bay || (way && mates.filter((y) => !y.bay && y.word === x.word).length === 1 ? way : x.addr);      // 不看站名時這個位置叫什麼
      x.long = [x.tag, x.bay || [way, x.addr].filter(Boolean).join("・")].filter(Boolean).join("・") || `站牌 ${n + 1}`;
      x.label = x.tag ? (mates.length === 1 || !own ? x.tag : `${x.tag} ${own}`) : own || x.long;
    });
    // 標籤撞在一起（兩組同一個月台名、或地址相同）：加上編號才分得出來
    for (const k of ["label", "long"]) for (const x of [...out]) if (count(k, x[k]) > 1) {
      const same = out.filter((y) => y[k] === x[k]);
      same.forEach((y, j) => { y[k] = `${y[k]} ${j + 1}`; });
    }
    for (const x of out) { delete x.rank; delete x.i; delete x.word; delete x.tag; }
    return out;
  }
  /**
   * 候車位置那一排怎麼排（順序永遠照 positions 的固定順序，不隨關注變動——分頁一換位置，手指要按的那一顆就跑掉了）：
   *   plain 只有一個位置：寫成文字，不出分頁。
   *   tabs  三個以內、標籤都短（方位或月台，5 個字以內）：每個位置一顆分頁。
   *   more  更多，而且第一個有關注路線的位置標籤短：它做成分頁，其餘收進「其他」。
   *   drop  其餘（位置很多又還沒選路線、或標籤是地址）：整個用選單，分頁放不下地址。
   * all＝要不要多一顆「全部」（這個站關注的路線不分位置列在一起）：有關注路線的位置不只一個，或使用者在這個站選過「全部」（allSel）。
   *   使用者 2026-10-05：能搭的三條車停在兩根站牌，要來回切很麻煩。有「全部」時分頁最多再放兩顆位置（加上「選路線」只排得下三顆），
   *   所以三個位置也改成「全部＋第一個有關注的＋其他」。
   * pos＝positions 的結果；watched＝有關注路線的位置編號。回傳 { mode, all, tabs: [位置…], rest: [位置…] }。
   */
  function positionBar(pos, watched, allSel) {
    const short = (p) => p.label.length <= 5, w = pos.filter((p) => watched.includes(p.id));
    const all = pos.length > 1 && (w.length > 1 || !!allSel);
    const mode = pos.length <= 1 ? "plain" : pos.length <= (all ? 2 : 3) && pos.every(short) ? "tabs" : w.length && short(w[0]) ? "more" : "drop";
    const tabs = mode === "tabs" ? pos : mode === "more" ? w.slice(0, 1) : [];
    return { mode, all, tabs, rest: mode === "more" || mode === "drop" ? pos.filter((p) => !tabs.includes(p)) : [] };
  }
  /** 關注的單位：一條路線的一個方向（同方向的繞駛、區間變體算同一個）。鍵＝「來源:主路線編號|方向」，和全市索引對得上。 */
  function unitKey(v) { return `${v.src || "tpe"}:${v.routeId}|${v.direction}`; }
  /**
   * 打開一個還沒選過路線的站：把別的站已經關注、這個站也有停的（路線、方向）先帶進來，不用重新選一次。
   * watch＝{地點: [單位…]}；here＝這個站有停的單位；first＝從路線頁選來的那一個（一定放進來、排最前面）。
   * 其餘照它們在別的站出現的先後排。
   */
  function carryOver(watch, here, first) {
    const ok = new Set(here), out = first ? [first] : [];
    for (const us of Object.values(watch)) for (const u of us) if (ok.has(u) && !out.includes(u)) out.push(u);
    return out;
  }
  /**
   * 等車頁的列照到站時間排：越快到的越上面（使用者 2026-10-05 要的；原本固定照關注的先後，只把最快的那一列外框加深）。
   * 排的是畫面上那個分鐘數，數字和上下順序才不會打架。
   * keys＝每一列的鍵，原本的順序（關注的先後）；mins＝{ 鍵: 畫面上的分鐘數 }（到站是 0；沒有車是 null 或不給）；
   * prev＝上一次畫面上的順序（第一次沒有）；hold＝有一列展開著。回傳排好的鍵。
   *   分鐘數一樣：維持上一次畫面上的上下（差不多時間到的兩台車才不會每次更新就互換），上一次沒有的照原本的順序。
   *   沒有車的排最下面，照原本的順序。
   *   hold：列沒有增減就整個照上一次的（正在看展開的明細時，列不要從手指底下跑掉）。
   */
  function arrivalOrder(keys, mins, prev, hold) {
    const was = prev || [], has = (k) => mins[k] != null;
    if (hold && was.length === keys.length && keys.every((k) => was.includes(k))) return was;
    const before = (k) => (was.includes(k) ? was.indexOf(k) : Infinity);
    const timed = keys.filter(has).sort((a, b) => mins[a] - mins[b] || before(a) - before(b));      // 都一樣的話 sort 會保留原本的順序
    return [...timed, ...keys.filter((k) => !has(k))];
  }
  /** 路線名拆成號碼與後綴（「307西藏三民」→ 307、西藏三民），牌子上分兩行寫；後綴只有一個字（265區）或沒有號碼就不拆。 */
  function splitRouteName(name) {
    const m = /^(\D{0,2}\d+[A-Z]?)(.+)$/.exec(String(name));
    return m && m[2].length > 1 ? [m[1], m[2]] : [String(name), ""];
  }
  /**
   * 替新加進來的路線挑顏色。分得清楚的顏色只有十個左右，所以要省著用：
   * 先挑「會和它出現在同一個站」的路線還沒用的（同一個站裡顏色不重複），其中挑全部路線裡用得最少的，再照 palette 的順序
   * （排前面的彼此差得最多）。同一個站把顏色都用完了，才挑那個站裡用得最少的。
   * palette＝候選顏色；nearby＝同一個站其他路線已經用的顏色；all＝所有已載入路線用的顏色（兩個都是一條路線一筆，可以重複）。
   */
  function pickColor(palette, nearby, all) {
    const count = (list, c) => list.filter((x) => x === c).length;
    const free = palette.filter((c) => !nearby.includes(c));
    const pool = free.length ? free : palette;
    const cost = (c) => (free.length ? 0 : count(nearby, c) * 1e6) + count(all, c);
    return pool.reduce((best, c) => (cost(c) < cost(best) ? c : best), pool[0]);
  }
  /**
   * 一條路線載入時，替它的每個顯示名稱決定顏色：上次用過的就沿用（重新整理、隔天再開都不變），不能沿用才用 pickColor 挑新的。
   * 路線載入的先後每次不一定一樣（使用者 2026-10-05：897 和 577 重新整理後顏色對調），所以結果不能看誰先載入。
   * 做法是還沒載入的路線，拿它記住的顏色當作已經佔著：
   *   沿用＝記住的顏色還在 palette 裡，而且同一個站沒有「排在它前面」的路線用同一個顏色。排在前面＝已經上色的（這次打開就定了，不再改），
   *         或還沒載入但關注得比它早的。所以兩條記住同一個顏色時，關注得早的留著、晚的換，和誰先載入無關。
   *         同一個站把顏色都用完了（怎麼挑都會重複）也沿用，不然第 11 個以後每次打開都重挑一次。
   *   挑新的＝同一個站別的路線現在的顏色、還沒載入的路線記住的顏色都避開（那些路線等一下會沿用），沒記過顏色的新路線才不會把別人的顏色搶走。
   * 「同一個站」＝出現在同一個地點的關注清單裡。一個顯示名稱兩個方向都有時，兩個方向各自所在的站都算。
   * route＝這條路線的變體 [{ unit, display }…]，檔案裡的順序（同一條路線有幾個顯示名稱時，排前面的先決定）；
   * watch＝{ 地點: [單位…] }，順序就是關注的先後；used＝已經載入的單位現在的顏色 { 單位: { 顯示名稱: 顏色 } }；
   * memo＝記住的顏色，形狀和 used 相同（rememberColors 寫的）。回傳 { 顯示名稱: 顏色 }。
   */
  function routeColors(palette, route, watch, used, memo) {
    const lists = Object.values(watch), routeOf = (u) => u.split("|")[0];
    const order = [...new Set(lists.flat().map(routeOf))];                // 路線，照關注的先後
    const rank = (u) => order.indexOf(routeOf(u));
    const own = new Set(route.map((x) => routeOf(x.unit))), isOwn = (u) => own.has(routeOf(u));
    const me = Math.min(...route.map((x) => rank(x.unit))), kept = (u) => memo[u] || {};
    // 別的路線的顏色（一個顯示名稱一筆）：有人關注的先照記住的，已經載入的再蓋過去、照現在的
    const others = new Map();
    for (const u of lists.flat()) if (!isOwn(u)) for (const [n, c] of Object.entries(kept(u))) others.set(n, c);
    for (const m of Object.values(used)) for (const [n, c] of Object.entries(m)) others.set(n, c);
    const out = {};
    for (const d of new Set(route.map((x) => x.display))) {
      const at = route.filter((x) => x.display === d).map((x) => x.unit);
      const mine = at.map((u) => kept(u)[d]).find((c) => c);
      const ahead = new Map(), behind = new Map();                        // 同一個站別的顯示名稱 → 顏色：排在它前面的、後面的
      for (const list of lists) {
        if (!list.some((u) => at.includes(u))) continue;
        for (const o of list) {
          if (isOwn(o)) {                                                 // 這條路線自己的其他顯示名稱：決定好的排前面，還沒輪到的照記住的排後面
            for (const x of route) if (x.unit === o) {
              if (out[x.display]) ahead.set(x.display, out[x.display]);
              else if (kept(o)[x.display]) behind.set(x.display, kept(o)[x.display]);
            }
          } else if (used[o]) for (const [n, c] of Object.entries(used[o])) ahead.set(n, c);
          else for (const [n, c] of Object.entries(kept(o))) (rank(o) < me ? ahead : behind).set(n, c);
        }
      }
      const all = new Map(others);
      for (const x of route) if (out[x.display] || kept(x.unit)[x.display]) all.set(x.display, out[x.display] || kept(x.unit)[x.display]);
      for (const m of [ahead, behind]) m.delete(d);                       // 別的路線剛好同名：顏色是照顯示名稱給的，當成同一個，不算被別人用了
      const block = [...ahead.values()], nearby = [...block, ...behind.values()];
      const full = palette.every((c) => nearby.includes(c));
      out[d] = palette.includes(mine) && (full || !block.includes(mine)) ? mine : pickColor(palette, nearby, [...all.values()]);
    }
    return out;
  }
  /**
   * 把一條路線這次用的顏色記起來，下次 routeColors 沿用。這條路線原本記的整個換掉：資料更新後改名或拿掉的顯示名稱不留著，免得一直佔著顏色。
   * 取消關注的路線不清掉：加回來還是原本的顏色。回傳新的一份，不改原本的；內容沒變時連鍵的順序都不變（呼叫的地方靠這個判斷要不要存）。
   * memo＝{ 單位: { 顯示名稱: 顏色 } }；route＝[{ unit, display }…]；colors＝routeColors 的結果。
   */
  function rememberColors(memo, route, colors) {
    const routeOf = (u) => u.split("|")[0], own = new Set(route.map((x) => routeOf(x.unit))), now = {}, out = {};
    for (const x of route) if (colors[x.display]) (now[x.unit] = now[x.unit] || {})[x.display] = colors[x.display];
    for (const [u, m] of Object.entries(memo)) { if (!own.has(routeOf(u))) out[u] = m; else if (now[u]) out[u] = now[u]; }
    for (const [u, m] of Object.entries(now)) out[u] = m;
    return out;
  }
  /**
   * 挑「幫忙量路況」的路線：別條路線的車跑過同一段路，一樣說明那一段現在好不好走，剛打開頁面、自己路線的車還沒跑過時特別有用
   * （10/3 記錄：打開後 15 分鐘內，夜間誤差少約一成、白天少 2%；開久了沒有差別）。
   * 要載入別條路線的站序才用得上，所以只挑最划算的幾條：把關注的路線拆成「相鄰兩站」，每次挑能讓最多「還不到 need 條別的路線經過」的站間段
   * 多一條的那條路線（同分時挑序號小的），挑到 limit 條或再挑也沒有幫助為止。只經過一段的路線不挑（共用路段至少要連續兩站才借得到）。
   * variants＝關注中的變體（stops[].station）；stopsAt＝站牌編號 → [[路線序號, 方向]…]（全市索引的停靠）；skip＝不要挑的路線序號。
   * 回傳路線序號，依挑中的先後。
   */
  function helperRoutes(variants, stopsAt, skip, limit, need) {
    const pairs = new Map();                             // 站間段（「甲>乙」）→ 經過它的（路線序號|方向）
    for (const v of variants) for (let i = 0; i + 1 < v.stops.length; i++) {
      const a = String(v.stops[i].station), b = String(v.stops[i + 1].station), k = a + ">" + b;
      if (pairs.has(k)) continue;
      const atB = new Set((stopsAt.get(b) || []).map(([ri, g]) => ri + "|" + g));
      pairs.set(k, new Set((stopsAt.get(a) || []).map(([ri, g]) => ri + "|" + g).filter((x) => atB.has(x))));
    }
    const covers = new Map();                            // 路線序號 → 它經過的站間段
    for (const [k, set] of pairs) for (const x of set) {
      const ri = Number(x.split("|")[0]);
      if (skip.has(ri)) continue;
      if (!covers.has(ri)) covers.set(ri, new Set());
      covers.get(ri).add(k);
    }
    const count = new Map([...pairs.keys()].map((k) => [k, 0])), out = [];
    while (out.length < limit) {
      let best = null, gain = 0;
      for (const [ri, ks] of [...covers].sort((x, y) => x[0] - y[0])) {
        if (out.includes(ri) || ks.size < 2) continue;
        const g = [...ks].filter((k) => count.get(k) < need).length;
        if (g > gain) { best = ri; gain = g; }
      }
      if (best == null) break;
      out.push(best);
      for (const k of covers.get(best)) count.set(k, count.get(k) + 1);
    }
    return out;
  }
  /** 路線名排序：數字照大小排（57 在 307 前面），不是照字元。 */
  function routeCompare(a, b) { return String(a).localeCompare(String(b), "zh-Hant", { numeric: true }); }

  // ---------------------------------------------------------------- 車輛追蹤
  /** 變體的即時資料對應鍵：車輛回報的 RouteID（子路線編號）｜GoBack（方向）。 */
  function tidOf(v) { return v.tid || `${v.subRouteId}|${v.direction}`; }

  function createTracker(variants) {
    const tracker = { byId: new Map(), bySub: new Map(), ents: [], buses: new Map() };
    addVariants(tracker, variants);
    return tracker;
  }
  /**
   * 把變體加進追蹤器（建立時用，之後使用者關注新路線時也用）。已經在裡面的變體（同一個車輛回報編號）略過；
   * 但原本是幫手、這次不是（使用者關注了它）的，改成一般路線，軌跡從此留完整的。
   * helper＝只拿它的車來量段速的幫手路線：軌跡只留 helperKeepMin 分鐘。回傳這次真的加進去的追蹤單位。
   */
  function addVariants(tracker, variants, helper) {
    const { byId, bySub, ents } = tracker, added = [];
    for (const v of variants) {
      // 一個變體可以對到多個車輛回報編號：站序相同的不同營運業者（265區 的三重、大南）是同一班車，
      // 官方預估也是整條路線共用一個數字，所以放在同一個追蹤單位裡
      const tids = v.tids && v.tids.length ? v.tids : [tidOf(v)];
      if (tids.some((tid) => byId.has(tid))) {
        if (!helper) for (const tid of tids) if (byId.has(tid)) byId.get(tid).helper = false;
        continue;
      }
      const ent = { v, tid: tids[0], tids, line: prepLine(v), bins: [], shared: [], helper: !!helper };
      ents.push(ent); added.push(ent);
      for (const tid of tids) {
        byId.set(tid, ent);
        const k = tid.split("|")[0];
        if (!bySub.has(k)) bySub.set(k, []);
        if (!bySub.get(k).includes(ent)) bySub.get(k).push(ent);
      }
    }
    // 其他變體（不限同一條路線）：記下共用路段，前車段速可以互相借用。
    // 不必比方向編號：共用路段要求「連續兩站順序相同」，對向車道的站位不同、順序也相反，自然不會配上。
    // 新加入的要和原有的互相記：原有的也能借新路線的段速。
    for (const a of ents) for (const b of ents) {
      if (a === b || (!added.includes(a) && !added.includes(b))) continue;
      const segs = sharedSegments(a.v, b.v);
      if (segs.length) a.shared.push({ ent: b, segs });
    }
    return added;
  }
  /**
   * 以 tid（「子路線｜方向」）或單獨的子路線編號找變體。
   * 有些路線每個方向各有一個子路線編號（307），有些同一個編號涵蓋兩個方向（265區）；
   * 前者車輛回報的方向欄位在總站偶爾對不上，所以編號唯一時就只認編號。
   */
  function entOf(tracker, id, goBack) {
    const k = String(id);
    if (goBack != null) {
      const hit = tracker.byId.get(`${k}|${goBack}`);
      if (hit) return hit;
    } else if (tracker.byId.has(k)) return tracker.byId.get(k);
    const list = tracker.bySub.get(k.split("|")[0]);
    return list && list.length === 1 ? list[0] : null;
  }

  /**
   * 兩個變體的共用路段：在兩邊都是「連續的兩站」、且這段長度相差 10%（或 50 m）以內。
   * 兩站之間若有任一邊多停別的站、或長度差太多（可能走不同街道），就不算共用。
   * 回傳 [{v0, v1, w0, w1}]：本變體的公里區間與對方的公里區間。
   */
  function sharedSegments(V, W) {
    const key = (s) => String(s.station || s.name);          // 內建路線的站牌編號是字串、全市路線檔是數字：比對前一律轉成字串
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
      const ent = entOf(tracker, r.RouteID, r.GoBack);
      if (!ent) continue;
      const t = parseTpe(r.DataTime);
      if (!Number.isFinite(t)) continue;
      const id = r.BusID;
      let bus = tracker.buses.get(id);
      if (!bus || bus.tid !== ent.tid) {
        bus = { id, tid: ent.tid, subRouteId: String(r.RouteID), trace: [] };     // 換了子路線或方向就重起一條軌跡
        tracker.buses.set(id, bus);
      }
      const last = bus.trace[bus.trace.length - 1];
      bus.duty = String(r.DutyStatus); bus.status = String(r.BusStatus); bus.goBack = String(r.GoBack);
      bus.carType = r.CarType == null ? "" : String(r.CarType);
      bus.speed = Number(r.Speed); bus.lon = Number(r.Longitude); bus.lat = Number(r.Latitude); bus.seenMs = t;
      if (last && last.t >= t) continue;
      const lastKm = last && last.km != null ? last.km : null;
      // 線型是「站與站之間直線」近似的路線，彎道上的車會離折線較遠，容許距離由變體自己帶
      const maxOff = ent.v.maxOffsetM || P.maxOffsetM;
      let pr;
      if (lastKm == null) pr = project(ent.line, bus.lon, bus.lat);
      else {
        // 視窗依經過時間放寬（約 42 km/h），中間斷線很久也不會把車丟掉；視窗內找不到再全線找
        const reach = Math.max(1, ((t - last.t) / 60e3) * 0.7 + 0.5);
        pr = project(ent.line, bus.lon, bus.lat, lastKm - 0.3, lastKm + reach);
        if (pr.offsetM > maxOff) pr = project(ent.line, bus.lon, bus.lat);
      }
      const km = pr.offsetM <= maxOff ? pr.km : null;
      bus.trace.push({ t, km, offsetM: pr.offsetM, duty: bus.duty });
      added++;
      if (lastKm != null && km != null && bus.duty === "1") recordCrossings(ent, bus, lastKm, last.t, km, t);
      else bus.cross = null;
    }
    const cut = nowMs - P.traceKeepMin * 60e3, cutHelper = nowMs - P.helperKeepMin * 60e3;
    for (const [id, bus] of tracker.buses) {
      const keep = (tracker.byId.get(bus.tid) || {}).helper ? cutHelper : cut;
      bus.trace = bus.trace.filter((p) => p.t >= keep);
      if (!bus.trace.length) tracker.buses.delete(id);
    }
    return added;
  }

  /**
   * 前車段速：記下車輛「越過每個分段邊界的時刻」，分段段速＝進出該分段的時間差。
   * 車停著（站上、紅燈）時位置不變，那段時間自然算進所在分段。
   * （v2.0／v2.1 用相鄰兩筆定位的移動速度，停著的時間被丟掉，推算系統性偏快；10/3 白天驗證 MAE 約減半。）
   */
  function recordCrossings(ent, bus, k1, t1, k2, t2) {
    if (t2 - t1 > P.gapResetMin * 60e3 || k2 < k1 - 0.05) { bus.cross = null; return; }   // 斷線太久或倒退：重來
    if (k2 <= k1) return;                                                    // 停著：時間累積到下一次越界
    const bin = P.binKm;
    for (let j = Math.floor(k1 / bin) + 1; j * bin <= k2; j++) {
      const tc = t1 + ((j * bin - k1) / (k2 - k1)) * (t2 - t1);
      // 起點附近不記（會含進等發車的時間）；單一分段超過上限也不記（長時間停車）
      if (bus.cross && bus.cross.j === j - 1 && (j - 1) * bin >= P.originKm) {
        const minutes = (tc - bus.cross.t) / 60e3;
        if (minutes > 0 && minutes <= P.maxBinMin) ent.bins[j - 1] = paceUpdate(ent.bins[j - 1], minutes / bin, tc);
      }
      bus.cross = { j, t: tc };
    }
  }


  /**
   * 一個分段的狀態：{ at, dev, var, last }。dev＝這一段比預設車速慢多少（分／公里，負的是比較快），var＝對 dev 多沒把握，
   * at＝最後一台車越過的時刻，last＝那台車自己的步調（除錯與測試用，推算不看它）。
   * 沒有新的車經過時，dev 以時間常數 paceTauMin 往 0 退、var 往 paceVar 回升（均值回歸）。
   */
  /** 卡爾曼更新：又有一台車以步調 z（分／公里）越過這一段。old 沒有（或是舊格式）就從「等於預設車速、變異數 paceVar」開始。 */
  function paceUpdate(old, z, t) {
    const prior = 60 / defaultKmhAt(t);
    let dev = 0, v = P.paceVar;
    if (old && old.var != null) {
      const a = Math.exp(-(t - old.at) / 60e3 / P.paceTauMin);
      dev = old.dev * a; v = old.var * a * a + P.paceVar * (1 - a * a);
    }
    const K = v / (v + P.paceNoise);                        // 增益：對現況越沒把握、單一台車的雜訊越小，越信這一台
    return { at: t, dev: dev + K * (z - prior - dev), var: v * (1 - K), last: z };
  }
  /** 這一段現在的步調（分／公里）：現在這個時段的預設車速，加上還沒退完的偏差。不會快過 maxKmh。 */
  function paceNow(x, nowMs) {
    return Math.max(60 / P.maxKmh, 60 / defaultKmhAt(nowMs) + x.dev * Math.exp(-(nowMs - x.at) / 60e3 / P.paceTauMin));
  }
  /** 直接指定一個分段在某個時刻的步調（完全確定）。測試用。 */
  function paceState(pace, atMs) { return { at: atMs, dev: pace - 60 / defaultKmhAt(atMs), var: 0, last: pace }; }

  /** 營運中、定位新鮮、在路線上、還沒到終點的車。 */
  function activeBuses(tracker, id, nowMs) {
    const ent = entOf(tracker, id);
    const out = [];
    for (const b of tracker.buses.values()) {
      if (b.tid !== ent.tid) continue;
      const p = b.trace[b.trace.length - 1];
      if (!p || p.km == null || b.duty !== "1" || b.status === "99") continue;
      if (nowMs - p.t > P.staleFixMin * 60e3) continue;
      if (p.km >= ent.line.lengthKm - P.endZoneKm) continue;
      out.push({ id: b.id, km: p.km, t: p.t, lat: b.lat, lon: b.lon, ageS: Math.max(0, (nowMs - p.t) / 1000), speed: b.speed });
    }
    return out.sort((a, b) => b.km - a.km);                  // 前面的車在前
  }

  // ---------------------------------------------------------------- 推估
  /** 白天或夜間。預設車速與「最早可能」的校準都依這個分。 */
  function periodOf(nowMs) {
    const h = tpeParts(nowMs).h;
    return h >= P.dayStartH && h < P.dayEndH ? "day" : "night";
  }
  /** 沒有任何速度資料時用的車速：白天車多、上下車的人也多，比深夜慢。 */
  function defaultKmhAt(nowMs) {
    return periodOf(nowMs) === "day" ? P.defaultKmhDay : P.defaultKmh;
  }
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
   * 從 k0 走到 k1 要幾分鐘：有車跑過的分段用濾波後的段速（paceNow），從來沒有車跑過的用 fallbackPace。
   * 共用路段上，本變體與其他變體（含幫忙量路況的別條路線）的段速取「最近有車經過的那一邊」（例：西藏車少，借用莒光剛跑過的速度）。
   * 試過把各邊合起來用（eval/candidates/core-fuse.js）：白天好 3～5%、夜間差 2～8%，沒有採用。
   * 回傳 coverage（有段速的比例）與 borrowed（其中借自其他變體的比例）。
   */
  function travelMin(ent, k0, k1, fallbackPace, nowMs) {
    if (k1 <= k0) return { min: 0, coverage: 1, borrowed: 0 };
    const fresh = (x) => x && x.var != null;                  // 舊格式（升級前存在瀏覽器裡的）沒有 var：不用
    let min = 0, covered = 0, borrowed = 0;
    for (let b = Math.floor(k0 / P.binKm); b * P.binKm < k1; b++) {
      const s = Math.max(k0, b * P.binKm), e = Math.min(k1, (b + 1) * P.binKm), len = e - s;
      let best = fresh(ent.bins[b]) ? { pace: paceNow(ent.bins[b], nowMs), at: ent.bins[b].at, own: true } : null;
      for (const sh of ent.shared || []) {
        const m = mapKm(sh.segs, (s + e) / 2);
        if (!m) continue;
        const ob = sh.ent.bins[Math.floor(m.km / P.binKm)];
        if (fresh(ob) && (!best || ob.at > best.at)) best = { pace: paceNow(ob, nowMs) * m.ratio, at: ob.at, own: false };
      }
      if (best) { min += best.pace * len; covered += len; if (!best.own) borrowed += len; }
      else min += fallbackPace * len;
    }
    return { min, coverage: covered / (k1 - k0), borrowed: borrowed / (k1 - k0) };
  }

  /**
   * 站牌前方的路況：用前車段速算「站牌前 spanKm 公里」公車實際跑多快（含靠站與紅燈）。
   * 回傳 { coverage: 有量到的比例, kmh: 只就量到的部分算出的均速 }；完全沒量到時 kmh 為 null。
   * 量到的是公車跑多慢，紅燈與壅塞分不開，所以畫面上只說「低速／停滯」，不說「壅塞」。
   */
  function roadAhead(tracker, id, stopKm, nowMs, spanKm) {
    const ent = entOf(tracker, id), span = spanKm || 2;
    const k0 = Math.max(0, stopKm - span);
    if (stopKm - k0 < 0.3) return null;                         // 起點附近沒有「前方」可言
    const tp = travelMin(ent, k0, stopKm, 0, nowMs);            // 沒量到的分段以 0 計，只算量到的部分
    if (!(tp.coverage > 0) || !(tp.min > 0)) return { coverage: tp.coverage || 0, kmh: null };
    return { coverage: tp.coverage, kmh: ((stopKm - k0) * tp.coverage) / (tp.min / 60) };
  }

  /** 目前時段的班距（只有班距表的路線）。 */
  function headwayNow(variant, nowMs) {
    const s = variant.schedule;
    if (!s || s.type !== "frequency") return null;
    const sd = serviceDay(nowMs), m = (nowMs - sd.start) / 60e3;
    const w = s.windows.find((x) => x.days.includes(sd.dayKey) && hhmmToMin(x.start) <= m && m < hhmmToMin(x.end));
    return w ? { min: w.minHeadway, max: w.maxHeadway } : null;
  }
  /**
   * 這一段營運時段的末班從起點發車的時刻（只有班距表的路線；現在不在任何時段內回傳 null）。
   * 時段一個接一個時（05:00–21:00、21:00–22:10）一路接到最後一個的結束；中間有空檔就停在空檔之前。
   */
  function serviceEndMs(variant, nowMs) {
    const s = variant.schedule;
    if (!s || s.type !== "frequency") return null;
    const sd = serviceDay(nowMs), m = (nowMs - sd.start) / 60e3;
    const today = s.windows.filter((x) => x.days.includes(sd.dayKey));
    const w = today.find((x) => hhmmToMin(x.start) <= m && m < hhmmToMin(x.end));
    if (!w) return null;
    let end = hhmmToMin(w.end);
    for (let grew = true; grew;) {
      grew = false;
      for (const x of today) if (hhmmToMin(x.start) <= end && hhmmToMin(x.end) > end) { end = hhmmToMin(x.end); grew = true; }
    }
    return sd.start + end * 60e3;
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
   * 今天（營運日）起站的末班發車時刻「HH:MM」。variants＝畫面上同一列的各個變體（同一條路線同方向的繞駛、區間）：取最晚的。
   * 有任何一個變體沒有今天的資料就回傳 null——資料不完整時寧可不顯示，免得把其中一個變體的末班當成整列的。
   * 凌晨 03:00 前的時刻是深夜那一班（00:20 比 23:50 晚；00:00 是午夜的末班，不是「沒有資料」）。
   */
  function lastDepartureToday(variants, nowMs) {
    const day = serviceDay(nowMs).dayKey;
    const late = (s) => { const m = hhmmToMin(s); return m < ROLLOVER_H * 60 ? m + 1440 : m; };
    let best = null;
    for (const v of variants || []) {
      const t = v && v.lastDeparture ? v.lastDeparture[day] : null;
      if (!/^\d{2}:\d{2}$/.test(t || "")) return null;
      if (best == null || late(t) > late(best)) best = t;
    }
    return best;
  }

  /**
   * 一個變體所有車的到站推估。
   * 回傳 { active, perStop: [[{bus, ms, source}...] 依時刻排序], headway }
   *   bus 為 null 表示官方預估指的車我們沒追蹤到，或是班表上還沒發車的車
   */
  function routeArrivals(tracker, id, eta, nowMs) {
    const ent = entOf(tracker, id);
    const v = ent.v, stops = v.stops;
    const active = activeBuses(tracker, ent.tid, nowMs);
    const perStop = stops.map(() => []);
    const officialUsed = stops.map(() => false);
    const officialAt = (s) => {
      const x = eta && eta.map.get(`${v.routeId}|${v.direction}|${s.id}`);
      return x != null && x >= 0 ? eta.updateMs + x * 1000 : null;
    };
    const horizon = nowMs + P.horizonMin * 60e3;
    const minPace = 60 / P.physMaxKmh;

    // 同一條路線、同方向的其他變體（繞駛、區間車）：官方預估是整條路線每站一個數字，不分變體。
    // 所以共用的站要看「所有變體裡」哪台車離那一站最近，這個數字說的才是它；否則同一個數字會被每個變體各領一次。
    const sibGap = new Map();          // 站牌編號 → 其他變體裡，後方最近的車離這一站幾公里（沒有車＝Infinity）
    const lowerSib = new Set();        // 排在前面的變體也有的站：沒有任何車時，「未定位」只由排最前面的變體列一次
    const myIdx = tracker.ents.indexOf(ent);
    tracker.ents.forEach((e, ei) => {
      if (e === ent || e.v.routeId !== v.routeId || e.v.direction !== v.direction) return;
      const act = activeBuses(tracker, e.tid, nowMs);
      for (const s of e.v.stops) {
        let gap = Infinity;
        for (const b of act) { const g = s.km - b.km; if (g >= P.passTolKm && g < gap) gap = g; }
        sibGap.set(s.id, Math.min(gap, sibGap.has(s.id) ? sibGap.get(s.id) : Infinity));
        if (ei < myIdx) lowerSib.add(s.id);
      }
    });
    /** 這一站的官方預估，說的是不是這個變體裡離它 gapKm 的這台車。 */
    const ownsOfficial = (s, gapKm) => {
      const sg = sibGap.get(s.id);
      return sg == null || gapKm < sg || (gapKm === sg && !lowerSib.has(s.id));
    };

    // 同一條路線上，後車在同一站不會顯示得比前車早。公車偶爾會超車，所以這條規則不會讓推估更準
    // （10/3 重播：平均誤差幾乎不變）；採用它是因為「比較遠的車反而比較早到」在畫面上互相矛盾，使用者看了不信任。
    const aheadMs = new Array(stops.length).fill(null);      // 各站：前面的車裡最晚的預測時刻（由前往後逐台更新）
    active.forEach((b, i) => {
      const kAhead = i > 0 ? active[i - 1].km : Infinity;    // 前一台車的位置
      const own = ownPace(tracker.buses.get(b.id));
      const fb = own != null ? { pace: own, src: "均速" } : { pace: 60 / defaultKmhAt(nowMs), src: "預設" };
      let anchor = { ms: b.t, km: b.km, official: false }, prev = -Infinity;
      for (let si = 0; si < stops.length; si++) {
        const s = stops[si];
        if (s.km < b.km + P.passTolKm) continue;             // 已過站
        // 這台車是該站後方最近的車 → 官方預估指的就是它；但要過物理檢查：
        // 太快（開不到）或太慢（官方多半已把它當成過站，報的是後面那台）都不採用
        const distKm = s.km - b.km;
        const off = s.km <= kAhead - P.passTolKm && ownsOfficial(s, distKm) ? officialAt(s) : null;
        const possible = off != null && off >= b.t + distKm * minPace * 60e3 - 60e3 &&
          off <= b.t + Math.max(P.slowFloorMin, distKm * (60 / P.physMinKmh)) * 60e3;
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
        if (aheadMs[si] != null) ms = Math.max(ms, aheadMs[si]);
        ms = Math.max(ms, prev); prev = ms;
        if (ms > horizon) {                                  // 這台在推估範圍內到不了：後面的車在這一站也一樣不列
          aheadMs[si] = Infinity;                            // （後車依站序走到這一站就會停，不必標更後面的站）
          break;
        }
        aheadMs[si] = ms;
        perStop[si].push({ bus: b.id, ms, source });
      }
    });

    // 官方有預估、但該站後方沒有任何追蹤中的車 → 指的是沒定位到或還沒發車的車
    const rear = active.length ? active[active.length - 1].km : Infinity;
    stops.forEach((s, si) => {
      const off = officialAt(s);
      if (!ownsOfficial(s, Infinity)) return;            // 其他變體有車在這一站後方，或同樣沒車但它排在前面：由它來列
      if (off != null && !officialUsed[si] && s.km < rear - P.passTolKm && off <= horizon) perStop[si].push({ bus: null, ms: off, source: "官方・未定位" });
    });

    // 官方有預估、但那班車還沒開始跑這個方向（尚未發車，或還在對向那一趟）：車少於兩班的站補上。
    // 逐班表的路線多半沒有班距資料可補，沒有這一筆的話，起點附近的站會整排空白。
    stops.forEach((s, si) => {
      if (perStop[si].length >= 2 || !ownsOfficial(s, Infinity)) return;
      const x = eta && eta.byStop && eta.byStop.get(`${v.routeId}|${s.id}`);
      if (!x || !(x[0] >= 0) || x[1] === String(v.direction)) return;      // 方向相同的已經在上面處理（對到車，或列未定位）
      const ms = eta.updateMs + x[0] * 1000;
      if (ms <= horizon) perStop[si].push({ bus: null, ms, source: "官方・未發車" });
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
    const fbPace = 60 / defaultKmhAt(nowMs);
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

    // 只有班距的路線：不足兩班的站補一筆「依班距」——下一班最晚在班距上限內從起點發車，再加上開到這站的時間。
    // 班距表標了 nominal 的路線（全市路線檔：班距只有路線登記的尖峰／離峰兩個數字）整個不補：用實際到站驗證，
    // 補出來的約四分之一是不存在的車、有來的也有三成比「≤」晚十幾分鐘。只有分時段的班距表（內建路線，TDX）才補。
    // 即使是後者，班距也不保證真的有車，所以另有三個條件（依 10/3 兩段記錄、68 條台北市路線的結果訂的，見 eval/headway-tail.js）：
    //   1. 這個變體現在要有車在跑。沒有任何一台車在路上的變體（調度站發車、只跑尖峰的區間車、已經收班的），補出來的八成以上是不存在的車。
    //   2. 站上唯一的那一班是官方預估、而且對不到車（未發車、未定位）時，離末班發車要超過一個班距上限才補：
    //      不到的話那一班多半就是末班，後面補的那一筆有一半以上不存在。
    //   3. 站上唯一的那一班是還停在起點的車時，離末班發車不到一個最短班距就不補（它就是末班）。
    // 收班前寧可少列一班，不能讓人等一班不存在的末班車。
    const hw = headwayNow(v, nowMs);
    if (hw && hw.max && !v.schedule.nominal && active.length) {
      const endMs = serviceEndMs(v, nowMs);
      const leftMin = endMs == null ? Infinity : (endMs - nowMs) / 60e3;      // 離末班發車還有幾分
      const atOrigin = new Set(active.filter((b) => b.km < P.originKm).map((b) => b.id));
      stops.forEach((s, si) => {
        if (perStop[si].length >= 2) return;
        const only = perStop[si][0];
        if (only && !only.bus && leftMin <= hw.max) return;
        if (only && atOrigin.has(only.bus) && leftMin < hw.min) return;
        const bound = nowMs + (hw.max + travelMin(ent, stops[0].km, s.km, fbPace, nowMs).min) * 60e3;
        const lastMs = perStop[si].length ? perStop[si][perStop[si].length - 1].ms : -Infinity;
        perStop[si].push({ bus: null, ms: Math.max(bound, lastMs + hw.min * 60e3), source: "班距", upper: true });
      });
    }

    for (const list of perStop) list.sort((a, b) => a.ms - b.ms);
    return { active, perStop, headway: headwayNow(v, nowMs) };
  }

  // ---------------------------------------------------------------- 最早可能到站
  /** 校準用的來源分組；班表與班距沒有可驗證的車，回傳 null。 */
  function calibGroup(source) {
    if (source === "官方・未發車") return null;              // 還沒發車的班次：沒有可驗證的車，不給最早時間
    if (source === "官方" || source.startsWith("官方・")) return "官方";
    if (source.startsWith("官方→")) return "官方→推算";
    if (source === "班表" || source === "班距") return null;
    return "推算";
  }
  /**
   * 這個到站時刻是不是我們自己估的——畫面上在時間前面寫「約」（使用者 2026-10-05：「官方」「推算」的標籤大家看不懂）。
   * 官方報的（含那班車還沒發車、沒有定位的那幾種）不算；依班距的寫的是「≤」，也不算。
   */
  /**
   * 這台車現在的時速在畫面上寫什麼（使用者 2026-10-08）。回傳 ""＝不寫。
   * 車輛資料的 Speed 是「GPS 速度（Km/Hr）」：回報那一刻的瞬間車速，停著就是 0（10/3 白天全市 37% 的筆數是 0）。
   * 定位超過 P.speedFreshS 秒沒更新就不寫（那是一陣子以前的速度）；超過 P.speedMaxKmh 當成壞值不寫（資料裡出現過 430）。
   * speed＝車輛資料的 Speed；ageS＝這筆定位是幾秒前的。
   */
  function speedLabel(speed, ageS) {
    const v = Number(speed);
    if (speed == null || speed === "" || !Number.isFinite(v) || v < 0 || v > P.speedMaxKmh) return "";
    if (!(ageS <= P.speedFreshS)) return "";
    return `${Math.round(v)} km/h`;
  }
  /**
   * 車輛類型在畫面上寫什麼（使用者 2026-10-08：265 有高底盤的車，想避開；用字他指定：0 一般、1 低底盤、2 大復康、3 狗狗友善）。回傳 ""＝不註記。
   * 官方定義（兩市的《Data.Taipei 平台 API 說明文件》4.2 版，BusData 的 CarType）：
   *   台北市 0＝一般、1＝低底盤、2＝大復康巴士、3＝狗狗友善專車；新北市只定義 0＝一般、1＝低底盤，所以新北市的 2、3 不註記。
   * 「一般」就是非低底盤（高底盤）。文件沒寫的值（資料裡看過 5、6）不註記。
   * src＝"tpe"／"ntpc"；carType＝車輛資料裡的 CarType。
   */
  const CAR_KINDS = { 0: "一般", 1: "低底盤", 2: "大復康", 3: "狗狗友善" };
  function carKind(src, carType) {
    const t = String(carType);
    if (!/^[0-3]$/.test(t) || ((src || "tpe") !== "tpe" && t > "1")) return "";
    return CAR_KINDS[t];
  }
  /**
   * 大數字換了：翻牌要翻哪幾格（使用者 2026-10-08：像老車站的翻牌）。回傳 [[舊, 新]…]，一格一張牌；舊與新一樣的那一格不翻。
   * 兩邊都是位數相同的數字：一位數一格，只翻有變的那幾位（12 → 11 只翻個位）。
   * 其餘（位數不同、「到站」、「≤5」、「—」、時刻）：整個當成一格一起翻。
   */
  function flapCells(was, now) {
    const a = String(was), b = String(now), digits = /^\d+$/;
    return digits.test(a) && digits.test(b) && a.length === b.length ? [...b].map((ch, i) => [a[i], ch]) : [[a, b]];
  }
  function isApprox(source) {
    return source !== "班距" && source !== "官方" && !String(source).startsWith("官方・");
  }
  /**
   * 這條路線、這個時段該用哪一張校準表：先找「路線|時段」那一格，沒有就用該時段各路線合併的表。
   * 白天與夜間、不同路線的偏差方向不一樣（10/3：白天車偏晚到、夜間偏早到），共用一張表在夜間會偏樂觀。
   * 舊格式（整份只有一張表）原樣回傳。
   */
  function calibFor(calib, family, nowMs) {
    if (!calib) return null;
    if (!calib.cells) return calib.groups ? calib : null;
    const p = periodOf(nowMs);
    return calib.cells[`${family}|${p}`] || (calib.fallback && calib.fallback[p]) || null;
  }
  /**
   * 「最早可能」到站時刻：預測時刻往前推「該來源、該預測距離下，車比預測早到的高分位數」。
   * calib 是 calibFor 挑出來的那一張表（由 eval/calibrate.js 從驗證資料產生）：{groups: {組: [{h0, h1, offsetMin, n}]}}，
   * 依「預測還有幾分鐘」分組（執行時拿不到實際到站時刻）。偏移不到 0.5 分就不顯示，回傳 null。
   */
  function earliestMs(a, nowMs, calib) {
    if (!calib || !a || a.upper) return null;
    const g = calibGroup(a.source);
    const bins = g && calib.groups[g];
    if (!bins) return null;
    const h = (a.ms - nowMs) / 60e3;
    const bin = bins.find((b) => h >= b.h0 && h < b.h1);
    if (!bin || !(bin.offsetMin >= 0.5)) return null;
    return Math.max(nowMs, a.ms - bin.offsetMin * 60e3);
  }

  /**
   * 一台車接下來各站的到站推估（從 routeArrivals 的結果挑出這台車）。
   * 回傳 [{si, ms, source, rank}]，依站序；rank＝這台車在該站是第幾班到（1＝下一班）。
   * 這台車不在營運中（已收班、定位中斷）時回傳 null。
   */
  function upcomingForBus(result, busId) {
    if (!result || !result.active.some((b) => b.id === busId)) return null;
    const out = [];
    result.perStop.forEach((list, si) => {
      const i = list.findIndex((a) => a.bus === busId);
      if (i >= 0) out.push({ si, ms: list[i].ms, source: list[i].source, rank: i + 1 });
    });
    return out;
  }

  /**
   * 從第 fromSi 站搭到第 toSi 站要多久（官方資料只有「幾分後到站」，沒有車程）。
   * 下一班會到 fromSi 的那台車若兩站都推得到：兩站的推估時刻相減，官方預估與前車段速都已經算在裡面。
   * 否則（那班車還沒發車、沒有定位、或超出推估範圍）：用前車段速走這一段，沒量到的分段用預設車速。
   * result 是同一個變體的 routeArrivals 結果。回傳 { min, bus, boardMs, arriveMs, coverage }：
   *   bus＝搭的是哪台車（用段速估的時候是 null）；coverage＝這一段有前車段速的比例（頁面開得越久越高）。
   * toSi 不在 fromSi 之後回傳 null。
   */
  function rideEstimate(tracker, id, result, fromSi, toSi, nowMs) {
    const ent = entOf(tracker, id);
    if (!ent || !(toSi > fromSi) || !ent.v.stops[toSi]) return null;
    const k0 = ent.v.stops[fromSi].km, k1 = ent.v.stops[toSi].km;
    const tp = travelMin(ent, k0, k1, 60 / defaultKmhAt(nowMs), nowMs);
    const first = result && result.perStop[fromSi] ? result.perStop[fromSi][0] : null;
    const there = first && first.bus ? result.perStop[toSi].find((a) => a.bus === first.bus) : null;
    if (there && there.ms >= first.ms) return { min: (there.ms - first.ms) / 60e3, bus: first.bus, boardMs: first.ms, arriveMs: there.ms, coverage: tp.coverage };
    const boardMs = first && !first.upper ? first.ms : null;
    return { min: tp.min, bus: null, boardMs, arriveMs: boardMs == null ? null : boardMs + tp.min * 60e3, coverage: tp.coverage };
  }

  // ---------------------------------------------------------------- 地圖上的平滑移動
  // 延遲補間：只在車「實際到過」的兩筆定位之間移動，所以畫面比實際晚約一個更新週期，但不會衝過頭再彈回來。
  const TWEEN = { minMs: 3000, maxMs: 25000, backTolKm: 0.05, jumpKm: 1.5 };

  /** 補間在 nowMs 時顯示的公里數。 */
  function tweenKm(tw, nowMs) {
    if (!tw.dur || nowMs >= tw.t0 + tw.dur) return tw.k1;
    const p = Math.max(0, (nowMs - tw.t0) / tw.dur);
    return tw.k0 + (tw.k1 - tw.k0) * p;
  }
  /**
   * 收到一台車的最新定位（newKm、定位時刻 newFixMs）時，決定接下來怎麼移動。
   * prev：這台車目前的補間 {k0, k1, t0, dur, fixMs}，沒有就傳 null。回傳新的補間。
   *   - 定位時刻沒變：照舊。
   *   - 往前：從目前顯示的位置滑到新位置，時間＝兩筆定位的時間差（夾在 3～25 秒）。
   *   - 小幅倒退（≤50 m，多半是定位抖動）：停在原地，不往回走。
   *   - 大幅倒退或一次跳超過 1.5 km（換趟、斷線後重現）：直接跳過去。
   */
  function planTween(prev, newKm, newFixMs, nowMs) {
    if (!prev) return { k0: newKm, k1: newKm, t0: nowMs, dur: 0, fixMs: newFixMs };
    if (newFixMs <= prev.fixMs) return prev;
    const shown = tweenKm(prev, nowMs);
    const d = newKm - shown;
    if (d < -TWEEN.backTolKm || d > TWEEN.jumpKm) return { k0: newKm, k1: newKm, t0: nowMs, dur: 0, fixMs: newFixMs };
    if (d <= 0) return { k0: shown, k1: shown, t0: nowMs, dur: 0, fixMs: newFixMs };
    const dur = Math.min(TWEEN.maxMs, Math.max(TWEEN.minMs, newFixMs - prev.fixMs));
    return { k0: shown, k1: newKm, t0: nowMs, dur, fixMs: newFixMs };
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

  return { P, tpeParts, serviceDay, hhmmToMin, fmtTime, parseTpe, prepLine, project, parseBlobJson, indexEta, mergeEta, officialNext,
           distM, nearestPlatforms, nearestStops, searchRoutes, searchStops, splitStopName, stopGroups,
           compass8, headingDiff, bayNo, positions, positionBar, unitKey, carryOver, arrivalOrder, splitRouteName, pickColor, routeColors, rememberColors, helperRoutes, routeCompare,
           tidOf, entOf, periodOf, defaultKmhAt, calibFor, createTracker, addVariants, sharedSegments, ingestBusData, activeBuses, paceUpdate, paceNow, paceState, travelMin, roadAhead, headwayNow, serviceEndMs, departuresToday, upcomingDepartures, lastDepartureToday, routeArrivals, mergeStops,
           calibGroup, isApprox, carKind, speedLabel, flapCells, earliestMs, upcomingForBus, rideEstimate, tweenKm, planTween };
});
