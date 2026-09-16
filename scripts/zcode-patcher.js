#!/usr/bin/env node
"use strict";
/**
 * ZCode 客户端补丁工具（零依赖 Node 版）
 * =====================================
 *
 * 对本地 ZCode 安装打五类补丁（均自动探测安装位置、幂等、可定点还原）。
 * 本文件是 zcode_patcher.py 的完整等价重写（Python 版已退役）；
 * 锚点替换全部在字节（Buffer）层面进行，规避文本模式的编码往返风险。
 *
 * 一、思维强度透传（内核 zcode.cjs，默认功能）
 *   让「不在内核白名单里的模型」也遵循 config.json 里配置的思维强度档位。
 *   原理：内核档位解析函数把档位翻译成线上参数
 *   ({anthropic:{effort,thinking}} / {openaiCompatible:{reasoningEffort}})，
 *   但参数表 providerOptionsByLevel 只给白名单模型（claude/glm/deepseek 等家族）下发；
 *   自定义供应商模型拿到的是空表，档位被选中却不产生任何请求参数。
 *   补丁在取参处加兜底：查表为空时直接用档位名合成参数——
 *   白名单模型不受影响（它们的表非空，?? 短路）。
 *   档位 -> anthropic thinking.budget_tokens 映射：
 *     low=4000  medium=8000  high=16000  xhigh=32000  max=32000  其它档名=16000
 *     disabled/none/off/nothink -> thinking disabled
 *
 * 二、用量页去截断（app.asar，--usage-chart）
 *   设置→用量 的趋势图只画 Top6 模型、饼图只画 Top5 并把其余合并为「其他模型」。
 *   解析 asar 头定位渲染文件，把截断表达式替换为全量版本，
 *   空格补齐到原字节长度后原地覆盖（asar 头/offset/unpacked 零改动）。
 *   原始字节备份在 app.asar.chart-patch.json，可整体还原。
 *
 * 三、TPS 统计栏（app.asar，--tps-footer）
 *   向渲染层 out/renderer/index.html 注入 zcode-tps.js：
 *   输入框工具栏常驻统计胶囊 ● 时间 · 首 token · tok/s · out（当前会话最近一轮，
 *   切换会话即消失），数据取自页面内 MessagePort 会话事件流，无常驻服务。
 *   重打包级修改：整体重排 asar 目录、对改动文件重算 integrity。
 *   原件备份 app.asar.tps.bak，记录在 app.asar.tps-patch.json，可整体还原。
 *
 * 四、模型拉取补丁（app.asar，--modelhub）
 *   来源：https://github.com/CSSZYF/zcode-modelhub-patch (v1.2.1, MIT) 的注入载荷
 *   （modelhub_payload.json，require 直接加载），逻辑为本脚本重新实现：
 *   渠道页「拉取模型」按钮/请求头模拟/视觉探测/删除持久化。
 *   渲染文件按内容锚点定位（不依赖带哈希的文件名）；还原为外科手术式
 *   （sidecar 按路径记录三个条目的原始字节，定点写回，不整包覆盖）。
 *
 * 五、全消息可编辑（内核 zcode.cjs，--edit-all）
 *   同样来自 zcode-modelhub-patch 的 engine 补丁（P1/P2 两处替换）：
 *   解除「只有最后一条用户消息能编辑」的限制。独立 sidecar zcode.cjs.editall.json，
 *   还原走文本反向替换而非整文件备份，与思考等级补丁（不同函数区域）互不干扰。
 *
 * 六、去额度骚扰横幅（app.asar，--quota-banner）
 *   关闭「{model} 今日免费计划额度剩余 x%，可升级获得更稳定额度」升级广告横幅。
 *   原理：渲染层阈值函数按剩余比例产出横幅类型——≤50%/≤20%/≤10% 分别是
 *   half-used/low/very-low 三个广告档（额度还剩一半就开始催升级）；
 *   补丁把三个阈值等长改为 -1（比例恒 ≥0，永不命中）。比例 ≤0 的
 *   model-exhausted/daily-exhausted 与并发受限/供应商受限/MCP 通知等
 *   有用提示全部保留。等长原地覆盖，asar 头零改动，状态记录
 *   app.asar.quota-patch.json，可定点还原。
 *
 * 用法：
 *   node zcode-patcher.js                       # 思维强度补丁：自动探测全部安装并打（幂等）
 *   node zcode-patcher.js --check               # 只看思维强度补丁状态
 *   node zcode-patcher.js --revert              # 还原内核备份
 *   node zcode-patcher.js --extract             # 提取当前内核锚点（新版本无已知锚点时）
 *   node zcode-patcher.js --usage-chart         # 用量页去截断（同样支持 --check/--revert）
 *   node zcode-patcher.js --tps-footer          # TPS 统计栏注入（同样支持 --check/--revert）
 *   node zcode-patcher.js --modelhub            # 模型拉取补丁（同样支持 --check/--revert）
 *   node zcode-patcher.js --edit-all            # 全消息可编辑（同样支持 --check/--revert）
 *   node zcode-patcher.js "D:\\ZCode"           # 只处理指定安装（安装根目录/.app/zcode.cjs 均可）
 *
 * 注意：ZCode 升级会覆盖 zcode.cjs 与 app.asar，升级后需重新执行对应补丁；
 *      打完补丁完全退出并重启 ZCode 后生效。依赖 Node.js（任意 LTS 版本）。
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

// ---------------------------------------------------------------- 通用

function die(msg) { console.error("\n[x] " + msg); process.exit(1); }
function readJson(p) { return JSON.parse(fs.readFileSync(p, "utf8")); }
function writeJson(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 1), "utf8"); }
function rmQuiet(p) { try { fs.rmSync(p, { force: true }); } catch { /* 静默 */ } }

/** 原子替换目标文件。Windows 下目标可能被杀软扫描/索引服务/ZCode 残留句柄短暂占用（EBUSY/EPERM），
 *  退避重试几次再放弃，避免一过性占用直接崩栈。 */
function renameReplace(from, to, attempts = 4) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      if (e.code !== "EBUSY" && e.code !== "EPERM" && e.code !== "EACCES") throw e;
      last = e;
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250 * (i + 1)); } catch { /* 无 Atomics.wait 则立即重试 */ }
    }
  }
  throw last;
}

/** 非重叠计数（与 Python bytes.count 语义一致） */
function countBytes(hay, needle) {
  let n = 0, i = 0;
  if (!needle.length) return 0;
  while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

function replaceOnce(data, from, to) {
  const idx = data.indexOf(from);
  if (idx === -1) throw new Error("替换目标未找到");
  return Buffer.concat([data.subarray(0, idx), to, data.subarray(idx + from.length)]);
}

// ---------------------------------------------------------------- asar 内核

/** 读整个 asar：返回 { raw, header(树), dataStart }。 */
function asarOpen(asar) {
  const raw = fs.readFileSync(asar);
  if (raw.length < 16) die(`asar 文件过小: ${asar}`);
  if (raw.readUInt32LE(0) !== 4) die(`asar 头格式不符（首 uint32=${raw.readUInt32LE(0)}，期望 4）: ${asar}`);
  const headerSize = raw.readUInt32LE(4);
  const jsonLen = raw.readUInt32LE(12);
  let header;
  try {
    header = JSON.parse(raw.subarray(16, 16 + jsonLen).toString("utf8"));
  } catch (e) {
    die(`asar 头 JSON 解析失败: ${asar}`);
  }
  return { raw, header, dataStart: 8 + headerSize };
}

/** yield 风格的遍历换成收集数组：返回 [{path, ent}]（目录与 unpacked 条目不产出）。 */
function walkEntries(node, prefix = "", out = []) {
  const files = node.files || {};
  for (const name of Object.keys(files)) {
    const ent = files[name];
    const p = prefix ? `${prefix}/${name}` : name;
    if (ent.files) walkEntries(ent, p, out);
    else if (!ent.unpacked) out.push({ path: p, ent });
  }
  return out;
}

function entryBytes(state, ent) {
  const off = state.dataStart + Number(ent.offset);
  return state.raw.subarray(off, off + ent.size);
}

/** asar 条目 integrity（SHA256 全文 + 4MB 分块 hex），与 @electron/asar 格式一致 */
function entryIntegrity(data, blockSize = 4194304) {
  const blocks = [];
  for (let i = 0; i < data.length; i += blockSize) {
    blocks.push(crypto.createHash("sha256").update(data.subarray(i, i + blockSize)).digest("hex"));
  }
  return {
    algorithm: "SHA256",
    hash: crypto.createHash("sha256").update(data).digest("hex"),
    blockSize,
    blocks,
  };
}

/**
 * 通用 asar 重打包：树中删除 remove 条目，overwrite 覆盖/新增文件数据并重算 integrity，
 * 全部条目 offset 重排；写临时文件、回读校验后原子替换。返回新文件大小。
 * 关键坑（改本函数前必读）：offset 重排会直接改写条目，此后从旧文件切片必须用
 * 重排前快照的旧位置；新增条目的树插入必须在重排前完成。
 */
function repackAsar(asar, overwrite, remove, tmpSuffix = ".tps-tmp") {
  const state = asarOpen(asar);
  const { raw, header, dataStart } = state;

  // overwrite 中树里尚不存在的路径（新增文件）按层级插入占位条目
  for (const p of Object.keys(overwrite)) {
    const parts = p.split("/");
    let node = header;
    for (let i = 0; i < parts.length - 1; i++) {
      node.files = node.files || {};
      node = node.files[parts[i]] = node.files[parts[i]] || { files: {} };
    }
    node.files = node.files || {};
    if (!node.files[parts[parts.length - 1]]) {
      node.files[parts[parts.length - 1]] = { size: 0, offset: "0" };
    }
  }

  // 删除 remove 条目（空的目录一并移除）
  function purge(node, prefix) {
    const files = node.files || {};
    for (const name of Object.keys(files)) {
      const ent = files[name];
      const p = prefix ? `${prefix}/${name}` : name;
      if (ent.files) {
        purge(ent, p);
        if (!Object.keys(ent.files).length) delete files[name];
      } else if (remove.has(p)) {
        delete files[name];
      }
    }
  }
  purge(header, "");

  // 重排前快照旧位置（emit 二次读数据时用）
  const oldPositions = new Map();
  for (const { path: p, ent } of walkEntries(header)) {
    oldPositions.set(p, { off: Number(ent.offset), size: ent.size });
  }
  let cursor = 0;

  function entryData(p) {
    if (Object.prototype.hasOwnProperty.call(overwrite, p)) return overwrite[p];
    const pos = oldPositions.get(p);
    if (!pos) throw new Error(`重打包时找不到条目数据: ${p}`);
    return raw.subarray(dataStart + pos.off, dataStart + pos.off + pos.size);
  }

  function relayout(node, prefix) {
    const files = node.files || {};
    for (const name of Object.keys(files)) {
      const ent = files[name];
      const p = prefix ? `${prefix}/${name}` : name;
      if (ent.files) { relayout(ent, p); continue; }
      if (ent.unpacked) continue;
      const data = entryData(p);
      ent.size = data.length;
      ent.offset = String(cursor);
      if (Object.prototype.hasOwnProperty.call(overwrite, p)) {
        ent.integrity = entryIntegrity(data);
      }
      cursor += data.length;
    }
  }
  relayout(header, "");

  const jsonBytes = Buffer.from(JSON.stringify(header), "utf8");
  const pad = (4 - (jsonBytes.length % 4)) % 4;
  const head = Buffer.alloc(16);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(8 + jsonBytes.length + pad, 4);
  head.writeUInt32LE(4 + jsonBytes.length + pad, 8);
  head.writeUInt32LE(jsonBytes.length, 12);

  const tmp = asar + tmpSuffix;
  const out = [head, jsonBytes, Buffer.alloc(pad, 0)];
  function emit(node, prefix) {
    const files = node.files || {};
    for (const name of Object.keys(files)) {
      const ent = files[name];
      const p = prefix ? `${prefix}/${name}` : name;
      if (ent.files) { emit(ent, p); continue; }
      if (ent.unpacked) continue;
      out.push(entryData(p));
    }
  }
  emit(header, "");
  fs.writeFileSync(tmp, Buffer.concat(out));

  // 回读校验：重开临时文件，逐条比对 overwrite 条目字节
  const vState = asarOpen(tmp);
  const vFiles = new Map(walkEntries(vState.header).map((x) => [x.path, x.ent]));
  try {
    for (const [p, want] of Object.entries(overwrite)) {
      const ent = vFiles.get(p);
      if (!ent) throw new Error(`重打包校验失败（条目缺失）: ${p}`);
      const got = entryBytes(vState, ent);
      if (got.length !== want.length || !got.equals(want)) {
        throw new Error(`重打包校验失败: ${p}`);
      }
    }
  } catch (e) {
    rmQuiet(tmp);
    throw e;
  }
  renameReplace(tmp, asar);
  return fs.statSync(asar).size;
}

/** 重打包后数据区位移/尺寸变化：
 *  - chart sidecar：记录含绝对 offset，按 path+size 重定位 offset 与 asar_size 指纹；
 *  - modelhub / TPS sidecar：按 path 记录原始字节、无 offset，只把 asar_size 指纹
 *    刷新到当前值，避免其它补丁重打包后记录被当作失配作废。 */
function refreshSidecarsAfterRepack(asar) {
  const state = asarOpen(asar);
  const entries = new Map(walkEntries(state.header).map((x) => [x.path, x.ent]));
  const cur = fs.statSync(asar).size;

  const dataStart = state.dataStart;
  const chartSide = asar + ".chart-patch.json";
  if (fs.existsSync(chartSide)) {
    let recs = [];
    try { recs = readJson(chartSide).patches || []; } catch { recs = []; }
    let changed = false;
    for (const r of recs) {
      const ent = entries.get(r.path);
      // chart 记录的 offset 是绝对文件偏移（dataStart+相对），重定位时必须换算成绝对
      const abs = dataStart + Number(ent ? ent.offset : -1);
      if (ent && ent.size === r.size && (abs !== r.offset || r.asar_size !== cur)) {
        r.offset = abs;
        r.asar_size = cur;
        changed = true;
      }
    }
    if (changed) {
      writeJson(chartSide, { patches: recs });
      console.log(`[*] 已同步 ${path.basename(chartSide)} 的 offset/指纹到重打包后的 asar`);
    }
  }

  const mhSide = asar + ".modelhub-patch.json";
  if (fs.existsSync(mhSide)) {
    try {
      const rec = readJson(mhSide);
      const files = rec.files || [];
      if (rec.asar_size !== cur && files.length && files.every((f) => entries.get(f.path))) {
        rec.asar_size = cur;
        writeJson(mhSide, rec);
      }
    } catch { /* 静默 */ }
  }

  const tpsSide = asar + ".tps-patch.json";
  if (fs.existsSync(tpsSide)) {
    try {
      const rec = readJson(tpsSide);
      if (rec.asar_size !== cur && rec.index_path && entries.get(rec.index_path)) {
        rec.asar_size = cur;
        writeJson(tpsSide, rec);
      }
    } catch { /* 静默 */ }
  }

  const contSide = asar + ".continue-patch.json";
  if (fs.existsSync(contSide)) {
    try {
      const rec = readJson(contSide);
      if (rec.asar_size !== cur && rec.index_path && entries.get(rec.index_path)) {
        rec.asar_size = cur;
        writeJson(contSide, rec);
      }
    } catch { /* 静默 */ }
  }

  const mwSide = asar + ".menuwidth-patch.json";
  if (fs.existsSync(mwSide)) {
    try {
      const rec = readJson(mwSide);
      if (rec.asar_size !== cur && entries.get(rec.path)) {
        rec.asar_size = cur;
        writeJson(mwSide, rec);
      }
    } catch { /* 静默 */ }
  }

  const qbSide = asar + ".quota-patch.json";
  if (fs.existsSync(qbSide)) {
    try {
      const rec = readJson(qbSide);
      if (rec.asar_size !== cur && entries.get(rec.path)) {
        rec.asar_size = cur;
        writeJson(qbSide, rec);
      }
    } catch { /* 静默 */ }
  }
}

// ---------------------------------------------------------------- 思考等级补丁

// 兜底合成器：档位名 -> 各协议命名空间的线上参数
const HELPER =
  'function zCfgEffort(e){' +
  'let t=String(e).toLowerCase();' +
  'if(t==="disabled"||t==="none"||t==="off"||t==="nothink")' +
  'return{anthropic:{thinking:{type:"disabled"}},openaiCompatible:{thinking:{type:"disabled"}}};' +
  'if(t==="enabled"||t==="on")' +
  'return{anthropic:{effort:"high",thinking:{type:"enabled",budgetTokens:16e3}},' +
  'openaiCompatible:{thinking:{type:"enabled"}}};' +
  'let r={low:4e3,medium:8e3,high:16e3,xhigh:32e3,max:32e3}[t]??16e3,' +
  'o=t==="max"?"xhigh":t,' +
  'n={anthropic:{thinking:{type:"enabled",budgetTokens:r}},openaiCompatible:{},openai:{}};' +
  '["low","medium","high","xhigh","max"].includes(t)&&(n.anthropic.effort=t);' +
  '["none","minimal","low","medium","high","xhigh"].includes(o)&&' +
  '(n.openaiCompatible.reasoningEffort=o,n.openai.reasoningEffort=o);' +
  'return n}';

const MARKER = "zCfgEffort";

// 已知版本的档位解析函数原文（全文唯一锚点；符号名随构建版本变化）。
const ANCHORS = {
  "3.8.1":
    "function sD(e,t,r){if(!e)return;let n=G_e(e,r);" +
    "if(!n?.enabled||n.levels.length===0)return;" +
    "let o=t?.trim(),i=Fgo(e,o,n.levels);if(o&&!i)return;" +
    "let a=i??gXe(n);" +
    'return a?{level:a,providerOptions:n.providerOptionsByLevel?.[a]}:void 0}',
  "3.9.1":
    "function AD(e,t,r){if(!e)return;let n=Zye(e,r);" +
    "if(!n?.enabled||n.levels.length===0)return;" +
    "let o=t?.trim(),i=fxo(e,o,n.levels);if(o&&!i)return;" +
    "let a=i??utt(n);" +
    'return a?{level:a,providerOptions:n.providerOptionsByLevel?.[a]}:void 0}',
  "3.9.2":
    "function RD(e,t,r){if(!e)return;let n=Xye(e,r);" +
    "if(!n?.enabled||n.levels.length===0)return;" +
    "let o=t?.trim(),i=Sxo(e,o,n.levels);if(o&&!i)return;" +
    "let a=i??ptt(n);" +
    'return a?{level:a,providerOptions:n.providerOptionsByLevel?.[a]}:void 0}',
  "3.11.2":
    "function mN(e,t,r){if(!e)return;let n=k2e(e,r);" +
    "if(!n?.enabled||n.levels.length===0)return;" +
    "let o=t?.trim(),i=CIo(e,o,n.levels);if(o&&!i)return;" +
    "let s=i??_nt(n);" +
    'return s?{level:s,providerOptions:n.providerOptionsByLevel?.[s]}:void 0}',
};

/** 锚点函数前插入兜底合成器，返回处在查表后追加 ?? 兜底。
 *  兼容不同版本的局部变量名（3.8.1/3.9.1 用 a，3.11.2 用 s）。 */
function replacementFor(anchor) {
  const m = anchor.match(/return (\w+)\?\{level:\1,providerOptions:n\.providerOptionsByLevel\?\.\[\1\]\}/);
  if (!m) throw new Error(`锚点返回表达式形态未识别：${anchor.slice(-160)}`);
  const v = m[1];
  const patchedReturn =
    `return ${v}?{level:${v},` +
    `providerOptions:n.providerOptionsByLevel?.[${v}]??zCfgEffort(${v})}:void 0}`;
  return HELPER + anchor.slice(0, m.index) + patchedReturn;
}

/** 按结构特征（而非符号名）在内核中定位档位解析函数，返回可直接加入 ANCHORS 的锚点。 */
function extractAnchor(target) {
  const bak = target.replace(/\.cjs$/, "") + ".cjs.bak";
  let data;
  try {
    data = fs.readFileSync(target);
  } catch (e) {
    console.log(`[!] 无权限读取 ${target}`);
    return null;
  }
  if (data.includes(Buffer.from(MARKER)) && fs.existsSync(bak)) {
    data = fs.readFileSync(bak);
    console.log("[*] 当前文件已打补丁，改从原始备份提取锚点");
  }

  const needle = Buffer.from("providerOptionsByLevel?.[");
  const candidates = new Set();
  let start = 0;
  for (;;) {
    const idx = data.indexOf(needle, start);
    if (idx === -1) break;
    start = idx + 1;
    // 向前找最近的 "function "（ASCII）
    let fstart = -1;
    for (let i = idx - 9; i >= 0; i--) {
      if (data[i] === 0x66 && data.subarray(i, i + 9).toString("latin1") === "function ") { fstart = i; break; }
    }
    if (fstart === -1) continue;
    const brace = data.indexOf(0x7b, fstart); // "{"
    if (brace === -1) continue;
    let depth = 0, j = brace;
    for (; j < data.length; j++) {
      if (data[j] === 0x7b) depth++;
      else if (data[j] === 0x7d) { depth--; if (depth === 0) break; }
    }
    if (j >= data.length) continue;
    const cand = data.subarray(fstart, j + 1).toString("latin1");
    const body = cand.slice(9);
    if (cand.includes("{level:") && cand.endsWith("}:void 0}") && !body.includes("function ")) {
      candidates.add(cand.replace(/\?\?zCfgEffort\(\w\)/g, ""));
    }
  }

  if (!candidates.size) {
    console.log("[!] 未找到符合结构特征的候选，目标函数形态可能已变，需人工分析");
    return null;
  }
  if (candidates.size > 1) {
    console.log(`[!] 找到 ${candidates.size} 个候选（应为 1），请人工甄别：`);
    for (const c of candidates) console.log("    -", c.slice(0, 150));
    return null;
  }
  return candidates.values().next().value;
}

// ---------------------------------------------------------------- 安装位置探测

const norm = (s) => s.toLowerCase().replace(/ /g, "").replace(/-/g, "");

function fromRunningProcesses(found) {
  if (process.platform !== "win32") return;
  try {
    // powershell 管道输出默认跟随 OEM 代码页（简中为 GBK），按 utf8 解码含非 ASCII 的路径会乱码；
    // 先把控制台输出编码强制为 UTF-8 再取进程路径（无控制台句柄时允许失败，退回原行为）
    const r = spawnSync("powershell", ["-NoProfile", "-Command",
      "try{[Console]::OutputEncoding=[System.Text.Encoding]::UTF8}catch{};" +
      "Get-Process | Where-Object {$_.Path} | Select-Object -ExpandProperty Path -Unique"],
      { encoding: "utf8", timeout: 15000 });
    for (const line of (r.stdout || "").split(/\r?\n/)) {
      const p = line.trim();
      if (/\.exe$/i.test(p) && norm(path.basename(p)).includes("zcode")) {
        found.push(path.dirname(p));
      }
    }
  } catch { /* 静默 */ }
}

function fromRegistry(found) {
  if (process.platform !== "win32") return;
  // reg.exe 输出跟随 OEM 代码页（中文路径按 utf8 解码会乱码），且覆盖不到 per-user 安装；
  // 统一改走 PowerShell 读卸载键：HKLM 64/32 位视图 + HKCU（%LOCALAPPDATA% 安装的注册处），输出强制 UTF-8
  const ps =
    "try{[Console]::OutputEncoding=[System.Text.Encoding]::UTF8}catch{};" +
    "$roots=@('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'," +
    "'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'," +
    "'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall');" +
    "foreach($r in $roots){if(Test-Path $r){Get-ChildItem $r|ForEach-Object{$_.GetValue('InstallLocation')}}}";
  try {
    const r = spawnSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8", timeout: 20000 });
    for (const line of (r.stdout || "").split(/\r?\n/)) {
      const loc = line.trim();
      if (loc) found.push(loc);
    }
  } catch { /* 静默 */ }
}

function fromCommonDirs(found) {
  // 按平台收敛探测目录：Windows 上扫描 /Applications、/opt 等会解析到当前盘根目录，纯属无效 IO
  let bases;
  if (process.platform === "win32") {
    bases = [
      process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.ProgramW6432,
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs") : null,
      process.env.LOCALAPPDATA || null, // Squirrel 免安装版落 %LOCALAPPDATA%\ZCode
    ];
  } else if (process.platform === "darwin") {
    bases = ["/Applications", path.join(process.env.HOME || "", "Applications")];
  } else {
    bases = ["/opt", "/usr/share"];
  }
  bases = bases.filter(Boolean);
  for (const base of bases) {
    let entries;
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || !norm(e.name).includes("zcode")) continue;
      const full = path.join(base, e.name);
      found.push(e.name.endsWith(".app") ? path.join(full, "Contents") : full);
    }
  }
}

function discover() {
  const roots = [];
  for (const probe of [fromRunningProcesses, fromRegistry, fromCommonDirs]) {
    try { probe(roots); } catch { /* 静默 */ }
  }
  const seen = new Set();
  const result = [];
  for (const root of roots) {
    const cjs = path.join(root, "resources", "glm", "zcode.cjs");
    let key = cjs;
    try { key = fs.realpathSync(cjs); } catch { /* 保留原样 */ }
    if (fs.existsSync(cjs) && fs.statSync(cjs).isFile() && !seen.has(key)) {
      seen.add(key);
      result.push(cjs);
    }
  }
  return result;
}

/** 显式路径兼容：安装根目录 / macOS .app 包 / zcode.cjs 文件本身 */
function resolveTarget(arg) {
  if (!arg) {
    const found = discover();
    if (!found.length) die("未探测到任何 ZCode 安装；请把安装目录路径作为参数传入");
    return found;
  }
  const roots = /\.app$/i.test(path.basename(arg)) ? [arg, path.join(arg, "Contents")] : [arg];
  for (const root of roots) {
    const cjs = path.join(root, "resources", "glm", "zcode.cjs");
    if (fs.existsSync(cjs)) return [cjs];
  }
  die(`指定路径下找不到 zcode.cjs：${arg}`);
}

// ---------------------------------------------------------------- 思考等级补丁处理

function processEffort(target, checkOnly, revert) {
  const backup = target.replace(/\.cjs$/, "") + ".cjs.bak";
  let data;
  try {
    data = fs.readFileSync(target);
  } catch {
    console.log(`[!] 无权限读取 ${target}（Program Files 需要管理员运行本脚本）`);
    return;
  }
  const markerBuf = Buffer.from(MARKER);
  const hasMarker = data.includes(markerBuf);
  const hasBackup = fs.existsSync(backup);
  const state = hasMarker ? "已打" : (hasBackup ? "已还原/未打" : "未打");
  console.log(`[*] ${target}`);
  console.log(`    ${data.length.toLocaleString()} 字节 | 补丁: ${state} | 备份: ${hasBackup ? "有" : "无"}`);

  if (revert) {
    if (!hasBackup) { console.log("    [.] 没有备份，跳过"); return; }
    try {
      fs.copyFileSync(backup, target);
      console.log("    [+] 已从备份还原");
    } catch {
      console.log("    [!] 无权限写入，请用管理员身份运行本脚本");
    }
    return;
  }
  if (checkOnly) return;
  if (hasMarker) { console.log("    [=] 已打过补丁，跳过"); return; }

  // 每版锚点统计出现次数：恰好有一版 =1 才动手
  let matched = null;
  const detail = [];
  for (const [ver, a] of Object.entries(ANCHORS)) {
    const cnt = countBytes(data, Buffer.from(a, "utf8"));
    detail.push(`${ver}=${cnt}`);
    if (cnt === 1) matched = { ver, anchor: a };
    else if (cnt > 1) matched = null; // 多版命中都拒绝
  }
  if (!matched || detail.filter((d) => d.endsWith("=1")).length !== 1) {
    console.log(`    [!] 锚点匹配异常（${detail.join(", ")}，期望恰有一版=1），` +
                "版本可能不在已支持列表，按文档重新提取锚点后添加");
    return;
  }
  console.log(`    [+] 匹配版本锚点: ${matched.ver}`);

  try {
    if (!hasBackup) {
      fs.copyFileSync(target, backup);
    } else if (!data.equals(fs.readFileSync(backup))) {
      // 内核已被外部替换（ZCode 升级）：旧备份属于上一版，刷新为新版原样，避免将来还原成降级
      fs.copyFileSync(target, backup);
      console.log("    [*] 检测到内核已被升级覆盖，备份 zcode.cjs.bak 已刷新为新版原样");
    }
    const anchorBuf = Buffer.from(matched.anchor, "utf8");
    const idx = data.indexOf(anchorBuf);
    const patched = Buffer.concat([
      data.subarray(0, idx),
      Buffer.from(replacementFor(matched.anchor), "utf8"),
      data.subarray(idx + anchorBuf.length),
    ]);
    fs.writeFileSync(target, patched);
  } catch (e) {
    if (e.code === "EACCES" || e.code === "EPERM" || e.code === "EBUSY") {
      console.log("    [!] 无权限写入或文件被占用（ZCode 正在运行/杀软扫描；Program Files 需要管理员），未修改。" +
                  "可完全退出 ZCode 后用管理员身份的 PowerShell 重新运行本脚本");
      return;
    }
    throw e;
  }
  const ok = fs.readFileSync(target).includes(markerBuf);
  console.log(`    [${ok ? "+" : "!"}] 补丁${ok ? "写入成功" : "写入失败"}${hasBackup ? "（备份 -> " + backup + "）" : ""}`);
}

// ---------------------------------------------------------------- 用量页去截断

// 每项：key=定位用的文件名特征，pattern=截断表达式原文，replacement=等价短替换（空格补齐）
const USAGE_PATCHES = [
  {
    key: "AppUsageDailyModelTrendChart",
    pattern: Buffer.from("n.models.slice(0,6)"),
    replacement: Buffer.from("n.models"),
    desc: "每日趋势图：去掉 Top6 截断，全部模型出线",
  },
  {
    key: "AppUsageModelUsagePieChart",
    pattern: Buffer.from("i=n.length>Q,a=i?Q-1:Q"),
    replacement: Buffer.from("i=!1,a=1/0"),
    desc: "模型用量饼图：去掉 Top5+其他模型 合并，全部模型出块",
  },
];

/** 读取补丁记录；带 asar_size 指纹校验：升级覆盖 app.asar 后旧 offset 不再可信，失配即作废。 */
function loadChartSidecar(side, asarSize) {
  if (!fs.existsSync(side)) return [];
  let data;
  try { data = readJson(side); } catch { return []; }
  let recs;
  if (data && Array.isArray(data.patches)) recs = data.patches;
  else if (Array.isArray(data)) recs = data;
  else recs = [data];
  return recs.filter((r) => r && (asarSize === undefined || r.asar_size === asarSize));
}

function processUsageChart(asar, checkOnly, revert) {
  const side = asar + ".chart-patch.json";
  const asarSize = fs.statSync(asar).size;
  const state = asarOpen(asar);
  const entries = walkEntries(state.header).map(({ path: p, ent }) => ({
    path: p, ent, off: state.dataStart + Number(ent.offset), size: ent.size,
  }));

  const specs = [];
  for (const item of USAGE_PATCHES) {
    const match = entries.filter((e) => e.path.includes(item.key));
    if (match.length !== 1) {
      console.log(`[!] ${asar}\n    ${item.key} 命中 ${match.length} 个文件（期望 1），该项跳过`);
      continue;
    }
    specs.push([item, match[0]]);
  }

  if (revert) {
    const saved = loadChartSidecar(side, asarSize);
    if (!saved.length) {
      console.log(`[.] ${asar}\n    没有当前版本的 sidecar 备份，跳过`);
      return;
    }
    const fd = fs.openSync(asar, "r+");
    try {
      for (const rec of saved) {
        fs.writeSync(fd, Buffer.from(rec.original_b64, "base64"), 0, rec.size, rec.offset);
      }
    } finally {
      fs.closeSync(fd);
    }
    rmQuiet(side);
    console.log(`[+] ${asar}\n    已还原 ${saved.length} 处原始字节`);
    return;
  }

  console.log(`[*] ${asar}`);
  const saved = loadChartSidecar(side, asarSize);
  let changed = false;
  for (const [item, spec] of specs) {
    const fname = spec.path.split("/").pop();
    const raw = fs.readFileSync(asar).subarray(spec.off, spec.off + spec.size); // 读后即拷
    const buf = Buffer.from(raw);
    if (!buf.includes(item.pattern)) {
      console.log(`    [=] ${fname} | 已打（${item.desc}）`);
      continue;
    }
    const cnt = countBytes(buf, item.pattern);
    if (cnt !== 1) {
      console.log(`    [!] ${fname} | 截断表达式出现 ${cnt} 次（期望 1），拒绝盲改`);
      continue;
    }
    if (checkOnly) {
      console.log(`    [ ] ${fname} | 未打（${item.desc}）`);
      continue;
    }
    const replaced = Buffer.concat([
      buf.subarray(0, buf.indexOf(item.pattern)),
      item.replacement,
      buf.subarray(buf.indexOf(item.pattern) + item.pattern.length),
    ]);
    const padded = Buffer.alloc(spec.size, 0x20); // 空格补齐到原长度，原地覆盖，asar 头零改动
    replaced.copy(padded);
    if (!saved.some((r) => r.offset === spec.off)) {
      saved.push({
        path: spec.path, offset: spec.off, size: spec.size, asar_size: asarSize,
        original_b64: buf.toString("base64"),
      });
    }
    const fd = fs.openSync(asar, "r+");
    try {
      fs.writeSync(fd, padded, 0, padded.length, spec.off);
      const back = Buffer.alloc(spec.size);
      fs.readSync(fd, back, 0, spec.size, spec.off);
      const ok = !back.includes(item.pattern) && back.length === spec.size;
      console.log(`    [${ok ? "+" : "!"}] ${fname} | ${ok ? "写入成功（" + item.desc + "）" : "写入失败"}`);
    } finally {
      fs.closeSync(fd);
    }
    changed = true;
  }
  if (changed && !checkOnly) {
    writeJson(side, { patches: saved });
    console.log(`    原始字节备份: ${path.basename(side)}`);
  }
}

// ---------------------------------------------------------------- 模型菜单加宽

// 供应商子菜单两档固定宽度类 → w-96（384px）。等长字节原地覆盖：w-48/w-40 与 w-96 同为 4 字节，
// asar 头/offset/integrity 零改动；编译 CSS 为 Tailwind v4 动态 spacing（width:calc(var(--spacing)*N)），
// w-96 样式必然存在，不存在"改了类名没样式"的问题。
// 点① = 模型选择器 CF 组件的子菜单默认宽（未传 providerSubmenuClassName 的全部调用点，
//        内置渠道选中态即走此路）；点② = composer 选中自定义渠道时传入的窄分支（保留
//        --radix-dropdown-menu-content-available-width 钳制，窗口过窄时由 Radix 碰撞规避兜底）。
const MENU_WIDTH_PATCHES = [
  {
    pattern: Buffer.from("j??`w-48`", "utf8"),
    replacement: Buffer.from("j??`w-96`", "utf8"),
    desc: "子菜单默认宽 w-48(192px)→w-96(384px)",
  },
  {
    pattern: Buffer.from("`w-40 min-w-0 max-w-(--radix-dropdown-menu-content-available-width)`", "utf8"),
    replacement: Buffer.from("`w-96 min-w-0 max-w-(--radix-dropdown-menu-content-available-width)`", "utf8"),
    desc: "自定义渠道子菜单 w-40(160px)→w-96(384px)，保留视口钳制",
  },
];
for (const it of MENU_WIDTH_PATCHES) {
  if (it.pattern.length !== it.replacement.length) die(`模型菜单补丁点等长校验失败: ${it.desc}`);
}

function processMenuWidth(asar, checkOnly, revert) {
  const side = asar + ".menuwidth-patch.json";
  const asarSize = fs.statSync(asar).size;
  const state = asarOpen(asar);

  // 定位：两锚点（原始形态或已打形态）落在同一渲染层大文件；文件名哈希随版本变，不硬编码
  const candidates = [];
  for (const { path: p, ent } of walkEntries(state.header)) {
    if (!p.startsWith("out/renderer/assets/") || !p.endsWith(".js") || ent.size < 100000) continue;
    const bytes = entryBytes(state, ent);
    const stat = MENU_WIDTH_PATCHES.map((it) => ({
      o: countBytes(bytes, it.pattern),
      n: countBytes(bytes, it.replacement),
    }));
    if (stat.some((s) => s.o || s.n)) candidates.push({ path: p, ent, stat });
  }
  if (candidates.length !== 1) {
    console.log(`[!] ${asar}\n    模型菜单锚点命中 ${candidates.length} 个文件（期望 1），版本结构可能已变，跳过`);
    return;
  }
  const { path: rel, ent, stat } = candidates[0];
  const fname = rel.split("/").pop();
  const absOff = state.dataStart + Number(ent.offset);
  const kinds = stat.map((s) =>
    s.o === 1 && s.n === 0 ? "orig" : s.o === 0 && s.n === 1 ? "patched" : "bad");
  const patchedCnt = kinds.filter((k) => k === "patched").length;
  const badCnt = kinds.filter((k) => k === "bad").length;
  const total = MENU_WIDTH_PATCHES.length;

  if (checkOnly) {
    const st = badCnt ? "锚点计数异常（拒绝操作）"
      : patchedCnt === total ? "已打"
      : patchedCnt === 0 ? "未打"
      : `不完整（${patchedCnt}/${total}）`;
    let sideOk = false;
    try { sideOk = fs.existsSync(side) && readJson(side).asar_size === asarSize; } catch { sideOk = false; }
    console.log(`[*] ${asar}\n    模型菜单加宽: ${st} | sidecar: ${sideOk ? "有" : "无"} | 渲染文件: ${fname}`);
    return;
  }

  if (revert) {
    if (patchedCnt === 0) {
      console.log(`[.] ${asar}\n    未打模型菜单加宽补丁，跳过`);
      return;
    }
    if (badCnt) {
      console.log(`    [!] ${fname} | 锚点出现次数异常，拒绝盲改`);
      return;
    }
    const raw = Buffer.from(entryBytes(state, ent)); // 读后即拷：写入偏移全部基于该快照
    const fd = fs.openSync(asar, "r+");
    let ok = 0;
    try {
      for (let i = 0; i < total; i++) {
        if (kinds[i] !== "patched") continue;
        const it = MENU_WIDTH_PATCHES[i];
        fs.writeSync(fd, it.pattern, 0, it.pattern.length, absOff + raw.indexOf(it.replacement));
        ok++;
      }
    } finally {
      fs.closeSync(fd);
    }
    rmQuiet(side);
    console.log(`[+] ${asar}\n    已还原 ${ok}/${total} 处原始宽度（${fname}）`);
    return;
  }

  // 打补丁
  if (badCnt) {
    console.log(`    [!] ${fname} | 锚点出现次数异常，拒绝盲改`);
    return;
  }
  if (patchedCnt === total) {
    console.log(`    [=] ${fname} | 已打，跳过`);
    return;
  }
  const raw = Buffer.from(entryBytes(state, ent));
  const fd = fs.openSync(asar, "r+");
  try {
    for (let i = 0; i < total; i++) {
      if (kinds[i] !== "orig") continue;
      const it = MENU_WIDTH_PATCHES[i];
      fs.writeSync(fd, it.replacement, 0, it.replacement.length, absOff + raw.indexOf(it.pattern));
      console.log(`    [+] ${fname} | ${it.desc}`);
    }
  } finally {
    fs.closeSync(fd);
  }
  // 回读校验：等长替换，文件总长必须不变，且每点恰好只剩已打形态
  const state2 = asarOpen(asar);
  const ent2 = walkEntries(state2.header).find((x) => x.path === rel)?.ent;
  const back = ent2 ? entryBytes(state2, ent2) : Buffer.alloc(0);
  const okAll = back.length === ent.size
    && MENU_WIDTH_PATCHES.every((it) => countBytes(back, it.replacement) === 1 && countBytes(back, it.pattern) === 0);
  if (!okAll) console.log(`    [!] 回读校验未通过，请 --menu-width --revert 还原后排查`);
  writeJson(side, { asar_size: asarSize, path: rel, patches: MENU_WIDTH_PATCHES.map((it) => ({ desc: it.desc })) });
  console.log(`    状态记录: ${path.basename(side)}${okAll ? "" : "（校验异常）"}`);
}

// ---------------------------------------------------------------- 去额度骚扰横幅

// 关闭「{model} 今日免费计划额度剩余 x%，可升级…」升级广告横幅。等长字节原地覆盖：
// 渲染层阈值函数按剩余比例产出横幅类型——ratio<=0 走 exhaustedKind（model-exhausted /
// daily-exhausted），prefix 为 daily 时恒 null，随后 ≤.1→very-low、≤.2→low、≤.5→half-used。
// 把三个骚扰档阈值改成 -1（比例恒 ≥0，永不命中），广告档全部消失；
// 额度真正耗尽（0%）、服务端整体耗尽、并发受限、供应商受限、MCP 通知等有用提示全部保留。
// 哈希文件名随版本变，按内容锚点定位（锚点/已打形态在全 asar 均唯一）。
const QUOTA_BANNER_PATCHES = [
  {
    pattern: Buffer.from("e.ratio<=.1?`model-very-low`", "utf8"),
    replacement: Buffer.from("e.ratio<=-1?`model-very-low`", "utf8"),
    desc: "额度骚扰档 very-low(≤10%) 关闭",
  },
  {
    pattern: Buffer.from("e.ratio<=.2?`model-low`", "utf8"),
    replacement: Buffer.from("e.ratio<=-1?`model-low`", "utf8"),
    desc: "额度骚扰档 low(≤20%) 关闭",
  },
  {
    pattern: Buffer.from("e.ratio<=.5?`model-half-used`", "utf8"),
    replacement: Buffer.from("e.ratio<=-1?`model-half-used`", "utf8"),
    desc: "额度骚扰档 half-used(≤50%) 关闭",
  },
];
for (const it of QUOTA_BANNER_PATCHES) {
  if (it.pattern.length !== it.replacement.length) die(`额度横幅补丁点等长校验失败: ${it.desc}`);
}

function processQuotaBanner(asar, checkOnly, revert) {
  const side = asar + ".quota-patch.json";
  const asarSize = fs.statSync(asar).size;
  const state = asarOpen(asar);

  // 定位：锚点（原始形态或已打形态）落在同一渲染层大文件；文件名哈希随版本变，不硬编码
  const candidates = [];
  for (const { path: p, ent } of walkEntries(state.header)) {
    if (!p.startsWith("out/renderer/assets/") || !p.endsWith(".js") || ent.size < 100000) continue;
    const bytes = entryBytes(state, ent);
    const stat = QUOTA_BANNER_PATCHES.map((it) => ({
      o: countBytes(bytes, it.pattern),
      n: countBytes(bytes, it.replacement),
    }));
    if (stat.some((s) => s.o || s.n)) candidates.push({ path: p, ent, stat });
  }
  if (candidates.length !== 1) {
    console.log(`[!] ${asar}\n    额度横幅锚点命中 ${candidates.length} 个文件（期望 1），版本结构可能已变，跳过`);
    return;
  }
  const { path: rel, ent, stat } = candidates[0];
  const fname = rel.split("/").pop();
  const absOff = state.dataStart + Number(ent.offset);
  const kinds = stat.map((s) =>
    s.o === 1 && s.n === 0 ? "orig" : s.o === 0 && s.n === 1 ? "patched" : "bad");
  const patchedCnt = kinds.filter((k) => k === "patched").length;
  const badCnt = kinds.filter((k) => k === "bad").length;
  const total = QUOTA_BANNER_PATCHES.length;

  if (checkOnly) {
    const st = badCnt ? "锚点计数异常（拒绝操作）"
      : patchedCnt === total ? "已打"
      : patchedCnt === 0 ? "未打"
      : `不完整（${patchedCnt}/${total}）`;
    let sideOk = false;
    try { sideOk = fs.existsSync(side) && readJson(side).asar_size === asarSize; } catch { sideOk = false; }
    console.log(`[*] ${asar}\n    去额度骚扰横幅: ${st} | sidecar: ${sideOk ? "有" : "无"} | 渲染文件: ${fname}`);
    return;
  }

  if (revert) {
    if (patchedCnt === 0) {
      console.log(`[.] ${asar}\n    未打去额度骚扰横幅补丁，跳过`);
      return;
    }
    if (badCnt) {
      console.log(`    [!] ${fname} | 锚点出现次数异常，拒绝盲改`);
      return;
    }
    const raw = Buffer.from(entryBytes(state, ent)); // 读后即拷：写入偏移全部基于该快照
    const fd = fs.openSync(asar, "r+");
    let ok = 0;
    try {
      for (let i = 0; i < total; i++) {
        if (kinds[i] !== "patched") continue;
        const it = QUOTA_BANNER_PATCHES[i];
        fs.writeSync(fd, it.pattern, 0, it.pattern.length, absOff + raw.indexOf(it.replacement));
        ok++;
      }
    } finally {
      fs.closeSync(fd);
    }
    rmQuiet(side);
    console.log(`[+] ${asar}\n    已还原 ${ok}/${total} 处额度横幅阈值（${fname}）`);
    return;
  }

  // 打补丁
  if (badCnt) {
    console.log(`    [!] ${fname} | 锚点出现次数异常，拒绝盲改`);
    return;
  }
  if (patchedCnt === total) {
    console.log(`    [=] ${fname} | 已打，跳过`);
    return;
  }
  const raw = Buffer.from(entryBytes(state, ent));
  const fd = fs.openSync(asar, "r+");
  try {
    for (let i = 0; i < total; i++) {
      if (kinds[i] !== "orig") continue;
      const it = QUOTA_BANNER_PATCHES[i];
      fs.writeSync(fd, it.replacement, 0, it.replacement.length, absOff + raw.indexOf(it.pattern));
      console.log(`    [+] ${fname} | ${it.desc}`);
    }
  } finally {
    fs.closeSync(fd);
  }
  // 回读校验：等长替换，文件总长必须不变，且每点恰好只剩已打形态
  const state2 = asarOpen(asar);
  const ent2 = walkEntries(state2.header).find((x) => x.path === rel)?.ent;
  const back = ent2 ? entryBytes(state2, ent2) : Buffer.alloc(0);
  const okAll = back.length === ent.size
    && QUOTA_BANNER_PATCHES.every((it) => countBytes(back, it.replacement) === 1 && countBytes(back, it.pattern) === 0);
  if (!okAll) console.log(`    [!] 回读校验未通过，请 --quota-banner --revert 还原后排查`);
  writeJson(side, { asar_size: asarSize, path: rel, patches: QUOTA_BANNER_PATCHES.map((it) => ({ desc: it.desc })) });
  console.log(`    状态记录: ${path.basename(side)}${okAll ? "" : "（校验异常）"}`);
}

// ---------------------------------------------------------------- TPS 统计栏

const TPS_INDEX_PATH = "out/renderer/index.html";
const TPS_SCRIPT_PATH = "out/renderer/zcode-tps.js";
const TPS_TAG = `<script src="./${TPS_SCRIPT_PATH.split("/").pop()}"></script>`;

function processTpsFooter(asar, checkOnly, revert, tpsSrc) {
  const side = asar + ".tps-patch.json";
  const bak = asar + ".tps.bak";
  const asarSize = fs.statSync(asar).size;

  const state = asarOpen(asar);
  const entMap = new Map(walkEntries(state.header).map((x) => [x.path, x.ent]));
  const idxEnt = entMap.get(TPS_INDEX_PATH);
  if (!idxEnt) {
    console.log(`[!] ${asar}\n    未找到 ${TPS_INDEX_PATH}，版本结构可能已变，跳过`);
    return;
  }
  const idxBytes = Buffer.from(entryBytes(state, idxEnt));
  const tagged = idxBytes.includes(Buffer.from(TPS_TAG));
  const installed = tagged && entMap.has(TPS_SCRIPT_PATH);

  let saved = null;
  if (fs.existsSync(side)) {
    try {
      const rec = readJson(side);
      if (rec.asar_size === asarSize) saved = rec;
    } catch { saved = null; }
  }

  if (checkOnly) {
    const st = installed ? "已打" : (tagged ? "不完整（index.html 有 tag 但缺脚本条目）" : "未打");
    console.log(`[*] ${asar}\n    TPS 统计栏注入: ${st} | sidecar: ${saved ? "有" : "无"} | 备份: ${fs.existsSync(bak) ? "有" : "无"}`);
    return;
  }

  if (revert) {
    if (!installed && !saved) {
      console.log(`[.] ${asar}\n    未打 TPS 注入，跳过`);
      return;
    }
    let originalIdx;
    if (countBytes(idxBytes, Buffer.from(TPS_TAG)) === 1) {
      // 精确 strip 自身 tag，保留其它补丁对 index.html 的改动（任意安装/还原顺序安全）
      originalIdx = replaceOnce(idxBytes, Buffer.from(TPS_TAG), Buffer.alloc(0));
    } else if (saved && saved.index_original_b64) {
      originalIdx = Buffer.from(saved.index_original_b64, "base64");
    } else {
      originalIdx = replaceOnce(idxBytes, Buffer.from(TPS_TAG), Buffer.alloc(0));
    }
    const newSize = repackAsar(asar, { [TPS_INDEX_PATH]: originalIdx }, new Set([TPS_SCRIPT_PATH]));
    rmQuiet(side);
    rmQuiet(bak);
    refreshSidecarsAfterRepack(asar);
    console.log(`[+] ${asar}\n    已还原 index.html 并移除 ${TPS_SCRIPT_PATH}（新大小 ${newSize.toLocaleString()} 字节，备份已清理）`);
    return;
  }

  if (installed) {
    console.log(`[=] ${asar}\n    已打 TPS 注入，跳过`);
    return;
  }
  if (countBytes(idxBytes, Buffer.from("</body>")) !== 1) {
    console.log(`[!] ${asar}\n    index.html 的 </body> 出现 ${countBytes(idxBytes, Buffer.from("</body>"))} 次（期望 1），拒绝盲改`);
    return;
  }
  if (!tpsSrc) tpsSrc = path.join(__dirname, "zcode-tps.js");
  if (!fs.existsSync(tpsSrc)) die(`[!] 找不到注入源脚本 ${tpsSrc}（可用 --tps-src 指定路径）`);
  const scriptBytes = fs.readFileSync(tpsSrc);

  if (!fs.existsSync(bak)) {
    fs.copyFileSync(asar, bak);
  } else if (fs.statSync(bak).size !== asarSize) {
    // asar 已被升级覆盖（尺寸变化）：旧整包备份属于上一版，刷新
    fs.copyFileSync(asar, bak);
    console.log("[*] 检测到 app.asar 已被升级覆盖，整包备份 app.asar.tps.bak 已刷新");
  }

  const newIdx = replaceOnce(idxBytes, Buffer.from("</body>"), Buffer.concat([Buffer.from(TPS_TAG), Buffer.from("</body>")]));
  const newSize = repackAsar(asar, { [TPS_INDEX_PATH]: newIdx, [TPS_SCRIPT_PATH]: scriptBytes }, new Set());
  writeJson(side, {
    asar_size: newSize,
    index_path: TPS_INDEX_PATH,
    script_entry: TPS_SCRIPT_PATH,
    index_original_b64: idxBytes.toString("base64"),
  });
  refreshSidecarsAfterRepack(asar);
  console.log(`[+] ${asar}\n    TPS 统计栏注入完成（${path.basename(tpsSrc)} ${scriptBytes.length.toLocaleString()} 字节 -> ${TPS_SCRIPT_PATH}，index.html 已挂载）\n` +
              `    原件备份: ${path.basename(bak)} | 记录: ${path.basename(side)}`);
}

// ---------------------------------------------------------------- 继续按钮

const CONT_INDEX_PATH = "out/renderer/index.html";
const CONT_SCRIPT_PATH = "out/renderer/zcode-continue.js";
const CONT_TAG = `<script src="./${CONT_SCRIPT_PATH.split("/").pop()}"></script>`;

function processContinueBtn(asar, checkOnly, revert, contSrc) {
  const side = asar + ".continue-patch.json";
  const asarSize = fs.statSync(asar).size;

  const state = asarOpen(asar);
  const entMap = new Map(walkEntries(state.header).map((x) => [x.path, x.ent]));
  const idxEnt = entMap.get(CONT_INDEX_PATH);
  if (!idxEnt) {
    console.log(`[!] ${asar}\n    未找到 ${CONT_INDEX_PATH}，版本结构可能已变，跳过`);
    return;
  }
  const idxBytes = Buffer.from(entryBytes(state, idxEnt));
  const tagged = idxBytes.includes(Buffer.from(CONT_TAG));
  const scriptCur = entMap.has(CONT_SCRIPT_PATH) ? Buffer.from(entryBytes(state, entMap.get(CONT_SCRIPT_PATH))) : null;

  if (!contSrc) contSrc = path.join(__dirname, "zcode-continue.js");
  const srcExists = fs.existsSync(contSrc);
  const scriptSrc = srcExists ? fs.readFileSync(contSrc) : null;
  // 已打 = tag 在 + 条目在 + 条目内容与当前注入源逐字节一致（源更新后会自动重注入=原地升级）
  const installed = tagged && scriptCur && scriptSrc && scriptCur.equals(scriptSrc);

  let saved = null;
  if (fs.existsSync(side)) {
    try {
      const rec = readJson(side);
      if (rec.asar_size === asarSize) saved = rec;
    } catch { saved = null; }
  }

  if (checkOnly) {
    const st = installed ? "已打"
      : tagged && scriptCur ? "不完整（tag/脚本条目与当前源不一致，重跑可原地升级）"
      : tagged ? "不完整（index.html 有 tag 但缺脚本条目）"
      : "未打";
    console.log(`[*] ${asar}\n    继续按钮注入: ${st} | sidecar: ${saved ? "有" : "无"} | 渲染文件: ${CONT_INDEX_PATH.split("/").pop()}`);
    return;
  }

  if (revert) {
    if (!tagged && !scriptCur && !saved) {
      console.log(`[.] ${asar}\n    未打继续按钮注入，跳过`);
      return;
    }
    // 精确 strip 自身 tag，保留其它补丁对 index.html 的改动（任意安装/还原顺序安全）
    let newIdx;
    if (countBytes(idxBytes, Buffer.from(CONT_TAG)) === 1) {
      newIdx = replaceOnce(idxBytes, Buffer.from(CONT_TAG), Buffer.alloc(0));
    } else if (!tagged) {
      newIdx = idxBytes;
    } else if (saved && saved.index_original_b64) {
      newIdx = Buffer.from(saved.index_original_b64, "base64");
    } else {
      console.log(`[!] ${asar}\n    index.html 的 ${CONT_TAG} 出现 ${countBytes(idxBytes, Buffer.from(CONT_TAG))} 次（期望 1）且无 sidecar 兜底，拒绝盲改`);
      return;
    }
    // 脚本条目仅在与注入源/记录逐字节一致时删除，绝不误删用户改动过的内容
    const expect = scriptSrc || (saved && saved.script_b64 ? Buffer.from(saved.script_b64, "base64") : null);
    let remove = new Set();
    if (scriptCur && expect && scriptCur.equals(expect)) remove.add(CONT_SCRIPT_PATH);
    else if (scriptCur) console.log(`[!] 脚本条目 ${CONT_SCRIPT_PATH} 内容与注入记录不一致，保留不删（可手动处理）`);
    const newSize = repackAsar(asar, { [CONT_INDEX_PATH]: newIdx }, remove, ".cont-tmp");
    if (remove.has(CONT_SCRIPT_PATH)) rmQuiet(side);
    refreshSidecarsAfterRepack(asar);
    console.log(`[+] ${asar}\n    已还原 index.html${remove.has(CONT_SCRIPT_PATH) ? "并移除 " + CONT_SCRIPT_PATH : ""}（新大小 ${newSize.toLocaleString()} 字节）`);
    return;
  }

  if (installed) {
    console.log(`[=] ${asar}\n    已打继续按钮，跳过`);
    return;
  }
  if (!srcExists) die(`[!] 找不到注入源脚本 ${contSrc}（可用 --cont-src 指定路径）`);
  if (countBytes(idxBytes, Buffer.from("</body>")) !== 1) {
    console.log(`[!] ${asar}\n    index.html 的 </body> 出现 ${countBytes(idxBytes, Buffer.from("</body>"))} 次（期望 1），拒绝盲改`);
    return;
  }
  const newIdx = tagged ? idxBytes : replaceOnce(idxBytes, Buffer.from("</body>"), Buffer.concat([Buffer.from(CONT_TAG), Buffer.from("</body>")]));
  const newSize = repackAsar(asar, { [CONT_INDEX_PATH]: newIdx, [CONT_SCRIPT_PATH]: scriptSrc }, new Set(), ".cont-tmp");
  writeJson(side, {
    asar_size: newSize,
    index_path: CONT_INDEX_PATH,
    script_entry: CONT_SCRIPT_PATH,
    script_b64: scriptSrc.toString("base64"),
  });
  refreshSidecarsAfterRepack(asar);
  console.log(`[+] ${asar}\n    继续按钮注入完成（${path.basename(contSrc)} ${scriptSrc.length.toLocaleString()} 字节 -> ${CONT_SCRIPT_PATH}，index.html 已挂载）\n` +
              `    记录: ${path.basename(side)}`);
}

// ---------------------------------------------------------------- 模型拉取补丁

const MH_PRELOAD_REL = "out/preload/index.cjs";
const MH_MAIN_REL = "out/main/index.js";
const MH_MARK_PRELOAD = Buffer.from("modelhubFetchModels");
const MH_MARK_MAIN = Buffer.from("modelhub:fetch-models");
const MH_MARK_RENDER = Buffer.from("__mhPick");

function loadMhPayload() {
  const src = path.join(__dirname, "modelhub_payload.json");
  if (!fs.existsSync(src)) die(`[!] 缺少注入载荷 ${src}（应与 zcode-patcher.js 同目录分发）`);
  return readJson(src);
}

function processModelhub(asar, checkOnly, revert) {
  const side = asar + ".modelhub-patch.json";
  const ph = loadMhPayload();
  const asarSize = fs.statSync(asar).size;
  const state = asarOpen(asar);
  const entMap = new Map(walkEntries(state.header).map((x) => [x.path, x.ent]));

  // renderer 大文件定位：优先固定哈希名；构建哈希变化时按内容锚点回退（期望唯一命中）
  let rendRel = entMap.has(ph.RENDER_REL) ? ph.RENDER_REL : null;
  if (!rendRel) {
    const anchor = Buffer.from(ph.ORIG_ADD_BTN, "utf8");
    const hits = [];
    for (const [p, ent] of entMap) {
      if (!p.startsWith("out/renderer/assets/") || !p.endsWith(".js")) continue;
      if (ent.size < 100000) continue;
      if (entryBytes(state, ent).includes(anchor)) hits.push(p);
    }
    if (hits.length === 1) rendRel = hits[0];
    else {
      console.log(`[!] ${asar}\n    renderer 内容锚点命中 ${hits.length} 个文件（期望 1），版本结构可能已变，跳过`);
      return;
    }
  }
  if (!entMap.has(MH_PRELOAD_REL) || !entMap.has(MH_MAIN_REL)) {
    console.log(`[!] ${asar}\n    缺少 preload/main 条目，版本结构可能已变，跳过`);
    return;
  }

  const marks = [
    [MH_PRELOAD_REL, MH_MARK_PRELOAD],
    [MH_MAIN_REL, MH_MARK_MAIN],
    [rendRel, MH_MARK_RENDER],
  ];
  const tagged = marks.filter(([rel, mark]) => entryBytes(state, entMap.get(rel)).includes(mark)).length;

  let saved = null;
  if (fs.existsSync(side)) {
    try {
      const rec = readJson(side);
      if (rec.asar_size === asarSize) saved = rec;
    } catch { saved = null; }
  }

  if (checkOnly) {
    const st = tagged === 3 ? "已打" : (tagged ? `不完整（${tagged}/3）` : "未打");
    console.log(`[*] ${asar}\n    模型拉取补丁: ${st} | sidecar: ${saved ? "有" : "无"} | 渲染文件: ${rendRel.split("/").pop()}`);
    return;
  }

  if (revert) {
    const anyTagged = marks.some(([rel, mark]) => entryBytes(state, entMap.get(rel)).includes(mark));
    if (!anyTagged && !saved) {
      console.log(`[.] ${asar}\n    未打模型拉取补丁，跳过`);
      return;
    }
    const stickyRec = saved && (saved.files || []).find((f) => f.path === rendRel && f.sticky_after);
    const overwrite = {};
    let exact = 0, fallback = 0;
    for (const [rel, mark] of marks) {
      const cur = Buffer.from(entryBytes(state, entMap.get(rel)));
      if (!cur.includes(mark)) {
        overwrite[rel] = cur;   // 已是原版
        continue;
      }
      let r = null;
      if (rel === MH_PRELOAD_REL) {
        const inj = Buffer.from(ph.PRELOAD_INJECT, "utf8");
        if (countBytes(cur, inj) === 1) r = replaceOnce(cur, inj, Buffer.alloc(0));
      } else if (rel === MH_MAIN_REL) {
        const h = Buffer.from(ph.MAIN_HANDLERS, "utf8");
        if (countBytes(cur, h) === 1) r = replaceOnce(cur, h, Buffer.alloc(0));
      } else {
        r = revertMhRenderer(cur, ph, stickyRec ? stickyRec.sticky_after : null);
      }
      if (r === null) {
        const f = saved && (saved.files || []).find((x) => x.path === rel);
        if (!f) { console.log(`[!] ${asar}\n    ${rel} 反向替换失败且无 sidecar 字节兜底，拒绝盲改`); return; }
        r = Buffer.from(f.original_b64, "base64");
        fallback++;
      } else exact++;
      overwrite[rel] = r;
    }
    repackAsar(asar, overwrite, new Set(), ".modelhub-tmp");
    rmQuiet(side);
    refreshSidecarsAfterRepack(asar);
    console.log(`[+] ${asar}\n    已还原 3 个条目（精确反向替换 ${exact}，字节兜底 ${fallback}，记录已清理）`);
    return;
  }

  if (tagged === 3) {
    console.log(`[=] ${asar}\n    已打模型拉取补丁，跳过`);
    return;
  }
  if (tagged) {
    console.log(`[!] ${asar}\n    注入状态不完整（${tagged}/3），先 --modelhub --revert 再重打`);
    return;
  }

  // —— 组装补丁字节（替换序列与上游 patch-core.js 一致，先校验锚点各唯一一次） ——
  const preBuf = Buffer.from(entryBytes(state, entMap.get(MH_PRELOAD_REL)));
  const mainBuf = Buffer.from(entryBytes(state, entMap.get(MH_MAIN_REL)));
  const rendBuf = Buffer.from(entryBytes(state, entMap.get(rendRel)));

  const preAnchor = Buffer.from(ph.PRELOAD_ANCHOR, "utf8");
  const preCnt = countBytes(preBuf, preAnchor);
  if (preCnt !== 1) {
    console.log(`[!] ${asar}\n    preload 锚点出现 ${preCnt} 次（期望 1），拒绝盲改`);
    return;
  }
  for (const key of ["ORIG_ADD_BTN", "ORIG_QPT", "STICKY_OLD", "LE_OLD"]) {
    const cnt = countBytes(rendBuf, Buffer.from(ph[key], "utf8"));
    if (cnt !== 1) {
      console.log(`[!] ${asar}\n    renderer 锚点 ${key} 出现 ${cnt} 次（期望 1），拒绝盲改`);
      return;
    }
  }

  const pNew = replaceOnce(
    preBuf, preAnchor,
    Buffer.from('exposeInMainWorld("zcode",{' + ph.PRELOAD_INJECT + "connectRemote", "utf8"));
  const mNew = Buffer.concat([mainBuf, Buffer.from(ph.MAIN_HANDLERS, "utf8")]);
  let rNew = replaceOnce(rendBuf, Buffer.from(ph.ORIG_ADD_BTN, "utf8"),
    Buffer.from(ph.ADD_BTN + "," + ph.ORIG_ADD_BTN, "utf8"));
  rNew = replaceOnce(rNew, Buffer.from(ph.ORIG_QPT, "utf8"), Buffer.from(ph.EDIT_WRAP, "utf8"));
  rNew = replaceOnce(rNew, Buffer.from(ph.STICKY_OLD, "utf8"), Buffer.from(ph.STICKY_NEW, "utf8"));
  rNew = replaceOnce(rNew, Buffer.from(ph.LE_OLD, "utf8"), Buffer.from(ph.LE_NEW, "utf8"));
  rNew = Buffer.concat([rNew, Buffer.from(ph.HELPER_BLOCK, "utf8")]);

  const overwrite = {
    [MH_PRELOAD_REL]: pNew,
    [MH_MAIN_REL]: mNew,
    [rendRel]: rNew,
  };
  const originals = [
    [MH_PRELOAD_REL, preBuf],
    [MH_MAIN_REL, mainBuf],
    [rendRel, rendBuf],
  ];
  // sticky_after 必须取「注入点」后文：STICKY_NEW 在文件里有大量自然出现，indexOf 会拿错；
  // 注入点 = STICKY_OLD 在原字节中的位置，替换后 NEW 就在同一 offset
  const soBuf = Buffer.from(ph.STICKY_OLD, "utf8");
  const soIdx = rendBuf.indexOf(soBuf);
  const stickyAfter = soIdx >= 0 ? rNew.subarray(soIdx + ph.STICKY_NEW.length, soIdx + ph.STICKY_NEW.length + 32).toString("base64") : null;
  const newSize = repackAsar(asar, overwrite, new Set(), ".modelhub-tmp");
  writeJson(side, {
    asar_size: newSize,
    renderer_path: rendRel,
    files: originals.map(([rel, b]) => ({
      path: rel, size: b.length, original_b64: b.toString("base64"),
      ...(rel === rendRel && stickyAfter ? { sticky_after: stickyAfter } : {}),
    })),
  });
  refreshSidecarsAfterRepack(asar);
  console.log(`[+] ${asar}\n    模型拉取补丁注入完成（preload/main/renderer 三条目改写）\n` +
              `    记录: ${path.basename(side)} | 新大小 ${newSize.toLocaleString()} 字节`);
}

// ------------------------------------------------- 增强提示词按钮（--enhance-btn，asar 重打包级）
// 注入四点：preload 暴露 IPC、main 尾部追加 handler、index.html 挂脚本、新增 zcode-enhance.js 条目。
// 还原全部为精确反向替换（不依赖 sidecar 字节），与 modelhub/TPS 任意顺序互不踩踏。

const ENH_INDEX_PATH = "out/renderer/index.html";
const ENH_SCRIPT_PATH = "out/renderer/zcode-enhance.js";
const ENH_TAG = `<script src="./zcode-enhance.js"></script>`;
const ENH_MARK_PRELOAD = Buffer.from("enhancePromptDraft");
const ENH_MARK_MAIN = Buffer.from("zcode-enhance:run");
const ENH_MARK_INDEX = Buffer.from(ENH_TAG);

/** enhance 的 main 追加块最终形态：模板对象以 JSON 字面量替换占位（apply 与 revert 必须用同一结果）。 */
function buildEnhanceMainBlock(ph) {
  const tpl = JSON.stringify({
    WB_SYS_WORKBUDDY: ph.WB_SYS_WORKBUDDY,
    WB_USER_WORKBUDDY: ph.WB_USER_WORKBUDDY,
    WB_SYS_CREATIVE: ph.WB_SYS_CREATIVE,
    WB_USER_CREATIVE: ph.WB_USER_CREATIVE,
    WB_PARA_RULES: ph.WB_PARA_RULES,
  });
  return Buffer.from(ph.ENH_MAIN_HANDLERS.replace("__WB_TEMPLATES__", () => tpl), "utf8");
}

function loadEnhanceSrc(explicit) {
  const p = explicit || path.join(__dirname, "zcode-enhance.js");
  if (!fs.existsSync(p)) die(`[!] 找不到注入源脚本 ${p}（可用 --enhance-src 指定路径）`);
  return fs.readFileSync(p);
}

function processEnhanceBtn(asar, checkOnly, revert, srcPath) {
  const ph = loadMhPayload();
  const state = asarOpen(asar);
  const entMap = new Map(walkEntries(state.header).map((x) => [x.path, x.ent]));
  const need = ["out/preload/index.cjs", "out/main/index.js", ENH_INDEX_PATH];
  if (need.some((p) => !entMap.has(p))) {
    console.log(`[!] ${asar}\n    缺少 preload/main/index 条目，版本结构可能已变，跳过`);
    return;
  }
  const preBuf = Buffer.from(entryBytes(state, entMap.get("out/preload/index.cjs")));
  const mainBuf = Buffer.from(entryBytes(state, entMap.get("out/main/index.js")));
  const idxBuf = Buffer.from(entryBytes(state, entMap.get(ENH_INDEX_PATH)));
  const scriptEnt = entMap.get(ENH_SCRIPT_PATH);

  const flags = [
    idxBuf.includes(ENH_MARK_INDEX),
    !!scriptEnt,
    preBuf.includes(ENH_MARK_PRELOAD),
    mainBuf.includes(ENH_MARK_MAIN),
  ];
  const partial = flags.filter(Boolean).length;
  const tagged = partial === 4;

  const anchorA = Buffer.from(ph.ENH_PRELOAD_ANCHOR_A, "utf8");
  const anchorB = Buffer.from(ph.ENH_PRELOAD_ANCHOR_B, "utf8");
  const injectNew = Buffer.from(ph.ENH_PRELOAD_INJECT, "utf8");
  const injectOld = ph.ENH_PRELOAD_INJECT_V1 ? Buffer.from(ph.ENH_PRELOAD_INJECT_V1, "utf8") : null;
  const handlers = buildEnhanceMainBlock(ph);
  const isV2 = mainBuf.includes(Buffer.from("zcode-enhance:list-models", "utf8"));
  // 新旧判读：主块与当前载荷逐字节一致、注入脚本与源文件一致，才算"已打（最新）"；
  // 载荷/脚本更新后 apply 会自动剥离旧注入重打（原地升级），无需先 revert。
  const enhSrcPath = srcPath || path.join(__dirname, "zcode-enhance.js");
  const scriptSrc = fs.existsSync(enhSrcPath) ? fs.readFileSync(enhSrcPath) : null;
  const mainIsCurrent = countBytes(mainBuf, handlers) === 1;
  const scriptIsCurrent = !!scriptEnt && !!scriptSrc && scriptSrc.equals(Buffer.from(entryBytes(state, scriptEnt)));

  if (checkOnly) {
    const st = tagged ? (isV2 ? (mainIsCurrent && scriptIsCurrent ? "已打" : "已打（载荷/脚本有更新，重跑 --enhance-btn 原地升级）")
                              : "已打（旧版，重跑 --enhance-btn 原地升级）")
                      : (partial ? `不完整（${partial}/4）` : "未打");
    console.log(`[*] ${asar}\n    增强提示词按钮: ${st}`);
    return;
  }

  /** 移除 main 里的 enhance 块：边界式优先（与载荷版本无关），精确整串兜底。 */
  function stripMainBlock(buf, bad) {
    const sM = Buffer.from('import{ipcMain as Zenh}from"electron";');
    const eM = Buffer.from('}catch(er){return{ok:false,error:String(er&&er.message||er)}}});');
    if (countBytes(buf, sM) === 1) {
      const s = buf.indexOf(sM);
      const eIdx = buf.indexOf(eM, s);   // modelhub 的 handler 结尾与 enhance 同串，从 enhance 起点向后取第一个
      if (eIdx !== -1) {
        let end = eIdx + eM.length;
        if (buf[end] === 0x0a) end += 1;   // 旧版载荷块尾自带换行：一并剥离，保证还原字节一致（后随 modelhub 块时其首字节为 i，无此换行）
        const cand = Buffer.concat([buf.subarray(0, s), buf.subarray(end)]);
        if (!cand.includes(ENH_MARK_MAIN)) return cand;   // 自检：移除后无残留
      }
    }
    const v1 = Buffer.from(ph.ENH_MAIN_HANDLERS_V1 || "", "utf8");
    const exact = countBytes(buf, handlers) === 1 ? handlers
                : (v1.length && countBytes(buf, v1) === 1 ? v1 : null);
    if (exact) {
      const out = replaceOnce(buf, exact, Buffer.alloc(0));
      if (!out.includes(ENH_MARK_MAIN)) return out;
    }
    bad.push("main handler 块边界不唯一");
    return buf;
  }

  /** 移除 preload 注入串：新版优先，旧版串兜底（升级前的存量安装）。 */
  function stripPreload(buf, bad) {
    for (const inj of [injectNew, injectOld].filter(Boolean)) {
      if (!buf.includes(inj)) continue;
      if (countBytes(buf, inj) !== 1) { bad.push("preload 注入串不唯一"); return buf; }
      return replaceOnce(buf, inj, Buffer.alloc(0));
    }
    return buf;
  }

  if (revert) {
    if (partial === 0) { console.log(`[.] ${asar}\n    未打增强按钮，跳过`); return; }
    let pre2 = preBuf, main2 = mainBuf, idx2 = idxBuf;
    const bad = [];
    if (pre2.includes(ENH_MARK_PRELOAD)) pre2 = stripPreload(pre2, bad);
    if (main2.includes(ENH_MARK_MAIN)) main2 = stripMainBlock(main2, bad);
    if (idx2.includes(ENH_MARK_INDEX)) {
      if (countBytes(idx2, ENH_MARK_INDEX) === 1) idx2 = replaceOnce(idx2, ENH_MARK_INDEX, Buffer.alloc(0));
      else bad.push("index tag 不唯一");
    }
    if (bad.length || pre2.includes(ENH_MARK_PRELOAD) || main2.includes(ENH_MARK_MAIN)) {
      console.log(`[!] ${asar}\n    ${bad.join("；") || "注入残留无法识别"}，拒绝盲改`);
      return;
    }
    repackAsar(asar,
      { "out/preload/index.cjs": pre2, "out/main/index.js": main2, [ENH_INDEX_PATH]: idx2 },
      new Set([ENH_SCRIPT_PATH]), ".enhance-tmp");
    refreshSidecarsAfterRepack(asar);
    console.log(`[+] ${asar}\n    已精确移除增强按钮注入（preload/main/index 复原，脚本条目已删）`);
    return;
  }

  // 打补丁 / 原地升级（旧版注入先剥离再按当前载荷重注入，partial 状态一并修复）
  if (tagged && isV2 && mainIsCurrent && scriptIsCurrent) { console.log(`[=] ${asar}\n    已打增强按钮（载荷为最新），跳过`); return; }
  const bad = [];
  let pre2 = stripPreload(preBuf, bad);
  let main2 = mainBuf.includes(ENH_MARK_MAIN) ? stripMainBlock(mainBuf, bad) : mainBuf;
  if (bad.length || pre2.includes(ENH_MARK_PRELOAD) || main2.includes(ENH_MARK_MAIN)) {
    console.log(`[!] ${asar}\n    ${bad.join("；") || "注入残留无法识别"}，先 --enhance-btn --revert 再重打`);
    return;
  }

  const cntA = countBytes(pre2, anchorA), cntB = countBytes(pre2, anchorB);
  if (cntA + cntB !== 1) {
    console.log(`[!] ${asar}\n    preload 锚点命中 ${cntA + cntB} 个（期望 1），拒绝盲改`);
    return;
  }
  const anchor = cntA === 1 ? anchorA : anchorB;
  const tail = cntA === 1 ? "connectRemote" : "modelhubFetchModels";
  const scriptBytes = loadEnhanceSrc(srcPath);

  const head = anchor.subarray(0, anchor.length - Buffer.byteLength(tail));
  const preNew = replaceOnce(pre2, anchor, Buffer.concat([head, injectNew, Buffer.from(tail)]));
  const sep = main2.length && main2[main2.length - 1] === 0x0a ? Buffer.alloc(0) : Buffer.from("\n");
  const mainNew = Buffer.concat([main2, sep, handlers]);
  let idxNew = idxBuf;
  if (!idxNew.includes(ENH_MARK_INDEX)) {
    if (countBytes(idxNew, Buffer.from("</body>")) !== 1) {
      console.log(`[!] ${asar}\n    index.html 的 </body> 出现 ${countBytes(idxNew, Buffer.from("</body>"))} 次（期望 1），拒绝盲改`);
      return;
    }
    idxNew = replaceOnce(idxNew, Buffer.from("</body>"), Buffer.concat([ENH_MARK_INDEX, Buffer.from("</body>")]));
  }

  const newSize = repackAsar(asar, {
    "out/preload/index.cjs": preNew,
    "out/main/index.js": mainNew,
    [ENH_INDEX_PATH]: idxNew,
    [ENH_SCRIPT_PATH]: scriptBytes,
  }, new Set(), ".enhance-tmp");
  refreshSidecarsAfterRepack(asar);
  console.log(`[+] ${asar}\n    增强提示词按钮注入完成${tagged ? "（旧版已原地升级）" : ""}（preload IPC×2 + main handler×2 + 工具栏按钮脚本）\n` +
              `    新大小 ${newSize.toLocaleString()} 字节`);
}

/** modelhub renderer 条目的精确反向替换；STICKY 用 sidecar 记录的后文上下文唯一定位。
 *  任何一步不唯一即返回 null，调用方走 sidecar 原始字节兜底。 */
function revertMhRenderer(cur, ph, stickyAfterB64) {
  let r = cur;
  const ew = Buffer.from(ph.EDIT_WRAP, "utf8");
  if (r.includes(ew)) {
    if (countBytes(r, ew) !== 1) return null;
    r = replaceOnce(r, ew, Buffer.from(ph.ORIG_QPT, "utf8"));
  }
  const addBtn = Buffer.concat([Buffer.from(ph.ADD_BTN, "utf8"), Buffer.from(",")]);
  if (r.includes(addBtn)) {
    if (countBytes(r, addBtn) !== 1) return null;
    r = replaceOnce(r, addBtn, Buffer.alloc(0));
  }
  const leN = Buffer.from(ph.LE_NEW, "utf8");
  if (r.includes(leN)) {
    if (countBytes(r, leN) !== 1) return null;
    r = replaceOnce(r, leN, Buffer.from(ph.LE_OLD, "utf8"));
  }
  const sn = Buffer.from(ph.STICKY_NEW, "utf8");
  if (r.includes(sn)) {
    let pos = -1;
    if (countBytes(r, sn) === 1) pos = r.indexOf(sn);
    else if (stickyAfterB64) {
      const sa = Buffer.from(stickyAfterB64, "base64");
      let i = 0;
      while ((i = r.indexOf(sn, i)) !== -1) {
        if (r.subarray(i + sn.length, i + sn.length + sa.length).equals(sa)) { pos = i; break; }
        i += 1;
      }
    }
    if (pos === -1 && ph.MH_STICKY_AFTER) {
      const pa = Buffer.from(ph.MH_STICKY_AFTER, "base64");
      let i = 0;
      while ((i = r.indexOf(sn, i)) !== -1) {
        if (r.subarray(i + sn.length, i + sn.length + pa.length).equals(pa)) { pos = i; break; }
        i += 1;
      }
    }
    if (pos === -1) return null;
    r = Buffer.concat([r.subarray(0, pos), Buffer.from(ph.STICKY_OLD, "utf8"), r.subarray(pos + sn.length)]);
  }
  const hb = Buffer.from(ph.HELPER_BLOCK, "utf8");
  if (r.includes(hb)) {
    if (countBytes(r, hb) !== 1) return null;
    r = replaceOnce(r, hb, Buffer.alloc(0));
  }
  return r;
}

// ---------------------------------------------------------------- 全消息可编辑

function processEditAll(target, checkOnly, revert) {
  const side = target + ".editall.json";
  const ph = loadMhPayload();
  const pairs = [
    ["P1", ph.P1_OLD, ph.P1_NEW],
    ["P2", ph.P2_OLD, ph.P2_NEW],
  ].map(([lbl, o, n]) => [lbl, Buffer.from(o, "utf8"), Buffer.from(n, "utf8")]);

  let data;
  try {
    data = fs.readFileSync(target);
  } catch {
    console.log(`[!] 无权限读取 ${target}`);
    return;
  }

  const newCnt = Object.fromEntries(pairs.map(([lbl, , n]) => [lbl, countBytes(data, n)]));
  const oldCnt = Object.fromEntries(pairs.map(([lbl, o]) => [lbl, countBytes(data, o)]));
  const applied = pairs.filter(([lbl]) => newCnt[lbl] >= 1 && oldCnt[lbl] === 0).length;
  const st = applied === 2 ? "已打" : (applied === 1 ? "部分（异常）" : "未打");
  console.log(`[*] ${target}`);
  console.log(`    全消息可编辑: ${st}`);

  if (checkOnly) return;

  if (revert) {
    if (applied === 0) { console.log("    [.] 未打，跳过"); return; }
    let changed = data;
    for (const [lbl, o, n] of pairs) {
      if (newCnt[lbl] === 1) changed = replaceOnce(changed, n, o);
    }
    try {
      fs.writeFileSync(target, changed);
      rmQuiet(side);
      console.log("    [+] 已反向替换还原 P1/P2 两处");
    } catch {
      console.log("    [!] 无权限写入，未修改");
    }
    return;
  }

  if (applied === 2) { console.log("    [=] 已打，跳过"); return; }
  if (applied === 1) {
    console.log("    [!] 状态异常（部分替换），先 --edit-all --revert 再重打");
    return;
  }
  for (const [lbl, o] of pairs) {
    if (oldCnt[lbl] !== 1) {
      console.log(`    [!] 锚点 ${lbl} 出现 ${oldCnt[lbl]} 次（期望 1），版本可能不兼容，拒绝盲改`);
      return;
    }
  }
  let changed = data;
  for (const [lbl, o, n] of pairs) changed = replaceOnce(changed, o, n);

  // 语法自检：写临时文件跑 node --check，失败零改动（.cjs 后缀让 node 可识别）
  const tmp = target + ".editall-tmp.cjs";
  try {
    fs.writeFileSync(tmp, changed);
    const node = process.execPath;
    const rc = spawnSync(node, ["--check", tmp], { timeout: 120000 });
    if (rc.status !== 0) {
      rmQuiet(tmp);
      const err = ((rc.stderr || "") + "").split("\n").slice(0, 4).join("\n        ");
      console.log(`    [!] 补丁后语法自检失败（node --check），原文件未动：\n        ${err}`);
      return;
    }
    renameReplace(tmp, target);
    writeJson(side, { applied: true });
    console.log("    [+] P1/P2 两处替换已写入（node --check 通过）");
  } catch (e) {
    rmQuiet(tmp);
    if (e.code === "EACCES" || e.code === "EPERM" || e.code === "EBUSY") console.log("    [!] 无权限写入或文件被占用，未修改");
    else throw e;
  }
}

// ---------------------------------------------------------------- 主入口

function resolveAsars(target) {
  const asars = [];
  for (const cjs of resolveTarget(target)) {
    const asar = path.join(path.dirname(path.dirname(cjs)), "app.asar"); // resources/glm/zcode.cjs -> resources/app.asar
    if (fs.existsSync(asar) && !asars.includes(asar)) asars.push(asar);
  }
  if (!asars.length) die("[!] 未找到 app.asar");
  return asars;
}

function usage() {
  console.log(`ZCode 客户端补丁工具（零依赖 Node 版）
用法：node zcode-patcher.js [功能flag...] [目标路径]

功能flag（可多选；缺省=思维强度透传补丁）：
  --check        只检查状态，不修改
  --revert       从备份/记录还原
  --extract      按结构特征提取当前内核的档位解析函数锚点（升级后用）
  --usage-chart  用量页去截断：趋势图/饼图全量展示
  --menu-width   模型菜单加宽：供应商子菜单 192/160px→384px，长模型名完整显示
  --continue-btn 继续按钮：一键填入「继续」并发送（✨右侧）
  --tps-footer   TPS 统计栏：输入框工具栏统计胶囊
  --modelhub     模型拉取：拉取模型/请求头模拟/视觉探测/删除持久化
  --enhance-btn  增强提示词按钮：改写草稿（右键面板选模型/模式）
  --quota-banner 去额度骚扰横幅：关闭「额度剩余 x%，可升级」升级广告（保留耗尽/受限提示）
  --edit-all     全消息可编辑
  --tps-src <p>  指定注入的 zcode-tps.js 路径
  --enhance-src <p> 指定注入的 zcode-enhance.js 路径
目标：安装根目录 / macOS .app 包 / zcode.cjs 路径；缺省自动探测全部安装`);
}

function main() {
  const argv = process.argv.slice(2);
  const opts = {
    target: null, check: false, revert: false, extract: false,
    usageChart: false, tpsFooter: false, modelhub: false, enhanceBtn: false, editAll: false, menuWidth: false, continueBtn: false, quotaBanner: false,
    tpsSrc: null, enhanceSrc: null, contSrc: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--check": opts.check = true; break;
      case "--revert": opts.revert = true; break;
      case "--extract": opts.extract = true; break;
      case "--usage-chart": opts.usageChart = true; break;
      case "--menu-width": opts.menuWidth = true; break;
      case "--continue-btn": opts.continueBtn = true; break;
      case "--tps-footer": opts.tpsFooter = true; break;
      case "--modelhub": opts.modelhub = true; break;
      case "--enhance-btn": opts.enhanceBtn = true; break;
      case "--quota-banner": opts.quotaBanner = true; break;
      case "--enhance-src": opts.enhanceSrc = argv[++i]; break;
      case "--edit-all": opts.editAll = true; break;
      case "--tps-src": opts.tpsSrc = argv[++i]; break;
      case "--cont-src": opts.contSrc = argv[++i]; break;
      case "-h": case "--help": usage(); return;
      default:
        if (a.startsWith("--")) die(`未知参数：${a}（--help 查看用法）`);
        opts.target = a;
    }
  }

  const asarFlags = opts.usageChart || opts.menuWidth || opts.continueBtn || opts.tpsFooter || opts.modelhub || opts.enhanceBtn || opts.quotaBanner;

  if (asarFlags) {
    const asars = resolveAsars(opts.target);
    if (opts.usageChart) {
      const mode = opts.check ? "检查" : (opts.revert ? "还原" : "打补丁");
      console.log(`=== 用量页去截断补丁，目标 ${asars.length} 处，模式：${mode} ===`);
      for (const a of asars) processUsageChart(a, opts.check, opts.revert);
    }
    if (opts.menuWidth) {
      const mode = opts.check ? "检查" : (opts.revert ? "还原" : "打补丁");
      console.log(`=== 模型菜单加宽，目标 ${asars.length} 处，模式：${mode} ===`);
      for (const a of asars) {
        try { processMenuWidth(a, opts.check, opts.revert); }
        catch (e) {
          if (e.code === "EACCES" || e.code === "EPERM" || e.code === "EBUSY") {
            console.log(`[!] ${a}\n    文件被占用（ZCode 正在运行）或无写入权限；完全退出 ZCode 后重试`);
          } else throw e;
        }
      }
    }
    if (opts.quotaBanner) {
      const mode = opts.check ? "检查" : (opts.revert ? "还原" : "打补丁");
      console.log(`=== 去额度骚扰横幅，目标 ${asars.length} 处，模式：${mode} ===`);
      for (const a of asars) {
        try { processQuotaBanner(a, opts.check, opts.revert); }
        catch (e) {
          if (e.code === "EACCES" || e.code === "EPERM" || e.code === "EBUSY") {
            console.log(`[!] ${a}\n    文件被占用（ZCode 正在运行）或无写入权限；完全退出 ZCode 后重试`);
          } else throw e;
        }
      }
    }
    if (opts.continueBtn) {
      const mode = opts.check ? "检查" : (opts.revert ? "还原" : "打补丁");
      console.log(`=== 继续按钮注入，目标 ${asars.length} 处，模式：${mode} ===`);
      for (const a of asars) {
        try { processContinueBtn(a, opts.check, opts.revert, opts.contSrc); }
        catch (e) {
          if (e.code === "EACCES" || e.code === "EPERM" || e.code === "EBUSY") {
            console.log(`[!] ${a}\n    文件被占用（ZCode 正在运行）或无写入权限；完全退出 ZCode 后重试`);
          } else throw e;
        }
      }
    }
    if (opts.tpsFooter) {
      const mode = opts.check ? "检查" : (opts.revert ? "还原" : "打补丁");
      console.log(`=== TPS 统计栏注入，目标 ${asars.length} 处，模式：${mode} ===`);
      for (const a of asars) {
        try { processTpsFooter(a, opts.check, opts.revert, opts.tpsSrc); }
        catch (e) {
          if (e.code === "EACCES" || e.code === "EPERM" || e.code === "EBUSY") {
            console.log(`[!] ${a}\n    文件被占用（ZCode 正在运行）或无写入权限；完全退出 ZCode 后重试`);
          } else throw e;
        }
      }
    }
    if (opts.modelhub) {
      const mode = opts.check ? "检查" : (opts.revert ? "还原" : "打补丁");
      console.log(`=== 模型拉取补丁（modelhub），目标 ${asars.length} 处，模式：${mode} ===`);
      for (const a of asars) {
        try { processModelhub(a, opts.check, opts.revert); }
        catch (e) {
          if (e.code === "EACCES" || e.code === "EPERM" || e.code === "EBUSY") {
            console.log(`[!] ${a}\n    文件被占用（ZCode 正在运行）或无写入权限；完全退出 ZCode 后重试`);
          } else throw e;
        }
      }
    }
    if (opts.enhanceBtn) {
      const mode = opts.check ? "检查" : (opts.revert ? "还原" : "打补丁");
      console.log(`=== 增强提示词按钮，目标 ${asars.length} 处，模式：${mode} ===`);
      for (const a of asars) {
        try { processEnhanceBtn(a, opts.check, opts.revert, opts.enhanceSrc); }
        catch (e) {
          if (e.code === "EACCES" || e.code === "EPERM" || e.code === "EBUSY") {
            console.log(`[!] ${a}\n    文件被占用（ZCode 正在运行）或无写入权限；完全退出 ZCode 后重试`);
          } else throw e;
        }
      }
    }
    if (!opts.editAll) {
      if (!opts.check && !opts.revert) console.log("=== 提示：完全退出并重启 ZCode 后生效；升级后需重新执行 ===");
      return;
    }
  }

  const targets = resolveTarget(opts.target);

  if (opts.extract) {
    for (const t of targets) {
      console.log(`[*] ${t}`);
      const anchor = extractAnchor(t);
      if (anchor) {
        console.log("[+] 提取成功，把下面整段加入脚本 ANCHORS 后重新运行打补丁：\n");
        console.log(`    "<版本号>": (\n        ${JSON.stringify(anchor)}\n    ),`);
      }
    }
    return;
  }

  if (opts.editAll) {
    const mode = opts.check ? "检查" : (opts.revert ? "还原" : "打补丁");
    console.log(`=== 全消息可编辑补丁，目标 ${targets.length} 处，模式：${mode} ===`);
    for (const t of targets) {
      try { processEditAll(t, opts.check, opts.revert); }
      catch (e) {
        if (e.code === "EACCES" || e.code === "EPERM" || e.code === "EBUSY") {
          console.log(`[!] ${t}\n    无写入权限或文件被占用，请检查权限/退出 ZCode 后重试`);
        } else throw e;
      }
    }
    if (!opts.check && !opts.revert) console.log("=== 提示：完全退出并重启 ZCode 后生效；升级后需重新执行 ===");
    return;
  }

  const mode = opts.check ? "检查" : (opts.revert ? "还原" : "打补丁");
  console.log(`=== 探测到 ${targets.length} 处安装，模式：${mode} ===`);
  for (const t of targets) processEffort(t, opts.check, opts.revert);

  if (!opts.check && !opts.revert) {
    console.log("=== 提示：完全退出并重启 ZCode 后生效；升级后需重新执行本脚本 ===");
  }
}

main();
