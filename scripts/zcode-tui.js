#!/usr/bin/env node
"use strict";
/**
 * zcode-patcher 交互式菜单（零依赖，仅用 Node 内置模块）
 * =====================================================
 *
 * 仿 incipit 的 TUI：运行后出现可方向键选择的补丁列表，每个补丁实时显示
 * 「已打/未打」，Enter 切换 打/还原（已打→还原，未打→打），q 退出。
 * 任何对 ZCode 的读写都发生在真正的 zcode-patcher.js 子进程里，本文件
 * 只负责查状态(只读)与转交命令，不重复实现任何补丁逻辑。
 *
 * 设计要点：
 *  - 状态查询通过子进程跑 `node zcode-patcher.js <flag> --check`，解析它
 *    固定输出的 `已打/未打/已还原` 文本。`--check` 是纯只读、安全先跑，
 *    与 SKILL.md 约定的核实顺序一致。
 *  - 采用 readline.emitKeypressEvents 拼对方向键等 ESC 序列——方向键在
 *    PTY 下会被拆成多帧，须拼接后才能正确识别（与 incipit 做法一致）。
 *  - 补丁本身幂等、可定点还原，TUI 只是在确认后转交参数；中断不留半截。
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const SCRIPT = path.join(__dirname, "zcode-patcher.js");
const isTTY = process.stdin.isTTY && process.stdout.isTTY;
// 可选：直接传一个安装根目录，透传给子进程作为目标。
const targetArg = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "";
// 非交互子命令（小写，走 --xxx 统一透传到 tui 而非 CLI）。
const isNonInteractive = () => process.argv.some((a) => [ "--status", "--check-all", "--apply-all", "--revert-all" ].includes(a));

// 每个补丁：显示名 + 传给 zcode-patcher.js 的功能 flag。
// 打=传该 flag；还原=传该 flag 再叠 --revert；查状态=传该 flag 再叠 --check。
const PATCHES = [
  { name: "思考等级透传",   flag: "" },               // 默认(内核)
  { name: "全消息可编辑",   flag: "--edit-all" },
  { name: "用量页去截断",   flag: "--usage-chart" },
  { name: "模型菜单加宽",   flag: "--menu-width" },
  { name: "继续按钮",       flag: "--continue-btn" },
  { name: "TPS 统计栏",     flag: "--tps-footer" },
  { name: "模型拉取",       flag: "--modelhub" },
  { name: "增强提示词按钮", flag: "--enhance-btn" },
  { name: "去额度骚扰横幅", flag: "--quota-banner" },
];

// 总览键（不在菜单里单独做行，作为全局键），与函数绑定。
const OVERVIEW_KEY = "/";

// 批量动作：全部打我放最顶（第一项，顺手），全部还原垫底（破坏性操作远离默认焦点）。
const BATCH_APPLY  = { kind: "apply-all",  name: "全部打我（全部应用未打的补丁）" };
const BATCH_REVERT = { kind: "revert-all", name: "全部还原（全部补丁退回原状）" };

const Ansi = {
  RESET: "\x1b[0m",
  BOLD: "\x1b[1m",
  GREY: "\x1b[90m",
  GREEN: "\x1b[32m",
  YELLOW: "\x1b[33m",
  CYAN: "\x1b[36m",
  INV: "\x1b[7m",
};
const color = (t, c) => c + t + Ansi.RESET;

// 状态徽章（菜单与总览共用）。
const badge = {
  applied: color("已打", Ansi.GREEN),
  partial: color("部分/异常", Ansi.YELLOW),
  not: color("未打", Ansi.GREY),
  unknown: color("未知", Ansi.YELLOW),
};

/** 以子进程跑 zcode-patcher.js，返回 { code, out }。不继承 stdin（只读查询）。 */
function runPatcher(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code: code || 0, out }));
  });
}

/** 由 --check 输出推导状态：'applied' | 'partial' | 'not' | 'unknown'。 */
function classify(out) {
  const text = out || "";
  if (text.includes("部分") || text.includes("异常") || text.includes("不完整")) return "partial";
  if (text.includes("已打")) return "applied";
  if (text.includes("未打") || text.includes("已还原") || text.includes("没有备份")) return "not";
  return "unknown";
}

let screenHeld = null;

function clearScreen() { process.stdout.write("\x1b[2J\x1b[3J\x1b[H"); }

/** 总览：清屏打印每项 + 状态徽章 + 汇总计数，等待任意键返回菜单。 */
function showOverview(rows) {
  return new Promise((resolve) => {
    clearScreen();
    const out = [color("ZCode 补丁总览", Ansi.BOLD), ""];
    const cnt = { applied: 0, partial: 0, not: 0, unknown: 0 };
    rows.forEach((r, i) => {
      cnt[r.state] = (cnt[r.state] || 0) + 1;
      out.push(` ${(i + 1).toString().padStart(2)}. ${r.name.padEnd(16)} ${badge[r.state]}`);
    });
    out.push("");
    out.push(color(`已打 ${cnt.applied} · 部分/异常 ${cnt.partial} · 未打 ${cnt.not} · 未知 ${cnt.unknown}`, Ansi.GREY));
    out.push(color("按任意键返回菜单…", Ansi.GREY));
    process.stdout.write(out.join("\n"));
    const onKey = () => { process.stdin.removeListener("keypress", onKey); resolve(); };
    process.stdin.on("keypress", onKey);
  });
}

// 菜单条目顺序：全部打我（第一项）→ 9 个补丁 → 全部还原（末项）。
// 每项统一为 { kind: "batch"|"patch", ... }，索引即光标位置。
function menuItems(rows) {
  return [{ kind: "batch", batch: BATCH_APPLY }, ...rows.map((r) => ({ kind: "patch", row: r })), { kind: "batch", batch: BATCH_REVERT }];
}
function totalItems(rows) { return rows.length + 2; }

// 非交互状态文本：`--status`/`--check-all` 时打印，供脚本/CI 消费。
function statusText(rows) {
  const cnt = { applied: 0, partial: 0, not: 0, unknown: 0 };
  const body = rows.map((r, i) => {
    cnt[r.state] = (cnt[r.state] || 0) + 1;
    return ` ${(i + 1).toString().padStart(2)}. ${r.name.padEnd(16)} ${badge[r.state]}`;
  });
  return [
    color("ZCode 补丁状态", Ansi.BOLD),
    "",
    ...body,
    "",
    color(`已打 ${cnt.applied} · 部分/异常 ${cnt.partial} · 未打 ${cnt.not} · 未知 ${cnt.unknown}`, Ansi.GREY),
  ].join("\n");
}

function render(rows, sel, busyIdx) {
  clearScreen();
  const out = [];
  out.push(color("ZCode 客户端补丁工具 — 交互式菜单", Ansi.BOLD));
  out.push(color("方向键 ↑↓ 移动 · Enter 执行 · 1-9 快选补丁 · / 总览 · q 退出", Ansi.GREY));
  out.push("");
  const items = menuItems(rows);
  items.forEach((it, i) => {
    const cur = i === sel;
    const mark = cur ? "›" : " ";
    let line;
    if (it.kind === "batch") {
      const name = cur ? color(it.batch.name, Ansi.BOLD) : it.batch.name;
      line = ` ${mark} ${name}`;
    } else {
      const r = it.row;
      const state = busyIdx === i ? color("… 执行中", Ansi.CYAN) : badge[r.state];
      const name = cur ? color(r.name, Ansi.BOLD) : r.name;
      line = ` ${mark} ${name.padEnd(16)} ${state}`;
    }
    if (i === 1 || i === items.length - 1) out.push(""); // 批量项与补丁区之间留白
    out.push(cur ? color(line, Ansi.INV) : line);
  });
  out.push("");
  out.push(color("补丁幂等可重复；Enter 对已打项=还原；全部打我=给所有未打项打，全部还原=全部退回", Ansi.GREY));
  process.stdout.write(out.join("\n"));
}

function cleanupInput() {
  try { process.stdin.setRawMode(false); } catch (_) {}
  process.stdin.pause();
}

async function main() {
  if (!fs.existsSync(SCRIPT)) {
    console.error("[!] 找不到 " + SCRIPT + "（本工具须与 zcode-patcher.js 同目录）");
    process.exit(1);
  }

  // 首次只读核实全部补丁状态（SKILL.md 第一步，全部只读可放心先跑）。
  const rows = PATCHES.map((p) => ({ ...p, state: "unknown" }));
  await Promise.all(
    rows.map(async (r) => {
      const { out } = await runPatcher([r.flag, "--check", targetArg].filter(Boolean));
      r.state = classify(out);
    }),
  );

  // 非交互命令：状态 / 打我 / 还原，供脚本、CI 直接调用。
  const wantJSON = process.argv.includes("--json");
  const wantStatus = wantJSON || process.argv.some((a) => a === "--status" || a === "--check-all");
  const wantApplyAll = process.argv.includes("--apply-all");
  const wantRevertAll = process.argv.includes("--revert-all");
  // 状态是只读：直接基于上面已核实的结果输出，不再碰任何子进程（也不会改 ZCode）。
  if (wantStatus) {
    const code = rows.some((r) => r.state === "partial" || r.state === "unknown") ? 2 : 0;
    if (wantJSON) {
      process.stdout.write(JSON.stringify(rows.map((r) => ({ name: r.name, flag: r.flag || "(default)", state: r.state })), null, 2) + "\n");
    } else {
      console.log(statusText(rows));
    }
    process.exit(code);
  }

  if (wantApplyAll || wantRevertAll) {
    const targets = wantRevertAll ? rows : rows.filter((r) => r.state !== "applied");
    let code = 0;
    for (const r of targets) {
      const call = []
        .concat(r.flag === "" ? [] : [r.flag])
        .concat(wantRevertAll ? ["--revert"] : [])
        .concat(targetArg ? [targetArg] : []);
      await runPatcherInherit(call);
      const { out } = await runPatcher([r.flag, "--check", targetArg].filter(Boolean));
      r.state = classify(out);
      if (r.state === "partial" || r.state === "unknown") code = 2; // 部分/未知 ⇒ 非零
    }
    console.log(color(`完毕：${wantRevertAll ? "还原" : "应用"} ${targets.length} 项补丁`, code ? Ansi.RED : Ansi.GREEN));
    process.exit(code);
  }

  if (!isTTY) {
    console.error("[!] 交互菜单需要 TTY。请用命令行方式运行 zcode-patcher.js，或加 --status 看状态。");
    process.exit(1);
  }

  let sel = 0;
  let busy = false;
  let busyIdx = -1;
  const N = totalItems(rows);
  render(rows, sel, busyIdx);

  // 关键：必须显式开启 raw 模式并 emitKeypressEvents，否则 stdin 处于
  // paused、不会发出 keypress，事件循环立即空转退出（菜单一闪而过）。
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();

  process.stdin.on("keypress", async (str, key) => {
    if (busy) return;
    const ch = str || (key && key.sequence) || "";

    if (key && key.ctrl && key.name === "c") { cleanupInput(); clearScreen(); process.exit(130); }
    if (key && key.name === "up") { sel = (sel - 1 + N) % N; render(rows, sel, busyIdx); return; }
    if (key && key.name === "down") { sel = (sel + 1) % N; render(rows, sel, busyIdx); return; }
    if (ch === "q" || ch === "Q") { cleanupInput(); clearScreen(); console.log("已退出"); process.exit(0); }

    // 总览键：按 / 查看所有补丁状态汇总，任意键返回。
    if (ch === OVERVIEW_KEY) {
      await showOverview(rows);
      render(rows, sel, busyIdx);
      return;
    }

    const n = parseInt(ch, 10);
    if (!Number.isNaN(n) && n >= 1 && n <= rows.length) { sel = n; render(rows, sel, busyIdx); return; } // 数字对应补丁（前面隔着「全部打我」，故 +1）

    // Enter 执行当前项（批量行 或 补丁行）
    if (key && (key.name === "return" || key.name === "enter" || ch === "\r" || ch === "\n" || ch === "h")) {
      const items = menuItems(rows);
      const item = items[sel];
      busy = true; busyIdx = sel; render(rows, sel, busyIdx);
      if (item.kind === "patch") {
        // --- 单项补丁 ---
        const row = item.row;
        // 已应用或部分应用→先还原（部分需先还原才能重打）；其余→打
        const revert = row.state === "applied" || row.state === "partial";
        const call = []
          .concat(row.flag === "" ? [] : [row.flag])
          .concat(revert ? ["--revert"] : [])
          .concat(targetArg ? [targetArg] : []);
        await runPatcherInherit(call);
        const { out } = await runPatcher([row.flag, "--check", targetArg].filter(Boolean));
        row.state = classify(out);
        busy = false; busyIdx = -1;
        render(rows, sel, busyIdx);
        return;
      }
      // --- 批量动作：先确认，避免误触整组改动 ---
      const batch = item.batch;
      const targets = batch.kind === "apply-all"
        ? rows.filter((r) => r.state !== "applied")   // 未打/部分/未知→打
        : rows;                                        // 全还原
      if (targets.length === 0) {
        console.log(color("（没有需要执行的项）", Ansi.YELLOW));
        await new Promise((r) => setTimeout(r, 900)); // 短暂停留让提示可见
      } else {
        const ok = await confirmDialog(`${batch.name}？（${targets.length} 项） [y]执行 [n]取消`);
        if (ok) {
          for (const r of targets) {
            const revert = batch.kind === "revert-all";
            const call = []
              .concat(r.flag === "" ? [] : [r.flag])
              .concat(revert ? ["--revert"] : [])
              .concat(targetArg ? [targetArg] : []);
            await runPatcherInherit(call);
            const { out } = await runPatcher([r.flag, "--check", targetArg].filter(Boolean));
            r.state = classify(out);
          }
        }
      }
      busy = false; busyIdx = -1;
      render(rows, sel, busyIdx);
    }
  });
}

// 模态确认：复用当前 raw 模式逐键读 y/n。不改状态，只临时挂监听。
function confirmDialog(prompt) {
  return new Promise((resolve) => {
    console.log(color("  " + prompt, Ansi.YELLOW));
    const onKey = (s, k) => {
      const ch = (s || "").toLowerCase();
      if (ch === "y") { finish(); resolve(true); }
      else if (ch === "n" || (k && k.name === "escape")) { finish(); resolve(false); }
      // 其它键忽略
    };
    const finish = () => process.stdin.removeListener("keypress", onKey);
    process.stdin.on("keypress", onKey);
  });
}

/** 供用户确认后执行的子进程：继承 stdio，让 zcode-patcher 自身打印过程。 */
function runPatcherInherit(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { stdio: "inherit" });
    child.on("close", (code) => resolve(code || 0));
  });
}

process.on("exit", () => {
  // 仅在交互 TTY 下恢复光标/颜色，避免污染 --json 等非交互 stdout。
  if (isTTY) { try { process.stdout.write("\x1b[?25h\x1b[0m"); } catch (_) {} }
});

main();