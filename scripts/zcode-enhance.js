/**
 * ZCode 增强提示词按钮 v2 —— 输入框工具栏「✨ 增强」
 * 单击：读取 composer 草稿 → 主进程改写（面板指定的模型，或自动评分链）→ 替换输入框内容，
 *       原文进入撤销栈，toast 提供一键撤销（8 秒超时）。
 * 右键：模型/模式选择面板 —— 主进程实时读 ~/.zcode/v2/config.json，列出全部启用渠道
 *       （评分排序、★当前渠道、无凭据标注）及渠道内全部模型（按 zcode.priority 降序），
 *       另提示 enhance-config.json 手动条目；顶部可切简洁/创意模式。
 *       面板指定持久化在 localStorage(zcode-enhance-model)，优先级：
 *       面板指定 > enhance-config.json 手动配置 > 渠道评分；指定的渠道/模型失效时自动回退。
 * 读写：composer 是 Lexical contenteditable（data-testid=v4-composer-input）。
 *       正常通路走编辑器模型层：根 DOM 上的 __lexicalEditor 句柄 → toJSON 读草稿、
 *       parseEditorState + setEditorState 整体替换 —— 清空旧稿与填入新稿是同一个原子状态
 *       切换，不存在「清一半 / 叠一半」的中间态，段落（换行）结构也按编辑器自身语义保留。
 *       仅当拿不到句柄或模型层写入抛错时才回退 DOM 通路，且回退里「先确认清空、再填」两步
 *       各自校验，任一步不确认就报失败走剪贴板兜底 —— 绝不把新文本叠在残留旧稿上。
 *       之所以不再默认用 execCommand(selectAll + insertText)：execCommand 的 selectAll 只把
 *       选区落到最后一段文本节点，多段草稿只会删掉最后一段，其余段落会与新内容混在一起
 *       （这正是「残留 / 覆盖」症状的来源）。
 * 兼容：旧版单参 preload 会丢弃 mode/channel/model —— 检测到即在面板与 toast 中提示重打。
 * 样式：无框、无底色的纯图标按钮（悬停浮出浅色底 + 提亮）；图标为 Gemini 式蓝→紫对角
 *       渐变描边（AI 功能通用视觉语言，去饱和适配深色主题，对比度 ≥3:1）；异常静默不影响主界面。
 */
(() => {
  if (window.__zenh) return;
  window.__zenh = true;

  const BTN_ID = "zcode-enhance-btn";
  const MODE_KEY = "zcode-enhance-mode";
  const SEL_KEY = "zcode-enhance-model";
  const MODE_LABEL = { workbuddy: "简洁模式", creative: "创意模式" };
  function getMode() {
    try { return localStorage.getItem(MODE_KEY) === "creative" ? "creative" : "workbuddy"; }
    catch (err) { return "workbuddy"; }
  }
  function toggleMode() {
    const next = getMode() === "creative" ? "workbuddy" : "creative";
    try { localStorage.setItem(MODE_KEY, next); } catch (err) { /* 静默 */ }
    toast("已切换为「" + MODE_LABEL[next] + "」" + (next === "creative" ? "（充分展开，不设字数）" : "（约 800 字符内）"), true);
  }
  function getSel() {
    try {
      const s = JSON.parse(localStorage.getItem(SEL_KEY) || "null");
      return s && s.channel && s.model ? { channel: String(s.channel), model: String(s.model) } : null;
    } catch (err) { return null; }
  }
  function setSel(s) {
    try { if (s) localStorage.setItem(SEL_KEY, JSON.stringify(s)); else localStorage.removeItem(SEL_KEY); }
    catch (err) { /* 静默 */ }
  }
  // 新版 preload 是四参转发并暴露 enhanceListModels；旧版单参只有 enhancePromptDraft。
  // 注意：enhancePromptDraft 在 renderer 侧是 ipcRenderer.invoke 返回的 Promise，其 .length 恒为 0，
  // 不能用来判断参数个数（会误报旧版）。以 enhanceListModels 是否暴露为新版判据。
  function preloadV2() {
    try { return !!(window.zcode && window.zcode.enhancePromptDraft && window.zcode.enhanceListModels); }
    catch (err) { return false; }
  }
  let busy = false;
  let lastRun = 0;         // 冷却：防双击/事件重放导致重复请求
  let undoText = null;     // 非空 = 最近一次增强前的原文，可撤销
  let undoTimer = null;

  // ---------- 工具栏行定位（与 zcode-tps.js / zcode-continue.js 同一套） ----------
  function findToolbarRow() {
    // 多级锚点：新版(u3+) 输入框在 .chat-composer-input-surface 组件内、toolbar 是
    // data-chat-toolbar-popover-trigger 按钮组；旧版是 data-testid="v4-composer-input"。
    // 全部探测，保证结构改版时功能不消失。
    const NEW_TA = [
      ".chat-composer-input-surface textarea",
      ".chat-composer-input-surface [contenteditable='true']",
      "[data-testid='chat-input']",
    ];
    const OLD_TA = "[data-testid='v4-composer-input']";
    const ta = NEW_TA.map((s) => document.querySelector(s)).find(Boolean)
      || document.querySelector(OLD_TA)
      || null;
    if (!ta) return null;
    const form = ta.closest("form");
    const scope = form ? (form.parentElement || form) : ta.parentElement;
    if (!scope) return null;
    const candidates = [];
    const collect = (n) => {
      for (const d of n.querySelectorAll("div")) { candidates.push(d); if (candidates.length > 400) return; }
    };
    collect(scope);
    for (let up = scope.parentElement, i = 0; up && i < 2; up = up.parentElement, i++) {
      collect(up);
    }
    candidates.unshift(scope);
    const scored = candidates.map((el) => {
      const text = el.textContent || "";
      const cls = String(el.className || "");
      let score = 0;
      if (/flex/.test(cls)) score += 1;
      if (/items-(end|center)/.test(cls)) score += 1;
      if (el.querySelector("button,[role='button']")) score += 2;
      if (el.querySelector(
        "[data-testid*='send'],[data-testid*='toolbar'],[data-chat-toolbar-popover-trigger='true'],#zcode-enhance-btn,#zcode-continue-btn",
      )) score += 4;
      if (text.includes("完全访问")) score += 3;
      return { el, score };
    }).filter((x) => x.score >= 3).sort((a, b) => b.score - a.score);
    return scored[0]?.el || null;
  }

  function composerEl() {
    return document.querySelector(".chat-composer-input-surface textarea,.chat-composer-input-surface [contenteditable='true'],[data-testid='chat-input'],[data-testid='v4-composer-input']");
  }

  function readDraft() {
    const el = composerEl();
    if (!el) return "";
    const dom = el.textContent || "";
    const ed = lexEditor(el);
    if (ed) {
      // 模型层读出的文本带真实段落换行，DOM 的 textContent 是段落拼接（无分隔）——两者只差空白，
      // 归一后应一致；不一致说明草稿里有本函数不认识的节点（如 mention），此时以 DOM 读法为准。
      const model = readViaEditor(ed);
      if (model != null && normText(model) === normText(dom)) return model.trim();
    }
    return dom.trim();
  }

  // ---------- Lexical 模型层读写 ----------
  // composer 是 Lexical 编辑器的根 DOM：createEditor 在根节点上挂了 __lexicalEditor 句柄，
  // 通过它拿到模型层，读写都直接操作模型，DOM 由 Lexical 自己保持一致。
  function lexEditor(el) {
    try {
      const ed = el && el.__lexicalEditor;
      return ed && typeof ed.parseEditorState === "function" && typeof ed.setEditorState === "function"
        && typeof ed.getEditorState === "function" ? ed : null;
    } catch (err) { return null; }
  }

  /** 模型层读原文（含段落换行）。走 EditorState.toJSON（纯 JSON，不依赖 Lexical 内部导出），
   *  任意一步异常返回 null，由调用方回退 DOM 读法。 */
  function readViaEditor(ed) {
    try {
      const json = ed.getEditorState().toJSON();
      const out = [];
      // 块级子节点之间补换行；文本节点取 text，换行节点本身就是 "\n"
      const walk = (node) => {
        const kids = (node && node.children) || [];
        if (!kids.length) {
          if (node && node.type === "text") out.push(node.text || "");
          else if (node && node.type === "linebreak") out.push("\n");
          return;
        }
        kids.forEach((kid, i) => { if (i) out.push("\n"); walk(kid); });
      };
      walk(json && json.root);
      return out.join("");
    } catch (err) { return null; }
  }

  // Lexical 会同时渲染段落间的空行节点，textContent 取出是「段落拼接 + 空行」，两者都不含
  // 有意义的空白差异，因此比较一律先剥掉所有空白字符（与原实现的语义等价判定一致）。
  function normText(s) { return String(s || "").replace(/\s+/g, ""); }

  /** 目标文本 → Lexical 序列化状态（按 \n 切段落，与编辑器自身 toJSON 同构）。 */
  function buildEditorStateJson(text) {
    const para = (line) => ({
      children: line ? [{ detail: 0, format: 0, mode: "normal", style: "", text: line, type: "text", version: 1 }] : [],
      direction: null, format: "", indent: 0, type: "paragraph", version: 1, textFormat: 0, textStyle: "",
    });
    return {
      root: {
        children: String(text).replace(/\r\n?/g, "\n").split("\n").map(para),
        direction: null, format: "", indent: 0, type: "root", version: 1,
      },
    };
  }

  /**
   * 一次原子替换：清空旧内容与填入新文本是同一个 setEditorState，不存在「清一半/叠一半」窗口。
   * 之后用焦点把光标落到末尾（setEditorState 会把内部选区置空，不补这一步用户接着打字会丢焦点）。
   */
  function writeViaEditor(el, ed, text) {
    const next = ed.parseEditorState(buildEditorStateJson(text));
    ed.setEditorState(next);
    // 内部选区为空时 focus 会把光标落到根末尾；若仍为空则连同 DOM 光标一起补一次
    try { if (typeof ed.focus === "function") ed.focus(); } catch (err) { /* 静默 */ }
    try {
      const rng = document.createRange();
      rng.selectNodeContents(el);
      rng.collapse(false);
      const ds = document.getSelection();
      ds.removeAllRanges();
      ds.addRange(rng);
      document.dispatchEvent(new Event("selectionchange"));
    } catch (err) { /* 静默 */ }
  }

  async function writeDraft(text) {
    const el = composerEl();
    if (!el) return false;
    const want = normText(text);
    if (normText(el.textContent) === want) return true;   // 幂等：内容已是目标，免去一次重写

    const ed = lexEditor(el);
    let viaModel = false;
    if (ed) {
      try { writeViaEditor(el, ed, text); viaModel = true; }
      catch (err) { console.log("[zcode-enhance] 模型层写入失败，回退 DOM 通路:", err && err.message); }
    }

    // 回退通路（没有编辑器句柄 / 模型层写入抛错）：先确认清空，再填。清空不成功绝不插入，
    // 否则就会叠在原稿上——这正是「残留 + 覆盖」的来源。
    if (!viaModel) {
      if (!(await clearDraft(el))) return false;
      if (!(await fillDraft(el, text))) return false;
    }

    // 校验：结果必须与目标完全一致（空白归一后），否则如实报失败走剪贴板兜底，绝不静默留下混合内容
    const t0 = Date.now();
    while (Date.now() - t0 < 900) {
      if (normText(el.textContent) === want) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    console.log("[zcode-enhance] 写回未确认:", JSON.stringify((el.textContent || "").slice(0, 60)));
    return false;
  }

  /**
   * 回退通路专用：把 DOM 选区铺满整个编辑器，再让 Lexical 走它自己的 beforeinput 管线删掉这段选区。
   * 关键点：execCommand('selectAll') 只把浏览器选区落在最后一段文本节点（0..该段长度），
   * 单段草稿看着没事，多段草稿就只删掉最后一段 —— 剩下的段落被随后的插入顶走，就成了「残留 + 覆盖」。
   * deleteByCut 是唯一会被 Lexical 转成 REMOVE_TEXT（真删选区）的输入类型；deleteContent 走的是
   * 删单字符（DELETE_CHARACTER），对多段选区完全无效。
   */
  async function clearDraft(el) {
    const empty = () => !(el.textContent || "").trim();
    const settle = async (ms) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (empty()) return true;
        await new Promise((r) => setTimeout(r, 40));
      }
      return empty();
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      // ① Lexical 在管这条通路时唯一有效的删法（真删选区，含跨段）
      try {
        el.focus({ preventScroll: true });
        const rng = document.createRange();
        rng.selectNodeContents(el);
        const ds = document.getSelection();
        ds.removeAllRanges();
        ds.addRange(rng);
        document.dispatchEvent(new Event("selectionchange"));   // 显式催 Lexical 同步内部选区
        el.dispatchEvent(new InputEvent("beforeinput", { inputType: "deleteByCut", bubbles: true, cancelable: true }));
      } catch (err) { /* 静默：交给下面的原生通路 */ }
      if (await settle(400)) return true;
      // ② 非 Lexical（或编辑器未接管该事件）时的原生通路：先删当前选区，再退到全选删除
      try {
        el.focus({ preventScroll: true });
        document.execCommand("delete");
      } catch (err) { /* 静默 */ }
      if (await settle(300)) return true;
      try {
        el.focus({ preventScroll: true });
        document.execCommand("selectAll");
        document.execCommand("delete");
      } catch (err) { /* 静默 */ }
      if (await settle(300)) return true;
    }
    console.log("[zcode-enhance] 清空输入框失败，放弃写入以免叠加残留");
    return false;
  }

  /** 回退通路专用：草稿已确认清空后再填。
   *  逐行写，每步都先试编辑器管线再退到 execCommand —— 两条通路的有效机制不同：
   *  Lexical 只认 beforeinput（execCommand('insertParagraph') 被它忽略），普通 contenteditable
   *  则相反（合成 beforeinput 只是通知事件，不会真的插入）。每行写完都轮询确认落进去了，
   *  没有落进去才补一次 execCommand，避免在某一边静默丢内容。 */
  async function fillDraft(el, text) {
    const waitFor = async (pred, ms) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (pred()) return true;
        await new Promise((r) => setTimeout(r, 30));
      }
      return pred();
    };
    try {
      el.focus({ preventScroll: true });
      const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (i) {
          const before = el.innerHTML;
          el.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertParagraph", bubbles: true, cancelable: true }));
          if (!(await waitFor(() => el.innerHTML !== before, 150))) document.execCommand("insertParagraph");
        }
        if (lines[i]) {
          const len0 = (el.textContent || "").length;
          el.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: lines[i], bubbles: true, cancelable: true }));
          if (!(await waitFor(() => (el.textContent || "").length > len0, 150))) {
            document.execCommand("insertText", false, lines[i]);
          }
        }
      }
      return true;
    } catch (err) { return false; }
  }

  // ---------- toast ----------
  function toast(msg, ok, onUndo) {
    try {
      if (undoTimer) { clearTimeout(undoTimer); undoTimer = null; }   // 防：旧定时器触发时误清新 toast 的定时器
      document.querySelectorAll("[data-zenh-toast]").forEach((el) => el.remove());
      const d = document.createElement("div");
      d.setAttribute("data-zenh-toast", "1");
      d.style.cssText = "position:fixed;right:18px;bottom:64px;z-index:99999;display:flex;gap:10px;align-items:center;" +
        "max-width:420px;padding:11px 14px;border-radius:10px;font-size:13px;line-height:1.5;" +
        "background:var(--color-popover,#18181b);color:var(--color-popover-foreground,#fafafa);" +
        "border:1px solid " + (ok === false ? "#b91c1c" : "var(--color-border,#3f3f46)") + ";" +
        "box-shadow:0 8px 24px rgba(0,0,0,.35)";
      const span = document.createElement("span");
      span.textContent = msg;
      span.style.cssText = "overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical";
      d.appendChild(span);
      if (onUndo) {
        const b = document.createElement("button");
        b.textContent = "撤销";
        b.style.cssText = "flex-shrink:0;background:none;border:1px solid var(--color-border,#3f3f46);" +
          "border-radius:6px;padding:4px 10px;color:var(--color-foreground,#e4e4e7);cursor:pointer;font-size:12px";
        b.onclick = () => { cleanup(); onUndo(); };
        d.appendChild(b);
      }
      document.body.appendChild(d);
      const cleanup = () => { d.remove(); undoTimer = null; };
      undoTimer = setTimeout(cleanup, ok === false ? 6000 : 8000);
    } catch (err) { /* 静默 */ }
  }

  // ---------- 按钮 ----------
  function makeSparkSvg() {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("width", "14"); svg.setAttribute("height", "14");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "url(#zenh-spark-grad)");
    svg.setAttribute("stroke-width", "2"); svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.style.display = "block";
    // Gemini 式蓝→紫对角渐变（去饱和，深浅主题均可读）
    const defs = document.createElementNS(NS, "defs");
    const grad = document.createElementNS(NS, "linearGradient");
    grad.setAttribute("id", "zenh-spark-grad");
    grad.setAttribute("x1", "0"); grad.setAttribute("y1", "0");
    grad.setAttribute("x2", "1"); grad.setAttribute("y2", "1");
    for (const [offset, color] of [["0", "#5b9df8"], ["1", "#ae7cf7"]]) {
      const st = document.createElementNS(NS, "stop");
      st.setAttribute("offset", offset);
      st.setAttribute("stop-color", color);
      grad.appendChild(st);
    }
    defs.appendChild(grad);
    svg.appendChild(defs);
    const paths = [
      "M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z",
      "M20 3v4", "M22 5h-4",
    ];
    for (const d of paths) {
      const el = document.createElementNS(NS, "path");
      el.setAttribute("d", d);
      svg.appendChild(el);
    }
    return svg;
  }

  function makeBtn() {
    if (!document.getElementById("zenh-style")) {
      const st = document.createElement("style");
      st.id = "zenh-style";
      st.textContent = "@keyframes zenh-spin{to{transform:rotate(360deg)}}#zcode-enhance-btn.zenh-busy svg{opacity:.45;animation:zenh-spin 1s linear infinite}";
      (document.head || document.documentElement).appendChild(st);
    }
    const b = document.createElement("button");
    b.id = BTN_ID;
    b.type = "button";
    b.title = "增强提示词（单击 / Ctrl+/ 增强 · 右键选模型/模式）";
    b.appendChild(makeSparkSvg());
    Object.assign(b.style, {
      display: "inline-flex", alignItems: "center", gap: "4px",
      flexShrink: "0", height: "24px", padding: "0 7px",
      borderRadius: "6px", fontSize: "12px", cursor: "pointer", userSelect: "none",
      justifyContent: "center",
      background: "transparent",
      border: "none",
      color: "#5b9df8",
      marginRight: "8px",
    });
    b.onmouseenter = () => { if (!busy) { b.style.background = "color-mix(in oklab, var(--color-foreground) 7%, transparent)"; b.style.filter = "brightness(1.18)"; } };
    b.onmouseleave = () => { b.style.background = "transparent"; b.style.filter = ""; };
    b.onclick = run;
    b.oncontextmenu = (ev) => { ev.preventDefault(); openPicker(); };
    return b;
  }

  function setBusy(b, on) {
    busy = on;
    if (!b) return;
    b.classList.toggle("zenh-busy", on);
    b.style.opacity = on ? "0.75" : "1";
    b.style.pointerEvents = on ? "none" : "auto";
  }

  // 快捷键（Ctrl+/）—— 无平台分支：Mac 与 Windows/Linux 都用 Ctrl，判定只看 ev.key + 修饰键。
  // 只在输入框聚焦时生效：光标不在 composer 里（弹窗、别的输入框、终端）一律不拦截，
  // 避免把用户的 Ctrl+/ 吞掉。capture 阶段拿事件，早于 Lexical 的根节点 keydown 处理，
  // 配合 preventDefault 让「/」不会被当作字符插入、也不会触发应用的「/」能力菜单。
  function composerFocused() {
    const el = composerEl();
    if (!el) return false;
    const a = document.activeElement;
    return !!a && (a === el || el.contains(a));
  }

  // ev.key 取的是「按布局实际打出的字符」，所以这里不能用 code（Slash）或 keyCode 判定：
  // 非 US 布局（德语区 / 法语 AZERTY 等）上 "/" 本身就要 Shift 才打得出来，此时必须接受
  // shiftKey 才按得动。安全性由 key === "/" 这条守住：US 布局上 Ctrl+Shift+Slash 打出的是
  // "?"，字符不符直接不命中，因此放开 shift 不会让 Ctrl+Shift+/ 误触发。
  function isHotkey(ev) {
    return ev.key === "/" && ev.ctrlKey && !ev.metaKey && !ev.altKey;
  }

  function onHotkey(ev) {
    if (ev.defaultPrevented || ev.isComposing) return;      // 组字中/已被别处处理，不抢
    if (ev.repeat) return;
    if (!isHotkey(ev)) return;
    if (document.getElementById("zenh-picker-root")) return; // 选模型面板开着时把按键让给面板
    if (!composerFocused()) return;
    ev.preventDefault();
    ev.stopPropagation();
    run();
  }

  // ---------- 模型/模式选择面板（右键） ----------
  async function openPicker() {
    document.getElementById("zenh-picker-root")?.remove();
    const root = document.createElement("div");
    root.id = "zenh-picker-root";
    root.style.cssText = "position:fixed;inset:0;z-index:99997;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center";
    const panel = document.createElement("div");
    panel.style.cssText = "width:560px;max-width:92vw;max-height:76vh;display:flex;flex-direction:column;" +
      "background:var(--color-popover,#131316);color:var(--color-popover-foreground,#fafafa);" +
      "border:1px solid var(--color-popover-border,#2e2e33);border-radius:12px;" +
      "box-shadow:0 16px 48px rgba(0,0,0,.5);font-size:14px;overflow:hidden";
    const head = document.createElement("div");
    head.style.cssText = "padding:12px 16px;border-bottom:1px solid var(--color-popover-border,#2e2e33);" +
      "display:flex;align-items:center;justify-content:space-between;gap:8px";
    const title = document.createElement("span");
    title.textContent = "增强模型 · 模式";
    title.style.cssText = "font-weight:600";
    const modeBtn = document.createElement("button");
    const drawMode = () => {
      modeBtn.textContent = "模式：" + MODE_LABEL[getMode()] + (getMode() === "creative" ? "（充分展开）" : "（约800字）");
    };
    modeBtn.style.cssText = "background:var(--color-input,#1c1c1f);border:1px solid var(--color-popover-border,#2e2e33);" +
      "border-radius:8px;padding:6px 12px;color:var(--color-foreground,#e4e4e7);cursor:pointer;font-size:12px";
    modeBtn.onclick = () => { toggleMode(); drawMode(); };
    drawMode();
    const x = document.createElement("button");
    x.textContent = "×";
    x.style.cssText = "background:none;border:none;color:var(--color-foreground-subtle,#a1a1aa);font-size:18px;cursor:pointer";
    x.onclick = close;
    head.append(title, modeBtn, x);
    const list = document.createElement("div");
    list.style.cssText = "flex:1;overflow-y:auto;padding:8px";
    const foot = document.createElement("div");
    foot.style.cssText = "padding:10px 16px;border-top:1px solid var(--color-popover-border,#2e2e33);" +
      "display:flex;align-items:center;justify-content:space-between;color:var(--color-foreground-subtle,#a1a1aa);font-size:12px";
    foot.textContent = "点击条目指定模型 · 选「自动」恢复评分链 · 数据实时读自 config.json";
    panel.append(head, list, foot);
    root.appendChild(panel);
    document.body.appendChild(root);
    root.onmousedown = (e) => { if (e.target === root) close(); };
    function esc(ev) { if (ev.key === "Escape") { close(); document.removeEventListener("keydown", esc); } }
    document.addEventListener("keydown", esc);
    function close() { root.remove(); document.removeEventListener("keydown", esc); }

    const rowBase = "display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;cursor:pointer";
    function addRow(labelText, opts) {
      const r = document.createElement("div");
      r.style.cssText = rowBase + (opts && opts.active ? ";background:var(--color-accent,#27272a);outline:1px solid var(--color-primary,#3b82f6)" : "");
      r.onmouseenter = () => { if (!(opts && opts.active)) r.style.background = "var(--color-input,#1c1c1f)"; };
      r.onmouseleave = () => { if (!(opts && opts.active)) r.style.background = "transparent"; };
      const t = document.createElement("span");
      t.textContent = labelText;
      t.style.cssText = "flex:1;font-family:var(--font-mono,ui-monospace,Consolas,monospace);font-size:13px;" +
        "white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
      r.appendChild(t);
      if (opts && opts.badge) {
        const b = document.createElement("span");
        b.textContent = opts.badge;
        b.style.cssText = "flex-shrink:0;font-size:11px;color:var(--color-foreground-subtle,#a1a1aa);" +
          "border:1px solid var(--color-border,#3f3f46);border-radius:6px;padding:2px 6px";
        r.appendChild(b);
      }
      list.appendChild(r);
      return r;
    }
    function addGroup(text) {
      const g = document.createElement("div");
      g.textContent = text;
      g.style.cssText = "padding:8px 10px 4px;color:var(--color-foreground-subtle,#a1a1aa);font-size:12px;font-weight:600";
      list.appendChild(g);
      return g;
    }

    const sel = getSel();
    const autoRow = addRow("自动（跟随渠道评分与 priority）", { active: !sel, badge: "默认" });
    autoRow.onclick = () => { setSel(null); toast("增强已恢复自动选择（渠道评分 + priority）", true); close(); };
    if (!preloadV2()) addGroup("⚠ preload 为旧版：模式/指定模型不会传到主进程，请重打 --enhance-btn 升级");

    if (!window.zcode || !window.zcode.enhanceListModels) {
      addGroup("⚠ preload 缺 enhanceListModels（旧版补丁），无法列出模型——重跑 --enhance-btn 升级");
      return;
    }
    const loading = addRow("读取 config.json …", {});
    let data = null;
    try { data = await window.zcode.enhanceListModels(); } catch (err) { data = { ok: false, error: String(err) }; }
    loading.remove();
    if (!data || !data.ok) { addGroup("读取失败：" + ((data && data.error) || "未知错误")); return; }
    // 指定的渠道不在启用渠道列表（被删/禁用/属 builtin: 官方渠道——主进程不列出）即清掉，恢复自动评分链
    if (sel && data.channels && !data.channels.some((c) => c.id === sel.channel)) {
      setSel(null);
      toast("已清除失效指定（" + sel.channel + "），恢复自动评分链", true);
      autoRow.style.background = "var(--color-accent,#27272a)";
      autoRow.style.outline = "1px solid var(--color-primary,#3b82f6)";
    }
    if (data.manual) addGroup("手动配置生效中：" + data.manual.model + "（enhance-config.json；下方指定可覆盖它）");
    if (!data.channels.length) { addGroup("config.json 里没有启用的渠道"); return; }
    for (const ch of data.channels) {
      const badges = [ch.kind || "?"];
      if (ch.selected) badges.push("★ 当前渠道");
      if (!ch.hasKey) badges.push("无凭据");
      addGroup(ch.id + "　" + badges.join(" · "));
      if (!ch.models.length) {
        const empty = addRow("（该渠道没有模型）", {});
        empty.style.cursor = "default";
        empty.onmouseenter = empty.onmouseleave = null;
        continue;
      }
      for (const m of ch.models) {
        const active = !!sel && sel.channel === ch.id && sel.model === m.id;
        const r = addRow(m.id, { active, badge: m.priority > 0 ? "P" + m.priority : "" });
        r.onclick = () => {
          setSel({ channel: ch.id, model: m.id });
          toast("增强将使用 " + ch.id + " · " + m.id, true);
          close();
        };
      }
    }
  }

  async function run(ev) {
    const btn = document.getElementById(BTN_ID);
    if (busy) return;
    const now = Date.now();
    if (now - lastRun < 1200) return;
    lastRun = now;
    const text = readDraft();
    if (!text) { toast("请先输入需要增强的提示词", false); return; }
    if (!window.zcode || !window.zcode.enhancePromptDraft) { toast("增强补丁未加载完整（缺 IPC）", false); return; }
    if (!preloadV2()) toast("⚠ preload 为旧版（模式/选模型不生效），请重打 --enhance-btn", false);
    setBusy(btn, true);
    const sel = getSel();
    let res = null;
    try {
      res = await window.zcode.enhancePromptDraft(text, getMode(), sel ? sel.channel : undefined, sel ? sel.model : undefined);
    } catch (err) { res = { ok: false, error: String(err) }; }
    setBusy(btn, false);
    if (!res || !res.ok || !res.text) {
      toast("增强失败：" + ((res && res.error) || "未知错误"), false);
      return;
    }
    if (await writeDraft(res.text)) {
      undoText = text;
      toast("已增强（" + MODE_LABEL[getMode()] + (res.model ? " · " + res.model : "") + "）· 点此撤销", true, () => {
        if (undoText != null) { writeDraft(undoText); undoText = null; }
      });
    } else {
      try { await navigator.clipboard.writeText(res.text); } catch (err) { /* 静默 */ }
      console.log("[zcode-enhance] 增强结果：", res.text);
      toast("增强成功，但写回输入框失败——结果已复制到剪贴板", false);
    }
  }

  // ---------- 挂载保活（React 重渲染后重挂） ----------
  function scan() {
    try {
      const row = findToolbarRow();
      let existing = row && row.querySelector("#" + BTN_ID);
      if (!row) {
        if (existing) existing.remove();
        return;
      }
      // 中组容器 = row 直接子级中含「完全访问」（旧版）或新版 tool 触发器按钮组
      let mid = null;
      for (const el of row.children) {
        const isToolbarGroup = el.querySelector("[data-chat-toolbar-popover-trigger='true']")
          || el.querySelector("[data-testid*='toolbar'],[data-testid*='send']");
        if ((el.textContent || "").includes("完全访问") || isToolbarGroup) { mid = el; break; }
      }
      if (!existing) existing = makeBtn();
      if (mid) {
        const pill = mid.querySelector("[data-ztps-bar]");
        if (pill) {
          // 已在胶囊之前即可（与胶囊之间允许隔着「继续」按钮）——不再强制紧邻，
          // 否则会与 zcode-continue-btn 互相搬移形成抖动
          if (!(existing.compareDocumentPosition(pill) & Node.DOCUMENT_POSITION_FOLLOWING)) {
            mid.insertBefore(existing, pill);
          }
        } else if (existing.parentNode !== mid) mid.appendChild(existing);
      } else if (existing.parentNode !== row) {
        row.insertBefore(existing, row.firstChild);
      }
    } catch (err) { /* 静默 */ }
  }

  function start() {
    setInterval(scan, 1000);
    try {
      let last = 0;
      const mo = new MutationObserver(() => {
        const now = performance.now();
        if (now - last > 16) { last = now; scan(); }
      });
      mo.observe(document.body, { childList: true, subtree: true });
    } catch (err) { /* 静默 */ }
    try { document.addEventListener("keydown", onHotkey, true); } catch (err) { /* 静默 */ }
    scan();
  }
  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start);
})();
