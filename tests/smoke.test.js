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

test("许可与第三方归属文件存在", () => {
  for (const f of ["LICENSE", "NOTICE.md"]) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), "缺失 " + f);
  }
  const notice = fs.readFileSync(path.join(ROOT, "NOTICE.md"), "utf8");
  assert.ok(/MIT License/.test(notice), "NOTICE.md 未包含第三方 MIT 许可全文");
  assert.ok(/CSSZYF/.test(notice), "NOTICE.md 未保留第三方版权归属");
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

test("TUI 接受 flags 前后的目标路径", () => {
  const tui = fs.readFileSync(TUI, "utf8");
  assert.ok(tui.includes('process.argv.slice(2).find((a) => !a.startsWith("--"))'), "目标路径未从全部参数扫描");
  assert.ok(!tui.includes('process.argv[2] && !process.argv[2].startsWith("--")'), "仍只读取 argv[2]");
});

test("TUI 不吞掉补丁子进程失败", () => {
  const tui = fs.readFileSync(TUI, "utf8");
  assert.ok(tui.includes("typeof code === \"number\" ? code : 1"), "缺少非零退出码保留");
  assert.ok(tui.includes("child.on(\"error\""), "缺少 spawn error 处理");
  assert.ok(tui.includes("reportFailure"), "缺少失败报告");
});

test("批量操作覆盖未知状态并统一复查", () => {
  const tui = fs.readFileSync(TUI, "utf8");
  // 批量走单进程全 flag 调用：引擎内 MemAsar 把 repack 类补丁合并为一次 asar 落盘
  assert.ok(tui.includes("PATCHES.map((p) => p.flag).filter(Boolean)"), "批量未走单进程全 flag 调用");
  assert.ok(tui.includes('r.state = classify(checked.out)'), "批量完成后未统一复查状态");
  assert.ok(tui.includes("不适用跳过"), "不适用（na）项未在批量汇总中提示");
  assert.ok(tui.includes('r.state !== "applied" && r.state !== "na"'), "交互批量未排除不适用项");
  assert.ok(tui.includes("async function executePatch(row, revert)"), "单项执行路径缺失");
  assert.ok(tui.includes("row.reason = resultReason"), "未知状态没有保留原因");
  assert.ok(tui.includes("批量操作完成：成功"), "交互批量结果未汇总");
});

test("拉取模型：自然序排序、确认去重与载荷漂移升级", () => {
  const ph = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/modelhub_payload.json"), "utf8"));
  assert.ok(ph.MAIN_HANDLERS.includes("localeCompare"), "主进程拉取列表未用自然序排序");
  assert.ok(!ph.MAIN_HANDLERS.includes(".sort().map(id=>"), "仍是默认字典序");
  assert.ok(ph.RENDER_V2_HDR_INSERT.includes("trim().toLowerCase()"), "确认过滤未做大小写/空白归一");
  assert.ok(ph.RENDER_V2_HDR_INSERT.includes("seen.has(k))continue;seen.add(k);"), "选择器内变体去重逻辑错误");
  assert.ok(ph.HELPER_BLOCK.includes("if(ok.disabled)return;ok.disabled=!0;"), "确认按钮缺一次性锁");
  const patcher = fs.readFileSync(CLI, "utf8");
  assert.ok(patcher.includes("upgradeDrift"), "缺少 v2.1 载荷漂移升级路径");
  assert.ok(patcher.includes("边界标记剥旧重注"), "漂移升级未按边界标记剥离");
});

test("preload 注入随内核形态选变体（3.14+ 绑定名 h→_）", () => {
  const ph = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/modelhub_payload.json"), "utf8"));
  assert.ok(ph.PRELOAD_V2_WITNESS && ph.PRELOAD_V2_WITNESS.includes("connectRemote:s((t,n,i)=>_.ipcRenderer.invoke"),
    "见证串必须锚定 3.14+ 原生 connectRemote 体");
  for (const [curKey, oldKey] of [["PRELOAD_INJECT_V2", "PRELOAD_INJECT"], ["ENH_PRELOAD_INJECT_V3", "ENH_PRELOAD_INJECT"]]) {
    assert.ok(ph[curKey], "缺少 " + curKey + " 变体");
    assert.ok(ph[curKey].includes("_.ipcRenderer.invoke"), curKey + " 未绑定 _.ipcRenderer");
    // 变体除绑定名外必须与旧形态逐字符一致（h. 与 _. 等长），替换语义不变
    assert.ok(ph[curKey].length === ph[oldKey].length, curKey + " 与旧形态长度不一致");
    assert.ok(ph[curKey].split("_.ipcRenderer").join("h.ipcRenderer") === ph[oldKey],
      curKey + " 与旧形态除绑定名外存在漂移");
  }
  const patcher = fs.readFileSync(CLI, "utf8");
  assert.ok(patcher.includes("preWantsV2"), "modelhub 未按内核形态选择注入变体");
  assert.ok(patcher.includes("preIsCurrent"), "enhance 未按内核形态选择注入变体");
  assert.ok(patcher.includes("preload 注入形态与内核不匹配"), "--check 未暴露形态不匹配");
  assert.ok(patcher.includes("[injectV3, injectNew, injectOld]"), "enhance 剥离未覆盖全部注入形态");
});

test("引擎批量落盘与状态登记", () => {
  const patcher = fs.readFileSync(CLI, "utf8");
  assert.ok(patcher.includes("function memAsarOpen"), "缺少 MemAsar 共享内存态");
  assert.ok(patcher.includes("mem.flush("), "批量路径未合并落盘");
  assert.ok(patcher.includes("ASAR_PATCH_TABLE"), "asar 补丁未表驱动注册");
  assert.ok(patcher.includes("SIDECAR_REFRESHERS"), "sidecar 刷新未注册表化");
});

test("未知状态在初次检查（退出码 0）也保留原因", () => {
  const tui = fs.readFileSync(TUI, "utf8");
  assert.ok(
    tui.includes('r.reason = resultFailed(result) || st === "unknown" ? resultReason(result) : ""'),
    "初次检查的未知项未挂原因",
  );
  assert.ok(tui.includes("shortReason"), "菜单/总览未做原因截断展示");
});

test("去额度横幅支持新旧两代锚点组", () => {
  const patcher = fs.readFileSync(CLI, "utf8");
  assert.ok(patcher.includes("QUOTA_VARIANTS"), "缺少多版本锚点组");
  assert.ok(patcher.includes('label: "v1（旧版三元档位）"'), "旧版锚点组丢失");
  assert.ok(patcher.includes("e.ratio<=.1?`model-very-low`"), "旧版 very-low 锚点丢失");
  assert.ok(patcher.includes("r>.1||!i||e.isReminderHidden"), "缺少新版提醒横幅锚点");
  assert.ok(patcher.includes("r>-1||!i||e.isReminderHidden"), "缺少新版锚点替换串");
});

test("TPS 和工具栏按钮不依赖固定完全访问文案", () => {
  for (const f of ["scripts/zcode-tps.js", "scripts/zcode-enhance.js", "scripts/zcode-continue.js"]) {
    const text = fs.readFileSync(path.join(ROOT, f), "utf8");
    assert.ok(text.includes("const scored = candidates.map"), f + " 缺少工具栏 fallback");
    assert.ok(text.includes("data-testid*='send'"), f + " 缺少发送按钮定位");
  }
  const tps = fs.readFileSync(path.join(ROOT, "scripts/zcode-tps.js"), "utf8");
  assert.ok(tps.includes("[data-turn-id],[data-message-id],[data-assistant-message-id]"), "TPS 仍只识别旧轮次节点");
});

test("TPS 端口钩子声明兼容新版对象形端口消息", () => {
  const tps = fs.readFileSync(path.join(ROOT, "scripts/zcode-tps.js"), "utf8");
  assert.ok(tps.includes('type === "zcode:service-port"'), "TPS 未适配新版 preload 的 {type:service-port} 对象消息");
});

// --- TPS 注入脚本沙箱功能测试（vm，零依赖） ---
const vm = require("vm");

function loadTpsSandbox() {
  const code = fs.readFileSync(path.join(ROOT, "scripts", "zcode-tps.js"), "utf8");
  const messageListeners = [];
  const timers = [];   // 手动驱动的 setTimeout 队列（兜底 start 用）
  const win = {};
  win.addEventListener = (type, fn) => { if (type === "message") messageListeners.push(fn); };
  const doc = { body: null, addEventListener: () => {} };   // body 为空 → start 延迟，无需 DOM 桩
  const sandbox = vm.createContext({
    window: win,
    document: doc,
    TextDecoder: class { decode(u8) { return Buffer.from(u8).toString("utf8"); } },
    setTimeout: (fn, ms) => { timers.push([fn, ms]); return timers.length; },
  });
  vm.runInContext(code, sandbox);
  return { win, messageListeners, timers };
}

function makeFakePort() {
  return {
    _handlers: {},
    started: false,
    addEventListener(type, fn) { this._handlers[type] = fn; },
    start() { this.started = true; },
  };
}

function dispatchMessage(listeners, win, data, ports) {
  const ev = { source: win, data, ports: ports || [] };
  for (const fn of listeners) fn(ev);
}

function feedFrame(port, obj) {
  port._handlers.message({ data: new TextEncoder().encode(JSON.stringify(obj)) });
}

test("TPS 端口钩子识别新版 {type:service-port} 对象消息并打通数据链路", () => {
  const { win, messageListeners, timers } = loadTpsSandbox();
  const port = makeFakePort();
  dispatchMessage(messageListeners, win, { type: "zcode:service-port", databaseStartupId: "db1" }, [port]);
  assert.strictEqual(win.__ztpsPort, port, "主会话端口未被钩住（统计栏因此永不显示）");
  assert.ok(!port.started, "hookPort 不得主动 port.start()：3.12.x 启动握手依赖首批帧，提前 start 会把 app 尚未监听的初始帧派发掉，整个界面卡死在启动 logo");

  // 会话行事件（userInput 建 turn）→ usage.delta（version:1 精确用量）
  feedFrame(port, { frame: { payload: { events: [{ row: { rowId: "row_1", turnId: "msg_t1", kind: "userInput", createdAt: 1000, sourceCommandId: "sc_1" } }] } } });
  feedFrame(port, { version: 1, kind: "usage.delta", sourceCommandId: "sc_1", outputTokens: 42, inputTokens: 100, cacheReadTokens: 90, totalTokens: 142, occurredAt: 2000, sessionId: "sess_1", modelId: "test-model" });

  const t = win.__ztpsTurns.get("msg_t1");
  assert.ok(t, "usage.delta 未关联到轮");
  assert.strictEqual(t.outputTokens, 42, "outputTokens 未累计");
  assert.strictEqual(t.sessionId, "sess_1", "sessionId 未记录");
  assert.strictEqual(win.__ztpsSessionUsage.requests, 1, "会话累计请求数未累计");
  assert.ok(Math.abs(t.turnCache - 0.9) < 1e-9, "本轮缓存命中率未计算（第三方模型 timely 显示依赖它）");

  // 已收到帧（app 在消费）时，兜底定时器不得再画蛇添足
  for (const [fn] of timers) fn();
  assert.ok(!port.started, "app 正常消费端口时兜底 start 不应触发");
});

test("TPS 兜底定时器：app 一直不消费端口时才主动 start（旧行为等价，不存在偷帧）", () => {
  const { win, messageListeners, timers } = loadTpsSandbox();
  const port = makeFakePort();
  dispatchMessage(messageListeners, win, "zcode:service-port", [port]);
  assert.ok(!port.started, "hookPort 时不得立即 start");
  const fallback = timers.find(([, ms]) => ms === 10000);
  assert.ok(fallback, "缺少 10s 兜底 start 定时器");
  fallback[0]();
  assert.ok(port.started, "app 不消费端口时兜底 start 未生效（TPS 将永远无数据）");
});

test("TPS 端口钩子保留旧版字符串与 scoped 端口，忽略无关消息且不重复接管", () => {
  const { win, messageListeners } = loadTpsSandbox();
  const p1 = makeFakePort();
  dispatchMessage(messageListeners, win, "zcode:service-port", [p1]);
  assert.strictEqual(win.__ztpsPort, p1, "旧版裸字符串消息未钩住");

  const p2 = makeFakePort();
  dispatchMessage(messageListeners, win, { type: "zcode:scoped-service-port", attachmentId: "a1", sessionId: "s1", target: "chat" }, [p2]);
  assert.strictEqual(win.__ztpsPort, p2, "scoped 端口未钩住");

  const p3 = makeFakePort();
  dispatchMessage(messageListeners, win, { type: "zcode:database-startup-state" }, [p3]);
  assert.notStrictEqual(win.__ztpsPort, p3, "无关消息不应钩住端口");

  dispatchMessage(messageListeners, win, "zcode:service-port", [p1]);
  assert.strictEqual(win.__ztpsPort, p2, "重复投递已钩住的端口不应重新接管");
  assert.ok(p1.__ztps, "已钩住端口状态保持不变");
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
