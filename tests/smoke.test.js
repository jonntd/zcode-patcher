#!/usr/bin/env node
"use strict";
/**
 * 零依赖冒烟测试（CI 用，不依赖本机已装 ZCode）。
 * 只验证脚本语法、CLI 契约与非交互状态输出，全程只读、不改任何文件。
 */

const assert = require("assert");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
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
  assert.ok(r.stdout.includes("--model-retry"), "help 输出缺少 --model-retry");
  assert.strictEqual(r.status, 0);
});

test("--check 在无 ZCode 时不报错崩溃", () => {
  const r = run(CLI, ["--check", "/tmp/zcode-patcher-nonexistent"]);
  assert.ok(!/\n\s+at /.test(r.stderr || ""), "出现未捕获异常栈");
});

// --- 非交互状态（只读） ---
test("--status --json 输出合法 JSON，含 10 个补丁", () => {
  const r = run(TUI, ["/tmp/zcode-patcher-nonexistent", "--status", "--json"]);
  const data = JSON.parse(r.stdout);
  assert.ok(Array.isArray(data), "不是数组");
  assert.strictEqual(data.length, 10, "补丁数不是 10");
  assert.ok(data.some((row) => row.flag === "--model-retry" && row.name.includes("3009")), "缺少模型 3009 重试补丁");
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

test("preload 注入随内核形态选变体（h→_→S，3.17 见证 i→r）", () => {
  const ph = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/modelhub_payload.json"), "utf8"));
  assert.ok(ph.PRELOAD_V2_WITNESS && ph.PRELOAD_V2_WITNESS.includes("connectRemote:s((t,n,i)=>_.ipcRenderer.invoke"),
    "见证串必须锚定 3.14+ 原生 connectRemote 体");
  assert.ok(ph.PRELOAD_V3_WITNESS && ph.PRELOAD_V3_WITNESS.includes("connectRemote:s((t,n,i)=>S.ipcRenderer.invoke"),
    "见证串必须锚定 3.16+ 原生 connectRemote 体");
  assert.ok(ph.PRELOAD_V4_WITNESS && ph.PRELOAD_V4_WITNESS.includes("connectRemote:s((t,n,r)=>S.ipcRenderer.invoke"),
    "见证串必须锚定 3.17+ 原生 connectRemote 体（第三参 i→r，绑定仍 S）");
  for (const [curKey, oldKey] of [["PRELOAD_INJECT_V2", "PRELOAD_INJECT"], ["PRELOAD_INJECT_V3", "PRELOAD_INJECT_V2"], ["PRELOAD_INJECT_V4", "PRELOAD_INJECT_V3"], ["ENH_PRELOAD_INJECT_V3", "ENH_PRELOAD_INJECT"]]) {
    assert.ok(ph[curKey], "缺少 " + curKey + " 变体");
    assert.ok(ph[curKey].includes(".ipcRenderer.invoke"), curKey + " 未绑定 ipcRenderer");
    // 变体除绑定名外必须与旧形态逐字符一致（h. 与 _. / S. 等长），替换语义不变
    const norm = (s) => s.split("_.ipcRenderer").join("h.ipcRenderer").replace(/S\.ipcRenderer/g, "h.ipcRenderer");
    assert.ok(ph[curKey].length === ph[oldKey].length, curKey + " 与旧形态长度不一致");
    assert.ok(norm(ph[curKey]) === norm(ph[oldKey]), curKey + " 与旧形态除绑定名外存在漂移");
  }
  // V5 在 V4 基础上语义升级（+curModel 第五参，跟随会话当前模型），不再是纯绑定名变体
  assert.ok(ph.ENH_PRELOAD_INJECT_V5.includes("(e,t,n,r,s)=>S.ipcRenderer.invoke"), "V5 未扩展为五参");
  assert.ok(ph.ENH_PRELOAD_INJECT_V5.includes("curModel:s}"), "V5 注入串缺 curModel 字段");
  // 增强主进程链路：渠道收集纳入 builtin（官方计划用户增强可用）、跟随会话模型
  assert.ok(ph.ENH_MAIN_HANDLERS.includes("enabled!==false||id===pid||String(id).startsWith(\"builtin:\")"), "run/list 渠道收集未纳入 builtin 与选中渠道");
  assert.ok(ph.ENH_MAIN_HANDLERS.includes("curModel"), "run handler 缺会话模型跟随");
  assert.ok(ph.ENH_MAIN_HANDLERS.includes("builtin:String(id).startsWith"), "list-models 缺官方渠道徽标字段");
  const patcher = fs.readFileSync(CLI, "utf8");
  assert.ok(patcher.includes("preFormCur"), "modelhub 未按内核形态选择注入变体");
  assert.ok(patcher.includes("preIsCurrent"), "enhance 未按内核形态选择注入变体");
  assert.ok(patcher.includes("preload 注入形态与内核不匹配"), "--check 未暴露形态不匹配");
  assert.ok(patcher.includes("[injectV5, injectV4, injectV3, injectNew, injectOld]"), "enhance 剥离未覆盖全部注入形态");
  assert.ok(patcher.includes("{ n: 8, buf: v8Buf, sigOld: v8SigOld, sigNew: v8SigNew, prop: v8PropBuf }"), "modelhub gens 表缺 V8 组");
  assert.ok(patcher.includes("PRELOAD_V4_WITNESS"), "preForms 链缺 V4 见证");
  assert.ok(patcher.includes("preWitness4"), "enhance injCur 链缺 V4 见证");
  // 注入按钮统一挂左下 leading actions（ZCodium 原生版布局，模式选择器旁），旧中组仅作回落
  for (const f of ["scripts/zcode-enhance.js", "scripts/zcode-continue.js", "scripts/zcode-tps.js"]) {
    const text = fs.readFileSync(path.join(ROOT, f), "utf8");
    assert.ok(text.includes("chat-mode-select-trigger"), f + " 缺少 leading actions 定位锚");
  }
});

test("模型 3009 重试：只翻转 3009，等长、幂等、可还原", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-retry-"));
  const target = path.join(dir, "zcode.cjs");
  const entry = (code) => `["${code}",{code:as.ModelRateLimited,reason:bs.RateLimited,retryReason:tl.RateLimited,retryable:!1}]`;
  const original = [
    'const as={ModelRateLimited:"model_rate_limited"},bs={RateLimited:"rate_limited"},tl={RateLimited:"rate_limited"};',
    `const table=[${entry("3009")},${entry("3008")},${entry("3010")}];`,
    "module.exports=table;",
  ].join("\n");
  fs.writeFileSync(target, original);

  const applied = run(CLI, ["--model-retry", target]);
  assert.strictEqual(applied.status, 0, applied.stderr || applied.stdout);
  const after = fs.readFileSync(target, "utf8");
  assert.ok(after.includes(entry("3009").replace("retryable:!1", "retryable:!0")), "3009 未翻转为可重试");
  assert.ok(after.includes(entry("3008")), "3008 被误改");
  assert.ok(after.includes(entry("3010")), "3010 被误改");
  assert.strictEqual(after.length, original.length, "补丁改变了内核长度（应等长）");

  const checked = run(CLI, ["--model-retry", "--check", target]);
  assert.ok(/3009 自动重试: 已打/.test(checked.stdout), "--check 未报告已打");

  const again = run(CLI, ["--model-retry", target]);
  assert.ok(/已打，跳过/.test(again.stdout), "重复打未走幂等跳过");
  assert.strictEqual(fs.readFileSync(target, "utf8"), after, "重复打改变了文件");

  const reverted = run(CLI, ["--model-retry", "--revert", target]);
  assert.strictEqual(reverted.status, 0, reverted.stderr || reverted.stdout);
  assert.strictEqual(fs.readFileSync(target, "utf8"), original, "还原后与原始内容不一致");
  assert.ok(!fs.existsSync(target + ".modelretry-tmp.cjs"), "残留 node --check 临时文件");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("模型 3009 重试：锚点容忍压缩变量名漂移，缺失时报告不适用", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-retry-drift-"));
  const target = path.join(dir, "zcode.cjs");
  fs.writeFileSync(target, 'const zz={ModelRateLimited:"model_rate_limited"},yy={RateLimited:"rate_limited"},xx={RateLimited:"rate_limited"};module.exports=[["3009",{code:zz.ModelRateLimited,reason:yy.RateLimited,retryReason:xx.RateLimited,retryable:!1}]];');
  const r = run(CLI, ["--model-retry", target]);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
  assert.ok(fs.readFileSync(target, "utf8").includes("retryable:!0}]];"), "变量名漂移时未命中锚点");
  fs.rmSync(dir, { recursive: true, force: true });

  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-retry-na-"));
  const none = path.join(dir2, "zcode.cjs");
  fs.writeFileSync(none, "module.exports={};");
  const na = run(CLI, ["--model-retry", "--check", none]);
  assert.ok(/本补丁在该内核不适用/.test(na.stdout), "缺失锚点未报告不适用");
  fs.rmSync(dir2, { recursive: true, force: true });
});

test("全消息可编辑：结构化锚点容忍未知变量名漂移，幂等、可还原", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-editall-struct-"));
  const target = path.join(dir, "zcode.cjs");
  // 用未来版本才会出现的变量名（不在任何字面变体里），验证结构化兜底
  const k = "QQz", r = "WWr", c = "EEc", t = "TTt", n = "NNn";
  const p1Old = `else if(${k}.kind==="userInput")${k}.rowId===${r}?(${c}.canEdit=!0,${c}.editDisposition="rewind"):(delete ${c}.canEdit,delete ${c}.editDisposition)`;
  const p1New = `else if(${k}.kind==="userInput")this.entityIdByRowId.get(${k}.rowId)&&this.editTargetByEntityId.has(this.entityIdByRowId.get(${k}.rowId))&&this.messageIdByRowId.has(${k}.rowId)?(${c}.canEdit=!0,${c}.editDisposition="rewind"):(delete ${c}.canEdit,delete ${c}.editDisposition)`;
  const p2Old = `resolveEditTargetByEntityId(${t}){if(${t}!==this.currentEditableEntityId)return null;let ${n}=this.editTargetByEntityId.get(${t});`;
  const p2New = `resolveEditTargetByEntityId(${t}){let ${n}=this.editTargetByEntityId.get(${t});`;
  // 语法合法的宿主:P2 是类方法体（p2Old 本身含方法签名,放进 class 体）;
  // P1 按真实内核形态嵌入——else if 分支体是三元表达式语句,以 `;else` 收尾链到
  // 下一分支（压缩器产物;node 视三元为表达式语句,分号后接 else 合法）
  const original = `class X{${p2Old}return null}}\nfunction f(){if(0){a()}${p1Old};else{b()}}\nmodule.exports={f};`;
  fs.writeFileSync(target, original);

  const applied = run(CLI, ["--edit-all", target]);
  assert.strictEqual(applied.status, 0, applied.stderr || applied.stdout);
  assert.ok(/结构化锚点/.test(applied.stdout), "未走结构化兜底路径");
  const after = fs.readFileSync(target, "utf8");
  assert.ok(after.includes(p1New), "P1 未按捕获变量生成替换串");
  assert.ok(after.includes(p2New), "P2 未按捕获变量生成替换串");

  const checked = run(CLI, ["--edit-all", "--check", target]);
  assert.ok(/全消息可编辑: 已打/.test(checked.stdout), "--check 未识别结构化形态为已打");

  const again = run(CLI, ["--edit-all", target]);
  assert.ok(/已打，跳过/.test(again.stdout), "重复打未走幂等跳过");

  const reverted = run(CLI, ["--edit-all", "--revert", target]);
  assert.strictEqual(reverted.status, 0, reverted.stderr || reverted.stdout);
  assert.strictEqual(fs.readFileSync(target, "utf8"), original, "还原后与原始内容不一致");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("全消息可编辑：字面与结构均失配时拒绝盲改", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-editall-na-"));
  const target = path.join(dir, "zcode.cjs");
  fs.writeFileSync(target, "module.exports={};");
  const r = run(CLI, ["--edit-all", target]);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
  assert.ok(/拒绝盲改/.test(r.stdout), "结构失配未拒绝盲改");
  assert.strictEqual(fs.readFileSync(target, "utf8"), "module.exports={};", "拒绝后文件被改动");
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- 渲染层结构化锚点兜底（quota/menu-width）与 --doctor 体检 ---

/** 手工构建最小合法 asar（树 + 数据区，offset 相对 dataStart，与 asarOpen 读法一致）。 */
function makeTestAsar(asarPath, files) {
  const header = { files: {} };
  const chunks = [];
  let offset = 0;
  for (const f of files) {
    const parts = f.path.split("/");
    let node = header;
    for (let i = 0; i < parts.length - 1; i++) node = node.files[parts[i]] = node.files[parts[i]] || { files: {} };
    node.files[parts[parts.length - 1]] = { size: f.data.length, offset: String(offset) };
    chunks.push(f.data);
    offset += f.data.length;
  }
  const jsonBytes = Buffer.from(JSON.stringify(header), "utf8");
  const pad = (4 - (jsonBytes.length % 4)) % 4;
  const head = Buffer.alloc(16);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(8 + jsonBytes.length + pad, 4);
  head.writeUInt32LE(4 + jsonBytes.length + pad, 8);
  head.writeUInt32LE(jsonBytes.length, 12);
  fs.writeFileSync(asarPath, Buffer.concat([head, jsonBytes, Buffer.alloc(pad, 0), ...chunks]));
}

/** 渲染层候选文件要求 size≥100000，用纯 ASCII 行注释垫到门槛之上。 */
const padJs = (body) => Buffer.from(body + "\n//" + "x".repeat(120000), "utf8");

/** 合成最小安装布局：resources/app.asar + resources/glm/zcode.cjs（CLI 只接受安装根/.app/zcode.cjs）。
 *  返回安装根目录，asar 写在 <root>/resources/app.asar。 */
function makeFakeInstall(dir, asarFiles) {
  const root = path.join(dir, "ZCode.app", "Contents");
  fs.mkdirSync(path.join(root, "resources", "glm"), { recursive: true });
  fs.writeFileSync(path.join(root, "resources", "glm", "zcode.cjs"), "module.exports={};");
  makeTestAsar(path.join(root, "resources", "app.asar"), asarFiles);
  return root;
}

/** 从合成 asar 中读取指定条目字节（与 makeTestAsar 的布局约定一致）。 */
function readTestAsarEntry(asarPath, entryPath) {
  const raw = fs.readFileSync(asarPath);
  const headerSize = raw.readUInt32LE(4);
  const header = JSON.parse(raw.subarray(16, 16 + raw.readUInt32LE(12)).toString("utf8"));
  let node = header;
  for (const part of entryPath.split("/")) node = node.files[part];
  const off = 8 + headerSize + Number(node.offset);
  return raw.subarray(off, off + node.size);
}

test("去额度横幅：结构化锚点容忍未知变量名漂移（v1 三元档位），幂等、可还原", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-quota-v1s-"));
  const v = "QQzz", t = "TTrr";
  const body = `function q(e){let r=e.ratio;return ${v}.ratio<=.1?\`model-very-low\`:${v}.ratio<=.2?\`model-low\`:${v}.ratio<=.5?\`model-half-used\`:null}if(${t}>.1||!ii||ee.isReminderHidden)u();`;
  const original = padJs(body);
  const root = makeFakeInstall(dir, [{ path: "out/renderer/assets/styles-aa.js", data: original }]);
  const asar = path.join(root, "resources", "app.asar");
  const entry = "out/renderer/assets/styles-aa.js";
  const asarSizeBefore = fs.statSync(asar).size;

  const applied = run(CLI, ["--quota-banner", root]);
  assert.strictEqual(applied.status, 0, applied.stderr || applied.stdout);
  const after = readTestAsarEntry(asar, entry);
  assert.ok(after.includes(Buffer.from(`${v}.ratio<=-1?\`model-very-low\``)), "very-low 阈值未翻转");
  assert.ok(after.includes(Buffer.from(`${v}.ratio<=-1?\`model-low\``)), "low 阈值未翻转");
  assert.ok(after.includes(Buffer.from(`${v}.ratio<=-1?\`model-half-used\``)), "half-used 阈值未翻转");
  assert.ok(after.includes(Buffer.from(`${t}>.1||!ii||ee.isReminderHidden`)), "v2 形态被误改");
  assert.strictEqual(fs.statSync(asar).size, asarSizeBefore, "补丁改变了 asar 长度（应等长原地覆盖）");

  const checked = run(CLI, ["--quota-banner", "--check", root]);
  assert.ok(/已打 \| 锚点组: v1 结构化/.test(checked.stdout), "--check 未识别结构化形态为已打:\n" + checked.stdout);

  const again = run(CLI, ["--quota-banner", root]);
  assert.ok(/已打（v1 结构化.*），跳过/.test(again.stdout), "重复打未走幂等跳过");

  const reverted = run(CLI, ["--quota-banner", "--revert", root]);
  assert.strictEqual(reverted.status, 0, reverted.stderr || reverted.stdout);
  assert.ok(readTestAsarEntry(asar, entry).equals(original), "还原后与原始内容不一致");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("去额度横幅：结构化锚点容忍未知变量名漂移（v2 提醒式），幂等、可还原", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-quota-v2s-"));
  const body = "if(!(r===null||r<=0||TT>.1||!ii||ee.isReminderHidden?.(i,t)))u();";
  const original = padJs(body);
  const root = makeFakeInstall(dir, [{ path: "out/renderer/assets/styles-bb.js", data: original }]);
  const asar = path.join(root, "resources", "app.asar");
  const entry = "out/renderer/assets/styles-bb.js";
  const asarSizeBefore = fs.statSync(asar).size;

  const applied = run(CLI, ["--quota-banner", root]);
  assert.strictEqual(applied.status, 0, applied.stderr || applied.stdout);
  const after = readTestAsarEntry(asar, entry);
  assert.ok(after.includes(Buffer.from("TT>-1||!ii||ee.isReminderHidden")), "提醒阈值未翻转");
  assert.strictEqual(fs.statSync(asar).size, asarSizeBefore, "补丁改变了 asar 长度（应等长原地覆盖）");

  const checked = run(CLI, ["--quota-banner", "--check", root]);
  assert.ok(/已打 \| 锚点组: v2 结构化/.test(checked.stdout), "--check 未识别 v2 结构化已打:\n" + checked.stdout);

  const reverted = run(CLI, ["--quota-banner", "--revert", root]);
  assert.strictEqual(reverted.status, 0, reverted.stderr || reverted.stdout);
  assert.ok(readTestAsarEntry(asar, entry).equals(original), "还原后与原始内容不一致");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("模型菜单加宽：结构化锚点容忍默认宽变量名漂移，幂等、可还原", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-menu-s-"));
  const w = "ZQy";
  const body = `const cls = ${w}??\`w-max min-w-[min(12rem,var(--radix-dropdown-menu-content-available-width))] max-w-(--radix-dropdown-menu-content-available-width)\`;const narrow = \`w-40 min-w-0 max-w-(--radix-dropdown-menu-content-available-width)\`;`;
  const original = padJs(body);
  const root = makeFakeInstall(dir, [{ path: "out/renderer/assets/styles-cc.js", data: original }]);
  const asar = path.join(root, "resources", "app.asar");
  const entry = "out/renderer/assets/styles-cc.js";
  const asarSizeBefore = fs.statSync(asar).size;

  const applied = run(CLI, ["--menu-width", root]);
  assert.strictEqual(applied.status, 0, applied.stderr || applied.stdout);
  const after = readTestAsarEntry(asar, entry);
  assert.ok(after.includes(Buffer.from("`w-96 min-w-0 max-w-(--radix-dropdown-menu-content-available-width)`")), "点②未加宽");
  assert.ok(after.includes(Buffer.from(`${w}??\`w-max`)), "点① native 形态被误改");
  assert.strictEqual(fs.statSync(asar).size, asarSizeBefore, "补丁改变了 asar 长度（应等长原地覆盖）");

  const checked = run(CLI, ["--menu-width", "--check", root]);
  assert.ok(/已打 \| 锚点组: 结构化/.test(checked.stdout), "--check 未识别结构化组已打:\n" + checked.stdout);

  const again = run(CLI, ["--menu-width", root]);
  assert.ok(/已打（结构化.*），跳过/.test(again.stdout), "重复打未走幂等跳过");

  const reverted = run(CLI, ["--menu-width", "--revert", root]);
  assert.strictEqual(reverted.status, 0, reverted.stderr || reverted.stdout);
  assert.ok(readTestAsarEntry(asar, entry).equals(original), "还原后与原始内容不一致");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("模型拉取：V8 锚点组（3.17 $Kn/xR）端到端 apply/check/revert 幂等往返", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-mh-v8-"));
  const root = makeFakeInstall(dir, []);
  const asar = path.join(root, "resources", "app.asar");
  // 合成 3.17 形态：preload 第四代 witness（i→r）、renderer V8 组件 $Kn/xR、HDR 锚点链
  const preload = Buffer.from(
    'exposeInMainWorld("zcode",{connectRemote:s((t,n,r)=>S.ipcRenderer.invoke(v.ConnectRemote,{target:t,requestId:n,...r||{}}),"connectRemote")});',
    "utf8");
  const main = Buffer.from("const boot=1;\n", "utf8");
  const rendBody = [
    "const X=`button`;",
    "const f={formatMessage:()=>({})};",
    "const xR=(e)=>e.providerName;",
    "function $Kn({providerId:e,providerName:t,providerEnabled:n=!0,providerAccess:r,models:i,onTestModel:a,onModelCommit:o,onModelEnabledChange:s,onDeleteModel:c,onAddModel:l,onReorderModelIds:u,settingsRevision:d=0}){return null}",
    "function ModelSection(e){let w=`openai`,E=`https://x`,O=`k`;",
    "return (0,$.jsxs)(`div`,{children:[(0,$.jsx)(`span`,{children:f.formatMessage({id:`settings.modelProvider.models`})}),(0,$.jsxs)(X,{type:`button`,children:`add`}),(0,$.jsx)($Kn,{providerId:e.providerId,providerName:xR(e),providerEnabled:e.enabled})]})}",
    "",
  ].join("\n");
  const rend = padJs(rendBody);
  // 重建 asar：preload + main + renderer 三条目
  fs.rmSync(asar, { force: true });
  makeTestAsar(asar, [
    { path: "out/preload/index.cjs", data: preload },
    { path: "out/main/index.js", data: main },
    { path: "out/renderer/assets/styles-v8.js", data: rend },
  ]);
  const asarSizeBefore = fs.statSync(asar).size;

  const applied = run(CLI, ["--modelhub", root]);
  assert.strictEqual(applied.status, 0, applied.stderr || applied.stdout);
  assert.ok(/模型拉取补丁注入完成/.test(applied.stdout), "apply 未成功:\n" + applied.stdout);

  const checked = run(CLI, ["--modelhub", "--check", root]);
  assert.ok(/已打/.test(checked.stdout), "--check 未报告已打:\n" + checked.stdout);
  assert.ok(/锚点组 v8/.test(checked.stdout), "--check 未识别 V8 锚点组:\n" + checked.stdout);

  const again = run(CLI, ["--modelhub", root]);
  assert.ok(/已打模型拉取补丁/.test(again.stdout), "重复打未走幂等跳过:\n" + again.stdout);

  // renderer 三点注入形态校验：签名/传参/头部按钮都已进入
  const raw = fs.readFileSync(asar);
  assert.ok(raw.includes(Buffer.from("mhEndpoint:__mhEp", "utf8")), "签名缺 mhEndpoint 形参");
  assert.ok(raw.includes(Buffer.from("mhEndpoint:{apiType:w,baseUrl:E,apiKey:O},", "utf8")), "调用点缺端点传参");
  assert.ok(raw.includes(Buffer.from("拉取模型", "utf8")), "头部缺拉取按钮");
  assert.ok(fs.statSync(asar).size > asarSizeBefore, "重打包后尺寸应增长（新增注入块）");

  const reverted = run(CLI, ["--modelhub", "--revert", root]);
  assert.strictEqual(reverted.status, 0, reverted.stderr || reverted.stdout);
  // 逐条目比对：三条目都应精确回到原始字节
  const rd = (p) => readTestAsarEntry(asar, p);
  assert.ok(rd("out/preload/index.cjs").equals(preload), "preload 还原不一致");
  assert.ok(rd("out/main/index.js").equals(main), "main 还原不一致");
  assert.ok(rd("out/renderer/assets/styles-v8.js").equals(rend), "renderer 还原不一致");
  assert.ok(!fs.existsSync(asar + ".modelhub-patch.json"), "revert 后 sidecar 未清理");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("--doctor --json 在合成安装上输出合法 JSON 汇总（退出码语义）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-doctor-"));
  const root = path.join(dir, "ZCode.app", "Contents");
  fs.mkdirSync(path.join(root, "resources", "glm"), { recursive: true });
  fs.writeFileSync(path.join(root, "resources", "glm", "zcode.cjs"),
    'module.exports=[["3009",{code:as.ModelRateLimited,reason:bs.RateLimited,retryReason:tl.RateLimited,retryable:!1}]];');

  const r = run(CLI, ["--doctor", "--json", root]);
  assert.strictEqual(r.status, 2, "缺 asar（存在未知项）时退出码应为 2");
  const data = JSON.parse(r.stdout);
  assert.strictEqual(data.zcode_patcher_doctor, 1, "缺少报告标记");
  assert.ok(Array.isArray(data.rows) && data.rows.length === 10, "rows 应为 10 项");
  const byName = Object.fromEntries(data.rows.map((x) => [x.name, x]));
  assert.strictEqual(byName["模型 3009 重试"].state, "not", "3009 锚点存在应为未打");
  assert.strictEqual(byName["思考等级透传"].state, "na", "无锚点应为不适用");
  assert.strictEqual(byName["去额度骚扰横幅"].state, "unknown", "缺 asar 的项应为未知");
  assert.ok(data.summary.unknown >= 1 && data.summary.na === 1, "汇总计数不正确");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("TUI 10 项补丁时按 0 可快选第 10 项", () => {
  const tui = fs.readFileSync(TUI, "utf8");
  assert.ok(tui.includes("const quick = n === 0 ? rows.length : n;"), "缺少 0 键映射到第 10 项");
  assert.ok(tui.includes("1-9/0 快选补丁"), "菜单提示未说明 0 键");
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
