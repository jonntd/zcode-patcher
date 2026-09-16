#!/usr/bin/env node
"use strict";
/**
 * 零依赖冒烟测试（CI 用，不依赖本机已装 ZCode）。
 * 只验证脚本语法、CLI 契约与非交互状态输出，全程只读、不改任何文件。
 */

const assert = require("assert");
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "scripts", "zcode-patcher.js");
const TUI = path.join(ROOT, "scripts", "zcode-tui.js");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ok  " + name);
  } catch (err) {
    console.error("  FAIL " + name + "\n       " + (err && err.message));
    process.exitCode = 1;
  }
}

function run(script, args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

// --- 文件与语法 ---
test("核心脚本存在", () => {
  for (const f of ["scripts/zcode-patcher.js", "scripts/zcode-tui.js", "scripts/zcode-tps.js", "scripts/zcode-enhance.js", "scripts/zcode-continue.js", "scripts/modelhub_payload.json"]) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), "缺失 " + f);
  }
});

test("所有 JS 脚本语法可解析", () => {
  for (const f of ["zcode-patcher.js", "zcode-tui.js", "zcode-tps.js", "zcode-enhance.js", "zcode-continue.js"]) {
    const r = run(path.join(ROOT, "scripts", f), ["--help"]);
    // --help 或正常退出即可；只要不是 SyntaxError 就算通过
    assert.ok(!/SyntaxError/.test(r.stderr || ""), f + " 语法错误: " + r.stderr);
  }
});

// --- CLI 契约 ---
test("--help 打印用法", () => {
  const r = run(CLI, ["--help"]);
  assert.ok(/用法/.test(r.stdout), "help 输出缺少用法");
  assert.strictEqual(r.status, 0);
});

test("--check 在无 ZCode 时不报错崩溃", () => {
  const r = run(CLI, ["--check", "/tmp/zcode-patcher-nonexistent"]);
  assert.ok(!/\n\s+at /.test(r.stderr || ""), "出现未捕获异常栈");
});

// --- 非交互状态（只读） ---
test("--status --json 输出合法 JSON，含 9 个补丁", () => {
  const r = run(TUI, ["/tmp/zcode-patcher-nonexistent", "--status", "--json"]);
  const data = JSON.parse(r.stdout);
  assert.ok(Array.isArray(data), "不是数组");
  assert.strictEqual(data.length, 9, "补丁数不是 9");
  for (const row of data) {
    assert.ok(typeof row.name === "string" && row.name, "缺 name");
    assert.ok(["applied", "partial", "not", "unknown"].includes(row.state), "非法 state: " + row.state);
  }
});

test("--json 与 --status --json 等价", () => {
  const a = run(TUI, ["/tmp/zcode-patcher-nonexistent", "--json"]);
  const b = run(TUI, ["/tmp/zcode-patcher-nonexistent", "--status", "--json"]);
  assert.deepStrictEqual(JSON.parse(a.stdout), JSON.parse(b.stdout));
});

test("--status 文本模式输出汇总", () => {
  const r = run(TUI, ["/tmp/zcode-patcher-nonexistent", "--status"]);
  assert.ok(/ZCode 补丁状态/.test(r.stdout), "缺少标题");
  assert.ok(/已打 \d/.test(r.stdout), "缺少汇总计数");
});

// --- 嵌入文件与 scripts/ 同步 ---
test("launcher/ 内嵌副本与 scripts/ 一致", () => {
  for (const f of ["zcode-patcher.js", "zcode-tui.js", "zcode-tps.js", "zcode-enhance.js", "zcode-continue.js", "modelhub_payload.json"]) {
    const a = path.join(ROOT, "scripts", f);
    const b = path.join(ROOT, "launcher", f);
    if (!fs.existsSync(b)) continue; // 未跑过构建时跳过
    assert.strictEqual(fs.readFileSync(a, "utf8"), fs.readFileSync(b, "utf8"), f + " 不同步，请运行 npm run build");
  }
});

// --- 无明文敏感信息守护 ---
test("仓库内无常见令牌/私钥明文", () => {
  const patterns = [/ghp_[A-Za-z0-9]{20,}/, /github_pat_[A-Za-z0-9_]{20,}/, /sk-[A-Za-z0-9]{20,}/, /AKIA[0-9A-Z]{16}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/];
  const skip = new Set([".git", "node_modules", "dist"]);
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(ent.name)) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.(js|cjs|mjs|json|ya?ml|md|go|txt|cmd|sh)$/.test(ent.name)) {
        const text = fs.readFileSync(p, "utf8");
        for (const re of patterns) assert.ok(!re.test(text), "疑似密钥于 " + path.relative(ROOT, p));
      }
    }
  };
  walk(ROOT);
});

console.log(`\n${passed} 项冒烟测试通过${process.exitCode ? "（存在失败）" : ""}`);
