/**
 * ZCode 继续按钮 —— 输入框工具栏「»」（纯图标，✨增强按钮右侧；点击后仍填入「继续」二字发送）
 * 单击：把「继续」填入 composer（已有草稿则空格追加，不丢原文）→ 触发与原生发送按钮
 *       完全相同的提交通路（chat-send-button 是 form 的 type=submit，click 即走
 *       onSubmit → 发送 / 排队逻辑），生成中排队、权限锁定等状态全部交给应用自身判断。
 * 原理：composer 是 Lexical contenteditable（data-testid=v4-composer-input），
 *       写入用聚焦后 execCommand(selectAll+insertText)，由 Lexical 的 beforeinput
 *       同步内部 state（与 zcode-enhance.js 同一套已验证通路）；提交后轮询草稿已清空
 *       才算成功，失败降级合成 Enter 兜底，再失败 toast 提示（绝不重复发送）。
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

  function composerEl() {
    return document.querySelector("[data-testid='v4-composer-input']");
  }

  function normText(s) { return String(s || "").replace(/\s+/g, ""); }

  // 写入并轮询确认（替换语义）：失败返回 false，绝不在内容未确认时触发发送
  async function writeDraft(text) {
    const el = composerEl();
    if (!el) return false;
    const want = normText(text);
    el.focus({ preventScroll: true });
    document.execCommand("selectAll");
    document.execCommand("insertText", false, text);
    const t0 = Date.now();
    while (Date.now() - t0 < 800) {
      if (normText(el.textContent) === want) return true;
      await new Promise((r) => setTimeout(r, 60));
    }
    return normText(el.textContent) === want;
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
    b.title = "填入「继续」并立即发送（已有草稿则空格追加后一并发送）";
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
    const draft = (el.textContent || "").trim();
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
        if ((el.textContent || "").includes("完全访问")) { mid = el; break; }
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
    scan();
  }
  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start);
})();
