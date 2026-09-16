/**
 * ZCode TPS Footer v1.0.4 —— 输入框工具栏统计胶囊（无常驻服务）
 * 当前会话最近一轮: ● 时间 · 首 token Xs · X tok/s · out X（生成中实时刷新）
 *
 * 数据源: 页面内 MessagePort 会话事件流（preload 转交的 zcode:service-port）
 *   - conversation 行事件: turnHeader / userInput / reasoning / assistantText / row.delta(文本增量)
 *   - version:1 事件流: usage.delta(精确 usage，每次模型请求完成时发) / stream.chunk(首块+心跳)
 * 指标口径:
 *   - 流式中 tok/s 与 out 为估算(CJK 1 字≈1 token、其余 4 字符≈1 token)，4s 滑动窗口即时速度；
 *     usage.delta 到达后用精确值覆盖。轮结束后为精确值(精确 out ÷ 首块→末次 usage 解码窗口)。
 *   - 工具执行等静默期速度保持最近值；点停止/出错未报 usage 时 out 以内容估算兜底；
 *     同一 turnId 复用(编辑重发/重试)时自动清零旧统计。
 *   - 缓存命中率采用官方推送的真值：conversation 状态 usage.contextWindow.cache
 *     (state.updated/snapshot 帧)，显示会话累计平均 hitRate=ΣcacheRead÷Σinput(分母
 *     含缓存写+读)，与官方「平均缓存命中率」面板同源同值、最多 1 位小数(整数不带 .0)。
 *     仅当真值尚未到达时才退回本地 ΣcacheRead÷Σinput 累计估算；注意 inputTokens 已
 *     包含 cacheRead，分母不得再叠加，否则 95% 会被算成 ~49%。
 * 渲染: 只认「DOM 可见轮次 + data-session-id 匹配当前会话」，切换会话立即消失；
 *       数据未变零 DOM 写，避免 MutationObserver 自激。任何异常静默，绝不影响主界面。
 */
(() => {
  if (window.__ztps) return;
  window.__ztps = true;
  const dec = new TextDecoder();
  const MARK = "data-ztps";

  const turns = new Map();          // turnId(msg_xxx) -> 轮统计
  const firstChunkByScid = {};
  const rowTurn = new Map();        // rowId -> turnId（row.delta 增量归属）
  const respTurn = new Map();       // assistantResponseId -> turnId（stream.chunk 的 assistantMessageId 归属）
  const scidTurn = new Map();       // sourceCommandId -> turnId（usage.delta 关联兜底）
  const official = new Map();       // sessionId -> {cache, at} 官方推送的 contextWindow.cache 真值
  const sessUsage = { inputTokens: 0, cacheReadTokens: 0, requests: 0 };   // 兜底累计(真值未到达前用)

  const get = (id) => {
    if (!turns.has(id)) turns.set(id, {
      msgId: id, sourceCommandId: null, sessionId: null,
      startedAt: null, endedAt: null, activeMs: null,
      firstChunkAt: null, rowFirstAt: null, lastUsageAt: null,
      outputTokens: 0, inputTokens: 0, cacheReadTokens: 0, totalTokens: 0,
      textTok: 0, win: [], modelId: null, streaming: false,
    });
    return turns.get(id);
  };

  // 轮复用（编辑重发/重试复用同一 turnId）时清空上一轮统计，避免旧值残留到新轮
  function resetTurnStats(t) {
    t.endedAt = null; t.activeMs = null;
    t.firstChunkAt = null; t.rowFirstAt = null; t.lastUsageAt = null;
    t.outputTokens = 0; t.inputTokens = 0; t.cacheReadTokens = 0; t.totalTokens = 0;
    t.textTok = 0; t.win = []; t.lastTps = null; t.streaming = true;
  }

  // token 粗估：CJK 字符 1 字 ≈ 1 token，其余 4 字符 ≈ 1 token
  const estTok = (s) => {
    let n = 0;
    for (let i = 0; i < s.length; i++) n += s.charCodeAt(i) > 0x2e7f ? 1 : 0.25;
    return Math.round(n);
  };

  const pushWin = (t, ts, tok) => {
    t.win.push([ts, tok]);
    const floor = ts - 6000;
    while (t.win.length > 2 && t.win[0][0] < floor) t.win.shift();
  };

  function onRow(row) {
    if (!row) return;
    if (row.op === "row.delta") { onRowDelta(row); return; }
    if (!row.turnId) return;
    const t = get(row.turnId);
    if (row.rowId != null) rowTurn.set(row.rowId, row.turnId);
    if (row.kind === "turnHeader") {
      if ((t.endedAt != null || t.lastUsageAt != null) && row.startedAt && row.startedAt !== t.startedAt) resetTurnStats(t);
      t.startedAt = row.startedAt ?? t.startedAt;
      t.endedAt = row.endedAt ?? t.endedAt;
      t.activeMs = row.activeMs ?? t.activeMs;
      t.streaming = row.state != null && !/^(completedSuccess|completed|failed|stopped|cancelled)/.test(row.state);
      if (row.sourceCommandId) t.sourceCommandId = row.sourceCommandId;
      scan();
    } else if (row.kind === "userInput") {
      if ((t.endedAt != null || t.lastUsageAt != null) && row.createdAt && row.createdAt !== t.startedAt) resetTurnStats(t);
      t.startedAt = row.createdAt ?? t.startedAt;
      t.streaming = true;
      if (row.sourceCommandId) t.sourceCommandId = row.sourceCommandId;
      scan();
    } else if (row.kind === "reasoning" || row.kind === "assistantText") {
      if (row.assistantResponseId) respTurn.set(row.assistantResponseId, row.turnId);
      if (row.text && row.text.length) t.textTok = estTok(row.text);   // 全量覆盖，防增量累计漂移
      if (t.firstChunkAt == null && t.rowFirstAt == null && row.createdAt) {
        t.rowFirstAt = row.createdAt;   // 兜底首块（优先 stream.chunk）
      }
    }
  }

  function onRowDelta(row) {
    if (row.path !== "text" || !row.append) return;
    const turnId = rowTurn.get(row.rowId);
    if (!turnId) return;
    const t = turns.get(turnId);
    if (!t) return;
    t.textTok += estTok(row.append);
    pushWin(t, Date.now(), t.textTok);
  }

  function onEvent(ev) {
    if (!ev || ev.version !== 1) return;
    const scid = ev.sourceCommandId;
    if (ev.kind === "usage.delta") {
      if (!scid) return;
      const t = findByScid(scid) || turns.get(scidTurn.get(scid));
      if (!t) return;
      t.outputTokens += ev.outputTokens || 0;
      t.inputTokens += ev.inputTokens || 0;
      t.cacheReadTokens += ev.cacheReadTokens || 0;
      t.totalTokens += ev.totalTokens || 0;
      sessUsage.inputTokens += ev.inputTokens || 0;
      sessUsage.cacheReadTokens += ev.cacheReadTokens || 0;
      sessUsage.requests += 1;
      t.modelId = ev.modelId || t.modelId;
      t.sessionId = ev.sessionId || t.sessionId;
      t.lastUsageAt = ev.occurredAt ?? t.lastUsageAt;
      if (t.firstChunkAt == null && firstChunkByScid[scid] != null) {
        t.firstChunkAt = firstChunkByScid[scid];
      }
      scan();
    } else if (ev.kind === "stream.chunk") {
      if (firstChunkByScid[scid] == null) firstChunkByScid[scid] = ev.occurredAt;
      let t = findByScid(scid);
      if (!t && ev.assistantMessageId) {
        const tid = respTurn.get(ev.assistantMessageId);
        if (tid) { t = turns.get(tid); if (t && scid) scidTurn.set(scid, tid); }
      }
      if (!t && scid && scidTurn.has(scid)) t = turns.get(scidTurn.get(scid));
      if (!t) return;
      if (t.firstChunkAt == null) t.firstChunkAt = firstChunkByScid[scid];
      t.sessionId = ev.sessionId || t.sessionId;
      t.streaming = true;   // turnHeader 未到时也标记生成中
      pushWin(t, ev.occurredAt || Date.now(), t.textTok);   // 心跳采样，保证窗口时间轴连续
    }
  }

  const findByScid = (scid) => {
    for (const t of turns.values()) if (t.sourceCommandId === scid) return t;
    return null;
  };

  // 官方真值：usage.contextWindow.cache 与「上下文容量」面板同源
  // (胶囊取 hitRate=会话累计平均；latestHitRate=最近一次请求命中率备用；均为 0-1 小数)
  function absorbOfficial(sessionId, usage) {
    const c = usage && usage.contextWindow && usage.contextWindow.cache;
    if (!c || !Number.isFinite(c.hitRate)) return;
    official.set(sessionId ?? null, { cache: c, at: Date.now() });
  }

  function handleFrame(data) {
    try {
      let d = data;
      if (d == null) return;
      if (d instanceof ArrayBuffer) d = new Uint8Array(d);
      if (!ArrayBuffer.isView(d)) return;
      const txt = dec.decode(d);
      const i = txt.indexOf("{");
      if (i < 0) return;
      const j = JSON.parse(txt.slice(i));
      if (j.version === 1) { onEvent(j); return; }
      if (j.type === "state.updated") absorbOfficial(j.sessionId ?? null, j.patch && j.patch.usage);
      absorbOfficial(j.sessionId ?? null, j.snapshot && j.snapshot.usage);
      const payload = j.frame && j.frame.payload;
      if (!payload) return;
      absorbOfficial(j.sessionId ?? null, payload.snapshot && payload.snapshot.usage);
      const evs = payload.events || payload.deltas || [];
      for (const e of evs) {
        if (e.op === "state.updated") { absorbOfficial(j.sessionId ?? null, e.patch && e.patch.usage); continue; }
        if (e.row) onRow(e.row);
        else if (e.op === "row.appended" || e.op === "row.upserted" || e.op === "row.delta") onRow(e.row || e);
      }
    } catch (err) { /* 静默 */ }
  }

  // ---------- 格式化 ----------
  const fmtLat = (ms) => {
    const s = Math.max(0, (ms || 0) / 1000);
    return (s < 10 ? String(+s.toFixed(1)) : String(Math.round(s))) + "s";
  };
  const fmtTps = (v) => (v >= 10 ? String(Math.round(v)) : String(+Number(v || 0).toFixed(1)));
  const fmtTok = (v) => {
    if (v < 1e3) return String(v);
    const trim = (n) => String(+n.toFixed(n < 10 ? 1 : 0));
    if (v < 1e6) return trim(v / 1e3) + "k";
    if (v < 1e9) return trim(v / 1e6) + "m";
    return trim(v / 1e9) + "b";
  };
  const fmtStamp = (ms) => {
    if (ms == null) return null;
    const d = new Date(ms), now = new Date();
    const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    return d.toDateString() === now.toDateString() ? hm
      : d.getFullYear() === now.getFullYear() ? `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
      : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  };

  function statsOf(t) {
    const firstAt = t.firstChunkAt ?? t.rowFirstAt ?? null;
    const ttft = firstAt != null && t.startedAt != null ? firstAt - t.startedAt : null;
    let out = t.outputTokens;
    if (out === 0 && t.textTok > 0) out = t.textTok;   // 中止/失败未报 usage：以内容估算兜底
    let tps = null;
    if (t.streaming) {
      out = Math.max(out, t.textTok);   // 流式中 usage 未到，用内容估算补齐（精确值到达后自然切换）
      const now = Date.now();
      const win = t.win.filter((w) => now - w[0] <= 4000);
      if (win.length >= 2) {
        const dt = (win[win.length - 1][0] - win[0][0]) / 1000;
        const dtok = win[win.length - 1][1] - win[0][1];
        if (dt >= 1 && dtok > 0) tps = dtok / dt;
      }
      if (tps == null && t.lastTps != null) tps = t.lastTps;   // 工具执行等静默期：保持最近速度
    } else {
      const decodeFrom = firstAt ?? t.startedAt;
      const decodeMs = decodeFrom != null && t.lastUsageAt != null ? t.lastUsageAt - decodeFrom : null;
      tps = t.outputTokens > 0 && decodeMs > 500 ? t.outputTokens / (decodeMs / 1000) : null;
      if (tps == null && t.lastTps != null) tps = t.lastTps;
    }
    if (tps != null) t.lastTps = tps;
    // 命中率真值：优先官方面板同源数据(按轮次所属会话取，未关联时取最近更新的)；真值未到达才用本地累计兜底
    let oc = t.sessionId != null ? official.get(t.sessionId) : null;
    if (!oc) for (const v of official.values()) if (!oc || v.at > oc.at) oc = v;
    // 展示口径：会话累计平均命中率(hitRate)，与官方「平均缓存命中率」面板同源同值；最多 1 位小数(整数不带 .0)
    const ocHit = oc && Number.isFinite(oc.cache.hitRate) ? oc.cache.hitRate : null;
    const cache = Number.isFinite(ocHit) ? Math.round(ocHit * 1000) / 10
      : sessUsage.inputTokens > 0 ? Math.round(sessUsage.cacheReadTokens * 1000 / sessUsage.inputTokens) / 10 : null;
    return {
      stamp: fmtStamp(t.endedAt || t.startedAt), ttft, tps, out, cache,
      streaming: t.streaming,
    };
  }

  const hasActivity = (t) => t.streaming || t.textTok > 0 || t.outputTokens > 0;

  // ---------- 渲染 ①: 输入框工具栏中央（当前会话最近一轮） ----------
  function findToolbarRow() {
    const ta = document.querySelector("[data-testid='v4-composer-input']");
    if (!ta) return null;
    const card = ta.closest("form") ? ta.closest("form").parentElement : ta.parentElement;
    if (!card) return null;
    for (const el of card.querySelectorAll("div")) {
      const c = el.className || "";
      if (/flex[^"]*items-end/.test(c) && (el.textContent || "").includes("完全访问")) return el;
    }
    return null;
  }

  function renderBar() {
    try {
      const row = findToolbarRow();
      if (!row) {
        // 找不到工具栏行（新建任务空态/设置页等）时清掉已注入的 host，杜绝旧内容残留
        document.querySelectorAll("[data-ztps-bar]").forEach((el) => el.remove());
        return;
      }
      // 只认当前会话 DOM 里可见的轮次——切走后旧统计不再展示。
      // 当前会话 id 从 DOM 的 data-session-id 读取（激活 tab 即变，多会话并行互不干扰，reload 后立即可用）
      let domSess = null;
      document.querySelectorAll("[data-session-id]").forEach((el) => {
        if (!domSess && el.offsetParent != null) domSess = el.getAttribute("data-session-id");
      });
      if (!domSess) {
        const el = document.querySelector("[data-session-id]");
        if (el) domSess = el.getAttribute("data-session-id");
      }
      const visible = new Set();
      document.querySelectorAll("section[data-turn-id]").forEach((el) => visible.add(el.getAttribute("data-turn-id")));
      let latest = null;
      for (const t of turns.values()) {
        if (!visible.has(t.msgId)) continue;
        // 轮次归属会话与当前显示会话不符时排除（会话切换的 DOM 中间态残留兜底）
        if (t.sessionId && domSess && t.sessionId !== domSess) continue;
        if (!latest || (t.startedAt ?? 0) > (latest.startedAt ?? 0)) latest = t;
      }
      // 胶囊可能挂在子容器内部（✨增强按钮旁），去重须在整行范围内找，否则每秒复制
      let host = row.querySelector("[data-ztps-bar]");
      // 无可见轮次 → 不展示；轮次无时间戳但仍在生成/有内容 → 显示（省略时间段）；完全无数据防假时钟。
      // 仅在 host 已存在时移除，绝不走「先创建再删除」，否则 MutationObserver 会自激
      if (!latest || (!hasActivity(latest) && latest.endedAt == null && latest.startedAt == null)) {
        if (host) host.remove();
        return;
      }
      if (!host) {
        host = document.createElement("div");
        host.setAttribute("data-ztps-bar", "1");
        Object.assign(host.style, {
          display: "inline-flex", alignItems: "center", gap: "6px",
          flex: "0 1 auto",
          minWidth: "0",
          maxWidth: "50%",
          alignSelf: "center",
          fontSize: "12px", height: "24px", userSelect: "none",
          fontVariantNumeric: "tabular-nums",
          whiteSpace: "nowrap", overflow: "hidden",
          borderRadius: "999px",
          background: "color-mix(in oklab, var(--color-foreground) 7%, transparent)",
          border: "1px solid var(--color-border, transparent)",
          padding: "0 12px",
        });
        // 挂到中组容器末尾（「完全访问 ▾」之后）；✨ 存在时保持 [✨, 胶囊] 顺序
        let mid = null;
        for (const el of row.children) {
          if ((el.textContent || "").includes("完全访问")) { mid = el; break; }
        }
        if (!mid) {
          row.insertBefore(host, row.children[1] || null);
        } else {
          const enh = mid.querySelector("#zcode-enhance-btn");
          if (enh) {
            if (enh.nextSibling !== host) mid.insertBefore(host, enh.nextSibling);
          } else if (host.parentNode !== mid) {
            mid.appendChild(host);
          }
        }
      }
      host.style.alignSelf = "center";
      host.style.marginLeft = "8px";
      row.style.alignItems = "center";
      const s = statsOf(latest);
      // 内容签名：未变化时只做溢出复查（零 DOM 写），避免 MutationObserver 自激
      const key = [s.stamp, s.ttft, s.tps, s.out, s.cache, s.streaming].join("|");
      let segs = host._zsegs;
      if (host._zkey !== key) {
        host._zkey = key;
        host.style.background = "color-mix(in oklab, var(--color-foreground) 7%, transparent)";
        host.style.border = "1px solid var(--color-border, transparent)";
        host.style.padding = "0 12px";
        host.style.color = "var(--color-foreground-subtle, #7a7a7a)";
        host.innerHTML = "";
        const ACCENT = "var(--color-warning, #e0983a)";
        const VALUE = "var(--color-foreground, #e8e8e8)";
        const span = (txt, cls) => {
          const sp = document.createElement("span");
          sp.textContent = txt;
          if (cls === "ACCENT") sp.style.color = ACCENT;
          else if (cls === "VALUE") sp.style.color = VALUE;
          return sp;
        };
        // 绿点常驻：生成中发亮，空闲静态
        const dot = span("●");
        dot.style.color = "#4ade80";
        if (s.streaming) dot.style.textShadow = "0 0 6px rgba(74,222,128,.8)";
        host.appendChild(dot);
        // 定位：原生右下角已展示上下文水位，此处只放本轮性能指标
        segs = [];
        if (s.stamp != null) segs.push({ p: 0, nodes: [span(s.stamp)] });
        if (s.ttft != null && s.ttft >= 0) segs.push({ p: 1, nodes: [span("首 token "), span(fmtLat(s.ttft), "VALUE")] });
        if (s.tps != null) segs.push({ p: 2, nodes: [span(fmtTps(s.tps) + " tok/s", "ACCENT")] });
        if (s.out > 0) segs.push({ p: 3, nodes: [span("out "), span(fmtTok(s.out), "VALUE")] });
        if (s.cache != null) segs.push({ p: 4, nodes: [span("缓存 "), span(s.cache + "%", "VALUE")] });
        segs.forEach((g, i) => {
          if (i > 0) {
            const sep = span("·");
            sep.style.opacity = "0.55";
            g.nodes.unshift(sep);   // 分隔符跟段一起，降级时同生共死
          }
        });
        segs.forEach((g) => g.nodes.forEach((n) => host.appendChild(n)));
        host._zsegs = segs;
      }
      // 渐进降级：溢出时按优先级丢段（out → tok/s）；窗口尺寸变化时也复查
      try {
        for (const drop of [4, 3, 2]) {
          if (host.scrollWidth <= host.clientWidth + 1) break;
          const g = segs.find((x) => x.p === drop);
          if (!g) continue;
          g.nodes.forEach((n) => n.remove());
        }
      } catch (err) { /* 静默 */ }
    } catch (err) { /* 静默 */ }
  }

  // ---------- 渲染 ②: 清理历史遗留的逐轮统计行（统计只在工具栏展示） ----------
  function removeLegacyFooters() {
    try {
      document.querySelectorAll(`[${MARK}]:not([data-ztps-bar])`).forEach((el) => el.remove());
    } catch (err) { /* 静默 */ }
  }

  function scan() {
    renderBar();
    removeLegacyFooters();
  }

  function start() {
    setInterval(scan, 1000);   // 流式估算 1s 刷新节奏
    try {
      let lastSync = 0;
      const mo = new MutationObserver(() => {
        // DOM 一变立即同步刷新，切换会话零残留；16ms 节流防回放风暴
        const now = performance.now();
        if (now - lastSync > 16) { lastSync = now; renderBar(); }
        clearTimeout(mo._t);
        mo._t = setTimeout(scan, 60);
      });
      mo.observe(document.body, { childList: true, subtree: true });
    } catch (err) { /* 静默 */ }
    scan();
  }
  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start);

  // ---------- 端口获取 ----------
  function hookPort(port) {
    if (!port || port.__ztps) return;
    port.__ztps = true;
    port.addEventListener("message", (ev) => handleFrame(ev.data));
    port.start();
    window.__ztpsPort = port;   // 调试用：暴露端口供旁路监听原始帧
  }
  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (d === "zcode:service-port" || (d && d.type === "zcode:scoped-service-port")) {
      if (e.ports && e.ports[0]) hookPort(e.ports[0]);
    }
  }, true);

  window.__ztpsTurns = turns;
  window.__ztpsSessionUsage = sessUsage;   // 调试用：本地兜底累计(仅真值未到达时使用)
  window.__ztpsOfficial = official;        // 调试用：官方推送的 contextWindow.cache 真值(按 sessionId)
  window.__ztpsHook = hookPort;   // 调试用：热注入时可对存量端口手动补挂
})();
