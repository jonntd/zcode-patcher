/**
 * ZCode 继续按钮 —— 输入框工具栏「»」（纯图标，✨增强按钮右侧；点击后仍填入「继续」二字发送）
 * 单击：把「继续」填入 composer（已有草稿则空格追加，不丢原文）→ 触发与原生发送按钮
 *       完全相同的提交通路（chat-send-button 是 form 的 type=submit，click 即走
 *       onSubmit → 发送 / 排队逻辑），生成中排队、权限锁定等状态全部交给应用自身判断。
 * 快捷键：Ctrl+/ 隔壁的「Cmd/Ctrl+Shift+J」，同样只在输入框聚焦时生效（见下）。
 * 原理：composer 是 Lexical contenteditable（data-testid=v4-composer-input），写入走编辑器
 *       模型层（__lexicalEditor + parseEditorState/setEditorState 整体替换）；仅在拿不到句柄时
 *       回退 DOM 通路，且回退里「先清空、再逐行填」各自校验。旧实现用
 *       execCommand(selectAll+insertText) 一次写入，在 Lexical 下有三重问题：全选只覆盖最后
 *       一段（多段草稿写不进去）、命令之间需要让出事件循环才同步内部选区（同步连发必失败）、
 *       多段文本里的换行会被丢掉。提交后轮询草稿已清空才算成功，失败降级合成 Enter 兜底，
 *       再失败 toast 提示（绝不重复发送）。
 * 兼容：与 zcode-tps.js（统计胶囊）、zcode-enhance.js（✨增强）共存——本按钮只把自己
 *       放在 ✨ 之后，不搬动任何其他注入元素；✨ 不存在时挂到「完全访问」容器末尾。
 * 样式：无框、无底色的纯图标按钮（悬停浮出浅色底 + 提亮）；图标用柔蓝 #5b9df8，与 ✨ 的
 *       蓝→紫渐变同家族（AI 按钮通用蓝紫配色，深色主题对比度 ≥3:1）；异常静默不影响主界面。
 */
(() => {
  if (window.__zcont) return;
  window.__zcont = true;

  const BTN_ID = "zcode-continue-btn";
  const TEXT = "继续";
  let lastRun = 0;

  // ---------- 工具栏行定位（与 zcode-tps.js / zcode-enhance.js 同一套） ----------
  function findToolbarRow() {
    // 多级锚点：新版(u3+) 输入框在 .chat-composer-input-surface 组件内、发送钮 data-testid
    // 为 chat-send-button；旧版是 data-testid="v4-composer-input"。全部探测，兜底到页面上
    // 唯一可见的大输入框（textarea / contenteditable），保证结构改版时功能不消失。
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
    // 新版工具栏行可能在 form 内部、form 外层（form 上部子容器）。候选取
    // 输入框自身到 form 祖先的整条链，再综合评分挑最像工具栏的。
    const scope = form ? (form.parentElement || form) : ta.parentElement;
    if (!scope) return null;
    const candidates = [];
    const collect = (n) => {
      for (const d of n.querySelectorAll("div")) { candidates.push(d); if (candidates.length > 400) return; }
    };
    collect(scope);
    // 工具栏容器（含发送/触发器按钮组）不一定贴着 form，往上多爬两级（新版结构）风险小
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

  function normText(s) { return String(s || "").replace(/\s+/g, ""); }

  // ---------- Lexical 模型层读写（与 zcode-enhance.js 同一套；两脚本各自独立不共享状态） ----------
  function lexEditor(el) {
    try {
      const ed = el && el.__lexicalEditor;
      return ed && typeof ed.parseEditorState === "function" && typeof ed.setEditorState === "function"
        && typeof ed.getEditorState === "function" ? ed : null;
    } catch (err) { return null; }
  }

  /** 模型层读原文（含段落换行）；异常返回 null 由调用方回退 DOM 读法。 */
  function readViaEditor(ed) {
    try {
      const json = ed.getEditorState().toJSON();
      const out = [];
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

  function readDraft() {
    const el = composerEl();
    if (!el) return "";
    const dom = el.textContent || "";
    const ed = lexEditor(el);
    if (ed) {
      const model = readViaEditor(ed);
      if (model != null && normText(model) === normText(dom)) return model.trim();
    }
    return dom.trim();
  }

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

  function writeViaEditor(el, ed, text) {
    ed.setEditorState(ed.parseEditorState(buildEditorStateJson(text)));
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

  /** 回退通路：铺满 DOM 选区后发 deleteByCut（Lexical 唯一能跨段真删选区的输入类型）。 */
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
      try {
        el.focus({ preventScroll: true });
        const rng = document.createRange();
        rng.selectNodeContents(el);
        const ds = document.getSelection();
        ds.removeAllRanges();
        ds.addRange(rng);
        document.dispatchEvent(new Event("selectionchange"));
        el.dispatchEvent(new InputEvent("beforeinput", { inputType: "deleteByCut", bubbles: true, cancelable: true }));
      } catch (err) { /* 静默 */ }
      if (await settle(400)) return true;
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
    return false;
  }

  /** 回退通路：逐行写，编辑器管线与 execCommand 各试一次（两条通路认的机制不同）。 */
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

  // 写入并轮询确认（替换语义）：失败返回 false，绝不在内容未确认时触发发送
  async function writeDraft(text) {
    const el = composerEl();
    if (!el) return false;
    const want = normText(text);
    if (normText(el.textContent) === want) return true;

    const ed = lexEditor(el);
    let viaModel = false;
    if (ed) {
      try { writeViaEditor(el, ed, text); viaModel = true; }
      catch (err) { console.log("[zcode-continue] 模型层写入失败，回退 DOM 通路:", err && err.message); }
    }
    if (!viaModel) {
      if (!(await clearDraft(el))) return false;
      if (!(await fillDraft(el, text))) return false;
    }
    const t0 = Date.now();
    while (Date.now() - t0 < 900) {
      if (normText(el.textContent) === want) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }

  // 触发与原生「↑」完全一致的提交：能点到原生按钮就走原生按钮（含禁用态判断），
  // 否则退回表单 requestSubmit / submit 事件
  function submitDraft() {
    const el = composerEl();
    const form = el && el.closest("form");
    if (!form) return { ok: false, reason: "noform" };
    const btn = form.querySelector("[data-testid='chat-send-button']");
    if (btn) {
      if (btn.disabled) return { ok: false, reason: "disabled" };
      btn.click();
      return { ok: true };
    }
    try { form.requestSubmit(); return { ok: true }; } catch (err) { /* 走事件兜底 */ }
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    return { ok: true };
  }

  // 提交后草稿应被清空（或至少不再是待发文本）；未清空则合成 Enter 兜底一次
  async function waitSent(want, el) {
    const changed = () => normText(el.textContent) !== normText(want);
    const t0 = Date.now();
    while (Date.now() - t0 < 900) {
      if (changed()) return true;
      await new Promise((r) => setTimeout(r, 70));
    }
    el.focus({ preventScroll: true });
    el.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true,
    }));
    const t1 = Date.now();
    while (Date.now() - t1 < 700) {
      if (changed()) return true;
      await new Promise((r) => setTimeout(r, 70));
    }
    return false;
  }

  // ---------- toast（失败提示用；成功静默不打扰） ----------
  function toast(msg) {
    try {
      document.querySelectorAll("[data-zcont-toast]").forEach((el) => el.remove());
      const d = document.createElement("div");
      d.setAttribute("data-zcont-toast", "1");
      d.style.cssText = "position:fixed;right:18px;bottom:64px;z-index:99999;padding:11px 14px;" +
        "border-radius:10px;font-size:13px;line-height:1.5;max-width:420px;" +
        "background:var(--color-popover,#18181b);color:var(--color-popover-foreground,#fafafa);" +
        "border:1px solid #b91c1c;box-shadow:0 8px 24px rgba(0,0,0,.35)";
      d.textContent = msg;
      document.body.appendChild(d);
      setTimeout(() => d.remove(), 6000);
    } catch (err) { /* 静默 */ }
  }

  // ---------- 按钮 ----------
  function makeChevronsSvg() {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("width", "13"); svg.setAttribute("height", "13");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none"); svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2"); svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.style.display = "block";
    for (const d of ["M6 17l5-5-5-5", "M13 17l5-5-5-5"]) {
      const el = document.createElementNS(NS, "path");
      el.setAttribute("d", d);
      svg.appendChild(el);
    }
    return svg;
  }

  function makeBtn() {
    const b = document.createElement("button");
    b.id = BTN_ID;
    b.type = "button";
    b.title = "填入「继续」并立即发送（Cmd/Ctrl+Shift+J；已有草稿则空格追加后一并发送）";
    b.appendChild(makeChevronsSvg());
    Object.assign(b.style, {
      display: "inline-flex", alignItems: "center",
      flexShrink: "0", height: "24px", padding: "0 7px",
      borderRadius: "6px", fontSize: "12px", cursor: "pointer", userSelect: "none",
      justifyContent: "center",
      background: "transparent",
      border: "none",
      color: "#5b9df8",
      marginRight: "8px",
    });
    b.onmouseenter = () => { b.style.background = "color-mix(in oklab, var(--color-foreground) 7%, transparent)"; b.style.color = "#8abbfa"; };
    b.onmouseleave = () => { b.style.background = "transparent"; b.style.color = "#5b9df8"; };
    b.onclick = run;
    return b;
  }

  async function run() {
    const now = Date.now();
    if (now - lastRun < 1500) return;   // 冷却：防双击重复发送
    lastRun = now;
    const el = composerEl();
    if (!el) return;
    const draft = readDraft();
    const want = draft ? draft + " " + TEXT : TEXT;
    if (!(await writeDraft(want))) {
      toast("「继续」写入输入框失败，未发送（请手动输入）");
      return;
    }
    const r = submitDraft();
    if (!r.ok) {
      if (r.reason === "disabled") toast("发送按钮当前不可用（可能正在生成或不允许提交），「继续」已填入输入框");
      else toast("未找到发送入口，「继续」已填入输入框，请手动发送");
      return;
    }
    if (!(await waitSent(want, el))) {
      toast("「继续」已填入但未能确认发送成功，请检查输入框后手动发送");
    }
  }

  // ---------- 快捷键（Cmd/Ctrl+Shift+J） ----------
  // 同 zcode-enhance.js：只在输入框聚焦时生效，capture 阶段拦截并 preventDefault，
  // 避免把用户的组合键吞掉或让字符漏进草稿。Continue = J，与增强键（Ctrl+/）相邻好记。
  function composerFocused() {
    const el = composerEl();
    if (!el) return false;
    const a = document.activeElement;
    return !!a && (a === el || el.contains(a));
  }

  function onHotkey(ev) {
    if (ev.defaultPrevented || ev.isComposing || ev.repeat) return;
    if (ev.key !== "j" && ev.key !== "J") return;
    if (!(ev.metaKey || ev.ctrlKey) || !ev.shiftKey || ev.altKey) return;
    if (!composerFocused()) return;
    ev.preventDefault();
    ev.stopPropagation();
    run();
  }

  // ---------- 挂载保活（React 重渲染后重挂；只管自己，不搬动其他注入元素） ----------
  function scan() {
    try {
      const row = findToolbarRow();
      let existing = row && row.querySelector("#" + BTN_ID);
      if (!row) {
        if (existing) existing.remove();
        return;
      }
      let mid = null;
      for (const el of row.children) {
        const isToolbarGroup = el.querySelector("[data-chat-toolbar-popover-trigger='true']")
          || el.querySelector("[data-testid*='toolbar'],[data-testid*='send']");
        if ((el.textContent || "").includes("完全访问") || isToolbarGroup) { mid = el; break; }
      }
      if (!mid) return;
      if (!existing) existing = makeBtn();
      const enh = mid.querySelector("#zcode-enhance-btn");
      if (enh) {
        if (enh.nextSibling !== existing) mid.insertBefore(existing, enh.nextSibling);
      } else if (existing.parentNode !== mid) {
        mid.appendChild(existing);
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
