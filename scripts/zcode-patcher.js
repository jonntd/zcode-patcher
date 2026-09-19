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
const os = require("os");
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
 * @param {object} [state] 复用调用方已持有的 {raw,header,dataStart}（MemAsar 批量模式），
 *                 传了就不再整读一遍原文件。
 */
function repackAsar(asar, overwrite, remove, tmpSuffix = ".tps-tmp", state) {
  const S = state || asarOpen(asar);
  const { raw, header, dataStart } = S;

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

  // 回读校验：只读 tmp 的头部与 overwrite 条目所在区段（307MB 级 asar 整读一遍太浪费）
  try {
    const fd = fs.openSync(tmp, "r");
    try {
      const head = Buffer.alloc(16);
      fs.readSync(fd, head, 0, 16, 0);
      const vDataStart = 8 + head.readUInt32LE(4);
      const vJsonLen = head.readUInt32LE(12);
      const vHeaderBuf = Buffer.alloc(vJsonLen);
      fs.readSync(fd, vHeaderBuf, 0, vJsonLen, 16);
      const vHeader = JSON.parse(vHeaderBuf.toString("utf8"));
      const vFiles = new Map(walkEntries(vHeader).map((x) => [x.path, x.ent]));
      for (const [p, want] of Object.entries(overwrite)) {
        const ent = vFiles.get(p);
        if (!ent) throw new Error(`重打包校验失败（条目缺失）: ${p}`);
        const got = Buffer.alloc(ent.size);
        fs.readSync(fd, got, 0, ent.size, vDataStart + Number(ent.offset));
        if (got.length !== want.length || !got.equals(want)) {
          throw new Error(`重打包校验失败: ${p}`);
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    rmQuiet(tmp);
    throw e;
  }
  renameReplace(tmp, asar);
  return fs.statSync(asar).size;
}

/** 重打包后数据区位移/尺寸变化：注册表驱动——新增 sidecar 类型时在 SIDECAR_REFRESHERS
 *  加一项，别往流程里堆 if。忘记登记＝重打包后该补丁的记录被静默作废（offset 失配、
 *  asar_size 指纹对不上被当作旧版本清零），正是「升级悄悄抹补丁」这类 bug 的温床。
 *  - chart：记录含绝对 offset，按 path+size 重定位 offset 与 asar_size 指纹；
 *  - 其余（modelhub/tps/continue/menuwidth/quota）：只把 asar_size 指纹刷到当前值。 */
const SIDECAR_REFRESHERS = [
  {
    side: (asar) => asar + ".chart-patch.json",
    refresh(rec, entries, cur, dataStart, side) {
      let changed = false;
      for (const r of rec.patches || []) {
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
        writeJson(side, { patches: rec.patches });
        return `[*] 已同步 ${path.basename(side)} 的 offset/指纹到重打包后的 asar`;
      }
      return null;
    },
  },
  {
    side: (asar) => asar + ".modelhub-patch.json",
    refresh(rec, entries, cur, dataStart, side) {
      const files = rec.files || [];
      if (rec.asar_size !== cur && files.length && files.every((f) => entries.get(f.path))) {
        rec.asar_size = cur;
        writeJson(side, rec);
      }
      return null;
    },
  },
  fingerprintRefresher(".tps-patch.json", "index_path"),
  fingerprintRefresher(".continue-patch.json", "index_path"),
  fingerprintRefresher(".menuwidth-patch.json", "path"),
  fingerprintRefresher(".quota-patch.json", "path"),
];

/** 只刷 asar_size 指纹的 sidecar：校验 path 字段对应条目仍存在才动手。 */
function fingerprintRefresher(suffix, pathKey) {
  return {
    side: (asar) => asar + suffix,
    refresh(rec, entries, cur, dataStart, side) {
      if (rec.asar_size !== cur && rec[pathKey] && entries.get(rec[pathKey])) {
        rec.asar_size = cur;
        writeJson(side, rec);
      }
      return null;
    },
  };
}

function refreshSidecarsAfterRepack(asar) {
  const state = asarOpen(asar);
  const entries = new Map(walkEntries(state.header).map((x) => [x.path, x.ent]));
  const cur = fs.statSync(asar).size;
  for (const r of SIDECAR_REFRESHERS) {
    const side = r.side(asar);
    if (!fs.existsSync(side)) continue;
    try {
      const rec = readJson(side);
      const msg = r.refresh(rec, entries, cur, state.dataStart, side);
      if (msg) console.log(msg);
    } catch { /* 静默 */ }
  }
}

// ---------------------------------------------------------------- asar 内存态（批量合并落盘）

/** 内存态 asar：打开一次、多个补丁共享读取，覆写/删除在内存叠加，最后 flush 一次性
 *  落盘——一键全打从「N 次全量重写 307MB」合并为 1 次的关键。
 *  读取语义：set 过的条目返回覆写字节（后续补丁看到的正是前一补丁的产物，与逐个
 *  顺序执行字节一致）；未动过的条目返回原文件切片（零拷贝）。flush 后实例作废
 *  （repackAsar 会原地改写 header 树）。
 *  约定：deferSide 登记的回调在 flush 成功后以新文件大小执行（sidecar 里要写 asar_size）。 */
function memAsarOpen(asar) {
  const raw = fs.readFileSync(asar);
  if (raw.length < 16 || raw.readUInt32LE(0) !== 4) die(`asar 头格式不符: ${asar}`);
  const headerSize = raw.readUInt32LE(4);
  let header;
  try {
    header = JSON.parse(raw.subarray(16, 16 + raw.readUInt32LE(12)).toString("utf8"));
  } catch (e) {
    die(`asar 头 JSON 解析失败: ${asar}`);
  }
  const dataStart = 8 + headerSize;
  const entries = new Map(walkEntries(header).map((x) => [x.path, x.ent]));
  const overrides = new Map();   // path -> Buffer（覆写/新增）| null（删除）
  const deferredSides = [];
  let dirty = 0;
  const mem = {
    asar,
    get(p) {
      if (overrides.has(p)) {
        const b = overrides.get(p);
        if (b == null) die(`条目 ${p} 已被本次流程删除却又被读取——补丁间顺序冲突`);
        return b;
      }
      const ent = entries.get(p);
      if (!ent) return null;
      const off = dataStart + Number(ent.offset);
      return raw.subarray(off, off + ent.size);
    },
    has(p) { return overrides.has(p) ? overrides.get(p) != null : entries.has(p); },
    each(fn) { for (const [p, ent] of entries) fn(p, ent); },
    set(p, buf) { if (!overrides.has(p)) dirty++; overrides.set(p, buf); },
    del(p) { if (!overrides.has(p)) dirty++; overrides.set(p, null); },
    dirtyCount: () => dirty,
    deferSide(fn) { deferredSides.push(fn); },
    flush(tmpSuffix) {
      if (!dirty) {
        for (const fn of deferredSides) fn(fs.statSync(asar).size);
        deferredSides.length = 0;
        return fs.statSync(asar).size;
      }
      const overwrite = {}, remove = new Set();
      for (const [p, b] of overrides) {
        if (b == null) remove.add(p);
        else overwrite[p] = b;
      }
      const newSize = repackAsar(asar, overwrite, remove, tmpSuffix, { raw, header, dataStart });
      refreshSidecarsAfterRepack(asar);
      for (const fn of deferredSides) fn(newSize);
      deferredSides.length = 0;
      dirty = 0;
      return newSize;
    },
  };
  return mem;
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
  if (/zcode\.cjs$/i.test(arg) && fs.existsSync(arg) && fs.statSync(arg).isFile()) return [arg];
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
  if (checkOnly) {
    const knownOff = Object.values(ANCHORS).every((a) => countBytes(data, Buffer.from(a, "utf8")) === 0);
    if (knownOff && !hasMarker) {
      console.log("    [i] 3.12.x 内核已移除档位换算函数（providerOptionsByLevel 仅存 schema、零运行时读取），本补丁在该内核不适用。");
      console.log("    [i] 原生替代：设置 → 模型设置 → 该模型的「推理档位映射」，按档位直接映射任意配置路径（等价于本补丁的可视化版）。");
    }
    return;
  }
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
// 3.12.x 起官方把点①默认宽改为自适应（w-max + min 12rem + 视口钳制），补丁目标已原生达成：
// v2 组的点①降级为 native 只检测不改写；点②官方未动，两组同串。按组探测，旧版装 v1、新版装 v2。
const MENU_WIDTH_VARIANTS = [
  {
    label: "v1（旧版固定宽度）",
    patches: [
      { pattern: Buffer.from("j??`w-48`", "utf8"), replacement: Buffer.from("j??`w-96`", "utf8"), desc: "子菜单默认宽 w-48(192px)→w-96(384px)" },
      { pattern: Buffer.from("`w-40 min-w-0 max-w-(--radix-dropdown-menu-content-available-width)`", "utf8"), replacement: Buffer.from("`w-96 min-w-0 max-w-(--radix-dropdown-menu-content-available-width)`", "utf8"), desc: "自定义渠道子菜单 w-40(160px)→w-96(384px)，保留视口钳制" },
    ],
  },
  {
    label: "v2（官方自适应 w-max）",
    patches: [
      { pattern: Buffer.from("j??`w-max min-w-[min(12rem,var(--radix-dropdown-menu-content-available-width))] max-w-(--radix-dropdown-menu-content-available-width)`", "utf8"), native: true, desc: "子菜单默认宽：官方已原生自适应（w-max），无需改写" },
      { pattern: Buffer.from("`w-40 min-w-0 max-w-(--radix-dropdown-menu-content-available-width)`", "utf8"), replacement: Buffer.from("`w-96 min-w-0 max-w-(--radix-dropdown-menu-content-available-width)`", "utf8"), desc: "自定义渠道子菜单 w-40(160px)→w-96(384px)，保留视口钳制" },
    ],
  },
];
for (const v of MENU_WIDTH_VARIANTS) {
  for (const it of v.patches) {
    if (it.replacement && it.pattern.length !== it.replacement.length) die(`模型菜单补丁点等长校验失败: ${v.label}/${it.desc}`);
  }
}

function processMenuWidth(asar, checkOnly, revert) {
  const side = asar + ".menuwidth-patch.json";
  const asarSize = fs.statSync(asar).size;
  const state = asarOpen(asar);

  // 定位：锚点（原始形态或已打形态）落在同一渲染层大文件；文件名哈希随版本变，不硬编码。
  // 版本组选择：组内每点必须计数健康（普通点有 orig/patched 之一，native 点恰 1 次），
  // 否则 v1 组会凭遗留点②在 v2 内核上被误选中并报锚点异常。
  const candidates = [];
  for (const { path: p, ent } of walkEntries(state.header)) {
    if (!p.startsWith("out/renderer/assets/") || !p.endsWith(".js") || ent.size < 100000) continue;
    candidates.push({ path: p, ent, bytes: entryBytes(state, ent) });
  }
  let variant = null;
  let hit = null;
  let kinds = null;
  for (const v of MENU_WIDTH_VARIANTS) {
    const h = candidates.filter((c) => v.patches.every((it) => {
      const o = countBytes(c.bytes, it.pattern);
      const n = it.replacement ? countBytes(c.bytes, it.replacement) : 0;
      return it.native ? o === 1 : o + n > 0;
    }));
    if (h.length !== 1) continue;
    const st = v.patches.map((it) => {
      const o = countBytes(h[0].bytes, it.pattern);
      const n = it.replacement ? countBytes(h[0].bytes, it.replacement) : 0;
      return it.native ? (o === 1 ? "native" : "bad")
        : o === 1 && n === 0 ? "orig"
        : o === 0 && n === 1 ? "patched"
        : "bad";
    });
    variant = v; hit = h[0]; kinds = st;
    break;
  }
  if (!variant) {
    console.log(`[!] ${asar}\n    模型菜单锚点未在任何锚点组唯一命中（期望 1 个文件），版本结构可能已变，跳过`);
    return;
  }
  const { path: rel, ent } = hit;
  const fname = rel.split("/").pop();
  const absOff = state.dataStart + Number(ent.offset);
  const patchedCnt = kinds.filter((k) => k === "patched").length;
  const nativeCnt = kinds.filter((k) => k === "native").length;
  const badCnt = kinds.filter((k) => k === "bad").length;
  const total = variant.patches.length;
  const satisfied = patchedCnt + nativeCnt;

  if (checkOnly) {
    const st = badCnt ? "锚点计数异常（拒绝操作）"
      : satisfied === total ? (patchedCnt === 0 ? "官方已原生，无需打" : "已打")
      : patchedCnt === 0 ? "未打"
      : `不完整（${patchedCnt}/${total - nativeCnt}）`;
    let sideOk = false;
    try { sideOk = fs.existsSync(side) && readJson(side).asar_size === asarSize; } catch { sideOk = false; }
    console.log(`[*] ${asar}\n    模型菜单加宽: ${st} | 锚点组: ${variant.label} | sidecar: ${sideOk ? "有" : "无"} | 渲染文件: ${fname}`);
    return;
  }

  if (revert) {
    if (patchedCnt === 0) {
      console.log(`[.] ${asar}\n    未打模型菜单加宽补丁${nativeCnt ? "（官方自适应形态，无改写点）" : ""}，跳过`);
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
        const it = variant.patches[i];
        fs.writeSync(fd, it.pattern, 0, it.pattern.length, absOff + raw.indexOf(it.replacement));
        ok++;
      }
    } finally {
      fs.closeSync(fd);
    }
    rmQuiet(side);
    console.log(`[+] ${asar}\n    已还原 ${ok}/${total - nativeCnt} 处原始宽度（${fname}）`);
    return;
  }

  // 打补丁
  if (badCnt) {
    console.log(`    [!] ${fname} | 锚点出现次数异常，拒绝盲改`);
    return;
  }
  if (satisfied === total) {
    console.log(`    [=] ${fname} | ${patchedCnt === 0 ? "官方已原生自适应，无需打" : "已打"}（${variant.label}），跳过`);
    return;
  }
  const raw = Buffer.from(entryBytes(state, ent));
  const fd = fs.openSync(asar, "r+");
  try {
    for (let i = 0; i < total; i++) {
      if (kinds[i] !== "orig") continue;
      const it = variant.patches[i];
      fs.writeSync(fd, it.replacement, 0, it.replacement.length, absOff + raw.indexOf(it.pattern));
      console.log(`    [+] ${fname} | ${it.desc}`);
    }
  } finally {
    fs.closeSync(fd);
  }
  // 回读校验：等长替换，文件总长必须不变；普通点恰剩已打形态，native 点保持原生
  const state2 = asarOpen(asar);
  const ent2 = walkEntries(state2.header).find((x) => x.path === rel)?.ent;
  const back = ent2 ? entryBytes(state2, ent2) : Buffer.alloc(0);
  const okAll = back.length === ent.size
    && variant.patches.every((it) => it.native
      ? countBytes(back, it.pattern) === 1
      : countBytes(back, it.replacement) === 1 && countBytes(back, it.pattern) === 0);
  if (!okAll) console.log(`    [!] 回读校验未通过，请 --menu-width --revert 还原后排查`);
  writeJson(side, { asar_size: asarSize, path: rel, variant: variant.label, patches: variant.patches.map((it) => ({ desc: it.desc })) });
  console.log(`    状态记录: ${path.basename(side)}${okAll ? "" : "（校验异常）"}`);
}

// ---------------------------------------------------------------- 去额度骚扰横幅

// 关闭「{model} 今日免费计划额度剩余 x%，可升级…」升级广告横幅。等长字节原地覆盖：
// 渲染层阈值函数按剩余比例产出横幅类型——ratio<=0 走 exhaustedKind（model-exhausted /
// daily-exhausted），prefix 为 daily 时恒 null，随后 ≤.1→very-low、≤.2→low、≤.5→half-used。
// 把骚扰阈值改成 -1（比例恒 ≥0，永不命中），让广告档全部消失；
// 额度真正耗尽（0%）、服务端整体耗尽、并发受限、供应商受限、MCP 通知等有用提示全部保留。
// 以内容锚点定位（文件名哈希随版本变，不硬编码）；ZCode 升级后 renderer 实现会变，
// 所以按版本组织成多个锚点组（v1=旧版三元档位，v2=新版提醒式横幅），
// 运行时依次探测：唯一命中哪组就用哪组，旧版部署与新版本都能正确判读/还原。
const QUOTA_VARIANTS = [
  {
    label: "v1（旧版三元档位）",
    patches: [
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
    ],
  },
  {
    label: "v2（新版提醒式横幅）",
    patches: [
      {
        // 新版决策链：`if(!(r===null||r<=0||r>.1||!i||e.isReminderHidden?.(i,t)))` 才弹提醒，
        // 把 `r>.-1` 恒真即可让“剩余≤10%”提醒永不出现，耗尽/受限分支不受影响。
        pattern: Buffer.from("r>.1||!i||e.isReminderHidden", "utf8"),
        replacement: Buffer.from("r>-1||!i||e.isReminderHidden", "utf8"),
        desc: "额度骚扰档 very-low(≤10%) 关闭",
      },
    ],
  },
];
for (const v of QUOTA_VARIANTS) {
  for (const it of v.patches) {
    if (it.pattern.length !== it.replacement.length) die(`额度横幅补丁点等长校验失败: ${v.label}/${it.desc}`);
  }
}

function processQuotaBanner(asar, checkOnly, revert) {
  const side = asar + ".quota-patch.json";
  const asarSize = fs.statSync(asar).size;
  const state = asarOpen(asar);

  // 定位：锚点（原始形态或已打形态）落在同一渲染层大文件；文件名哈希随版本变，不硬编码
  const candidates = [];
  for (const { path: p, ent } of walkEntries(state.header)) {
    if (!p.startsWith("out/renderer/assets/") || !p.endsWith(".js") || ent.size < 100000) continue;
    candidates.push({ path: p, ent, bytes: entryBytes(state, ent) });
  }

  // 版本组选择：依次探测 QUOTA_VARIANTS，取第一个有锚点命中的组；组内任一文件唯一，
  // 且旧组在三元档位下必须三处全部锚定（组内计数校验在下方 kinds 里做）
  let variant = null;
  let hits = [];
  for (const v of QUOTA_VARIANTS) {
    const vhit = candidates.filter((c) => v.patches.some((it) =>
      countBytes(c.bytes, it.pattern) > 0 || countBytes(c.bytes, it.replacement) > 0));
    if (vhit.length === 1) {
      variant = v;
      hits = vhit;
      break;
    }
  }
  if (!variant) {
    console.log(`[!] ${asar}\n    额度横幅锚点未在任何锚点组唯一命中（期望 1 个文件），版本结构可能已变，跳过`);
    return;
  }
  const { path: rel, bytes } = hits[0];
  const fname = rel.split("/").pop();
  const absOff = state.dataStart + Number(hits[0].ent.offset);
  const kinds = variant.patches.map((it) =>
    countBytes(bytes, it.pattern) === 1 && countBytes(bytes, it.replacement) === 0 ? "orig"
      : countBytes(bytes, it.pattern) === 0 && countBytes(bytes, it.replacement) === 1 ? "patched"
      : "bad");
  const patchedCnt = kinds.filter((k) => k === "patched").length;
  const badCnt = kinds.filter((k) => k === "bad").length;
  const total = variant.patches.length;

  if (checkOnly) {
    const st = badCnt ? "锚点计数异常（拒绝操作）"
      : patchedCnt === total ? "已打"
      : patchedCnt === 0 ? "未打"
      : `不完整（${patchedCnt}/${total}）`;
    let sideOk = false;
    try { sideOk = fs.existsSync(side) && readJson(side).asar_size === asarSize; } catch { sideOk = false; }
    console.log(`[*] ${asar}\n    去额度骚扰横幅: ${st} | 锚点组: ${variant.label} | sidecar: ${sideOk ? "有" : "无"} | 渲染文件: ${fname}`);
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
    const raw = Buffer.from(entryBytes(state, hits[0].ent)); // 读后即拷：写入偏移全部基于该快照
    const fd = fs.openSync(asar, "r+");
    let ok = 0;
    try {
      for (let i = 0; i < total; i++) {
        if (kinds[i] !== "patched") continue;
        const it = variant.patches[i];
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
    console.log(`    [=] ${fname} | 已打（${variant.label}），跳过`);
    return;
  }
  const raw = Buffer.from(entryBytes(state, hits[0].ent));
  const fd = fs.openSync(asar, "r+");
  try {
    for (let i = 0; i < total; i++) {
      if (kinds[i] !== "orig") continue;
      const it = variant.patches[i];
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
  const okAll = back.length === hits[0].ent.size
    && variant.patches.every((it) => countBytes(back, it.replacement) === 1 && countBytes(back, it.pattern) === 0);
  if (!okAll) console.log(`    [!] 回读校验未通过，请 --quota-banner --revert 还原后排查`);
  writeJson(side, { asar_size: asarSize, path: rel, variant: variant.label, patches: variant.patches.map((it) => ({ desc: it.desc })) });
  console.log(`    状态记录: ${path.basename(side)}${okAll ? "" : "（校验异常）"}`);
}

// ---------------------------------------------------------------- TPS 统计栏

const TPS_INDEX_PATH = "out/renderer/index.html";
const TPS_SCRIPT_PATH = "out/renderer/zcode-tps.js";
const TPS_TAG = `<script src="./${TPS_SCRIPT_PATH.split("/").pop()}"></script>`;

function processTpsFooter(asar, checkOnly, revert, tpsSrc, mem) {
  const side = asar + ".tps-patch.json";
  const bak = asar + ".tps.bak";
  const asarSize = fs.statSync(asar).size;

  const own = !mem;
  if (own) mem = memAsarOpen(asar);
  const commit = (suffix, sideFn) => {
    if (own) {
      const newSize = mem.flush(suffix);
      if (sideFn) sideFn(newSize);
      return newSize;
    }
    if (sideFn) mem.deferSide(sideFn);
    return null;
  };
  const idxBytes = mem.get(TPS_INDEX_PATH);
  if (!idxBytes) {
    console.log(`[!] ${asar}\n    未找到 ${TPS_INDEX_PATH}，版本结构可能已变，跳过`);
    return false;
  }
  const tagged = idxBytes.includes(Buffer.from(TPS_TAG));
  const scriptCur = mem.has(TPS_SCRIPT_PATH) ? mem.get(TPS_SCRIPT_PATH) : null;
  if (!tpsSrc) tpsSrc = path.join(__dirname, "zcode-tps.js");
  const srcExists = fs.existsSync(tpsSrc);
  const scriptSrc = srcExists ? fs.readFileSync(tpsSrc) : null;
  // 已打 = tag 在 + 条目在 + 内容与当前注入源逐字节一致（注入源缺失时退回仅检查条目在）。
  // 源更新导致内容不一致 → 视为未打，重跑即原地升级（与继续按钮补丁同一语义）
  const installed = tagged && scriptCur != null && (scriptSrc ? scriptCur.equals(scriptSrc) : true);

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
    console.log(`[*] ${asar}\n    TPS 统计栏注入: ${st} | sidecar: ${saved ? "有" : "无"} | 备份: ${fs.existsSync(bak) ? "有" : "无"}`);
    return false;
  }

  if (revert) {
    if (!tagged && !scriptCur && !saved) {
      console.log(`[.] ${asar}\n    未打 TPS 注入，跳过`);
      return false;
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
    // 脚本条目仅在与注入源/记录逐字节一致时删除，绝不误删用户改动过的内容
    const expect = scriptSrc || (saved && saved.script_b64 ? Buffer.from(saved.script_b64, "base64") : null);
    const remove = new Set();
    if (scriptCur && expect && scriptCur.equals(expect)) remove.add(TPS_SCRIPT_PATH);
    else if (scriptCur) console.log(`[!] 脚本条目 ${TPS_SCRIPT_PATH} 内容与注入记录不一致，保留不删（可手动处理）`);
    mem.set(TPS_INDEX_PATH, originalIdx);
    for (const p of remove) mem.del(p);
    rmQuiet(side);
    rmQuiet(bak);
    commit(".tps-tmp");
    console.log(`[+] ${asar}\n    已还原 index.html${remove.has(TPS_SCRIPT_PATH) ? "并移除 " + TPS_SCRIPT_PATH : ""}（备份已清理）`);
    return true;
  }

  if (installed) {
    console.log(`[=] ${asar}\n    已打 TPS 注入，跳过`);
    return false;
  }
  if (!srcExists) die(`[!] 找不到注入源脚本 ${tpsSrc}（可用 --tps-src 指定路径）`);
  if (countBytes(idxBytes, Buffer.from("</body>")) !== 1) {
    console.log(`[!] ${asar}\n    index.html 的 </body> 出现 ${countBytes(idxBytes, Buffer.from("</body>"))} 次（期望 1），拒绝盲改`);
    return false;
  }
  const scriptBytes = scriptSrc;

  if (!fs.existsSync(bak)) {
    fs.copyFileSync(asar, bak);
  } else if (fs.statSync(bak).size !== asarSize) {
    // asar 已被升级覆盖（尺寸变化）：旧整包备份属于上一版，刷新
    fs.copyFileSync(asar, bak);
    console.log("[*] 检测到 app.asar 已被升级覆盖，整包备份 app.asar.tps.bak 已刷新");
  }

  const newIdx = tagged ? idxBytes : replaceOnce(idxBytes, Buffer.from("</body>"), Buffer.concat([Buffer.from(TPS_TAG), Buffer.from("</body>")]));
  mem.set(TPS_INDEX_PATH, newIdx);
  mem.set(TPS_SCRIPT_PATH, scriptBytes);
  commit(".tps-tmp", (newSize) => writeJson(side, {
    asar_size: newSize,
    index_path: TPS_INDEX_PATH,
    script_entry: TPS_SCRIPT_PATH,
    script_b64: scriptBytes.toString("base64"),
    index_original_b64: idxBytes.toString("base64"),
  }));
  console.log(`[+] ${asar}\n    TPS 统计栏注入完成（${path.basename(tpsSrc)} ${scriptBytes.length.toLocaleString()} 字节 -> ${TPS_SCRIPT_PATH}，index.html 已挂载）\n` +
              `    原件备份: ${path.basename(bak)} | 记录: ${path.basename(side)}`);
  return true;
}

// ---------------------------------------------------------------- 继续按钮

const CONT_INDEX_PATH = "out/renderer/index.html";
const CONT_SCRIPT_PATH = "out/renderer/zcode-continue.js";
const CONT_TAG = `<script src="./${CONT_SCRIPT_PATH.split("/").pop()}"></script>`;

function processContinueBtn(asar, checkOnly, revert, contSrc, mem) {
  const side = asar + ".continue-patch.json";
  const asarSize = fs.statSync(asar).size;

  const own = !mem;
  if (own) mem = memAsarOpen(asar);
  const commit = (suffix, sideFn) => {
    if (own) {
      const newSize = mem.flush(suffix);
      if (sideFn) sideFn(newSize);
      return newSize;
    }
    if (sideFn) mem.deferSide(sideFn);
    return null;
  };
  const idxBytes = mem.get(CONT_INDEX_PATH);
  if (!idxBytes) {
    console.log(`[!] ${asar}\n    未找到 ${CONT_INDEX_PATH}，版本结构可能已变，跳过`);
    return false;
  }
  const tagged = idxBytes.includes(Buffer.from(CONT_TAG));
  const scriptCur = mem.has(CONT_SCRIPT_PATH) ? mem.get(CONT_SCRIPT_PATH) : null;

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
    return false;
  }

  if (revert) {
    if (!tagged && !scriptCur && !saved) {
      console.log(`[.] ${asar}\n    未打继续按钮注入，跳过`);
      return false;
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
      return false;
    }
    // 脚本条目仅在与注入源/记录逐字节一致时删除，绝不误删用户改动过的内容
    const expect = scriptSrc || (saved && saved.script_b64 ? Buffer.from(saved.script_b64, "base64") : null);
    let remove = new Set();
    if (scriptCur && expect && scriptCur.equals(expect)) remove.add(CONT_SCRIPT_PATH);
    else if (scriptCur) console.log(`[!] 脚本条目 ${CONT_SCRIPT_PATH} 内容与注入记录不一致，保留不删（可手动处理）`);
    mem.set(CONT_INDEX_PATH, newIdx);
    for (const p of remove) mem.del(p);
    if (remove.has(CONT_SCRIPT_PATH)) rmQuiet(side);
    commit(".cont-tmp");
    console.log(`[+] ${asar}\n    已还原 index.html${remove.has(CONT_SCRIPT_PATH) ? "并移除 " + CONT_SCRIPT_PATH : ""}`);
    return true;
  }

  if (installed) {
    console.log(`[=] ${asar}\n    已打继续按钮，跳过`);
    return false;
  }
  if (!srcExists) die(`[!] 找不到注入源脚本 ${contSrc}（可用 --cont-src 指定路径）`);
  if (countBytes(idxBytes, Buffer.from("</body>")) !== 1) {
    console.log(`[!] ${asar}\n    index.html 的 </body> 出现 ${countBytes(idxBytes, Buffer.from("</body>"))} 次（期望 1），拒绝盲改`);
    return false;
  }
  const newIdx = tagged ? idxBytes : replaceOnce(idxBytes, Buffer.from("</body>"), Buffer.concat([Buffer.from(CONT_TAG), Buffer.from("</body>")]));
  mem.set(CONT_INDEX_PATH, newIdx);
  mem.set(CONT_SCRIPT_PATH, scriptSrc);
  commit(".cont-tmp", (newSize) => writeJson(side, {
    asar_size: newSize,
    index_path: CONT_INDEX_PATH,
    script_entry: CONT_SCRIPT_PATH,
    script_b64: scriptSrc.toString("base64"),
  }));
  console.log(`[+] ${asar}\n    继续按钮注入完成（${path.basename(contSrc)} ${scriptSrc.length.toLocaleString()} 字节 -> ${CONT_SCRIPT_PATH}，index.html 已挂载）\n` +
              `    记录: ${path.basename(side)}`);
  return true;
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

/** 补丁后渲染 bundle 语法自检（node --check 按 ESM 校验），失败则放弃写入。环境不可用时放行（与旧行为一致）。 */
function checkBundleSyntax(data, label) {
  const tmp = path.join(os.tmpdir(), `zcode-patch-syntax-${process.pid}.mjs`);
  let ok = true;
  try {
    fs.writeFileSync(tmp, data);
    const rc = spawnSync(process.execPath, ["--check", tmp], { timeout: 120000, encoding: "utf8" });
    if (rc.status !== 0) {
      console.log(`[!] ${label} 补丁后语法自检失败（node --check），放弃写入：\n        `
        + (String(rc.stderr || "").split("\n").slice(0, 4).join("\n        ")));
      ok = false;
    }
  } catch (e) {
    console.log(`[!] ${label} 语法自检环境异常（本次放行）：` + (e && e.message || e));
  }
  try { fs.rmSync(tmp, { force: true }); } catch { /* 静默 */ }
  return ok;
}

function processModelhub(asar, checkOnly, revert, mem) {
  const side = asar + ".modelhub-patch.json";
  const ph = loadMhPayload();
  const asarSize = fs.statSync(asar).size;
  const own = !mem;
  if (own) mem = memAsarOpen(asar);
  const commit = (suffix, sideFn) => {
    if (own) {
      const newSize = mem.flush(suffix);
      if (sideFn) sideFn(newSize);
      return newSize;
    }
    if (sideFn) mem.deferSide(sideFn);
    return null;
  };

  // renderer 大文件定位：内容锚点判定 v1/v2/v3（旧版 ADD_BTN/QPT 组合 vs vRt vs mbn 调用点）。
  // 哈希文件名随版本构建变化，一律不硬编码；期望恰有一版命中唯一文件。
  // v3 = 3.12.x：压缩器把模型设置组件从 vRt 改名为 mbn（providerName 格式化函数 gw→nN），
  // 参数表/调用点作用域变量（w/E/O）与注入块完全不变，仅锚点串内的符号名漂移。
  const v1Bufs = [Buffer.from(ph.ORIG_ADD_BTN, "utf8"), Buffer.from(ph.ORIG_QPT, "utf8")];
  const v2Buf = Buffer.from(ph.RENDER_V2_ANCHOR, "utf8");
  const v3Buf = ph.RENDER_V3_ANCHOR ? Buffer.from(ph.RENDER_V3_ANCHOR, "utf8") : null;
  // v2.1/v3.1（模型列表头部）三点注入的字节：签名形参 / 调用点传参 / 头部按钮
  const v2SigOld = ph.RENDER_V2_SIG_OLD ? Buffer.from(ph.RENDER_V2_SIG_OLD, "utf8") : null;
  const v2SigNew = ph.RENDER_V2_SIG_NEW ? Buffer.from(ph.RENDER_V2_SIG_NEW, "utf8") : null;
  const v2PropBuf = ph.RENDER_V2_INSERT ? Buffer.from(ph.RENDER_V2_INSERT, "utf8") : null;
  const v3SigOld = ph.RENDER_V3_SIG_OLD ? Buffer.from(ph.RENDER_V3_SIG_OLD, "utf8") : null;
  const v3SigNew = ph.RENDER_V3_SIG_NEW ? Buffer.from(ph.RENDER_V3_SIG_NEW, "utf8") : null;
  const v3PropBuf = ph.RENDER_V3_INSERT ? Buffer.from(ph.RENDER_V3_INSERT, "utf8") : null;
  const v2HdrAnchor = ph.RENDER_V2_HDR_ANCHOR ? Buffer.from(ph.RENDER_V2_HDR_ANCHOR, "utf8") : null;
  const v2HdrInsert = ph.RENDER_V2_HDR_INSERT ? Buffer.from(ph.RENDER_V2_HDR_INSERT, "utf8") : null;
  // 旧版 v2（独立行按钮）整块注入串：仅为已打旧版的原地升级/还原保留
  const v2LegacyBuf = ph.RENDER_V2_INSERT_LEGACY ? Buffer.from(ph.RENDER_V2_INSERT_LEGACY, "utf8") : null;
  const v2HdrAfter = ph.RENDER_V2_HDR_AFTER ? Buffer.from(ph.RENDER_V2_HDR_AFTER, "utf8") : null;
  const v2BtnMark = Buffer.from("拉取模型", "utf8");
  // v2.1 头部注入判定（位置式）：HDR 锚点与原生添加按钮之间出现注入块即为已打，
  // 不依赖按钮体逐字节一致——payload 文案/样式微调不会让存量安装的判读与还原失效
  const mhV21Injected = (buf) => {
    if (!v2HdrAnchor || !v2HdrAfter) return false;
    const hdrIdx = buf.indexOf(v2HdrAnchor);
    if (hdrIdx < 0) return false;
    const afterHdr = hdrIdx + v2HdrAnchor.length;
    const addIdx = buf.indexOf(v2HdrAfter, afterHdr);
    if (addIdx < 0 || addIdx - afterHdr >= 8192) return false;
    const chunk = buf.subarray(afterHdr, addIdx);
    return chunk.includes(v2BtnMark) && chunk.includes(MH_MARK_RENDER);
  };
  // 位置式剥离头部注入块；不匹配（漂移/异常）时返回 null 走 sidecar 字节兜底
  const mhV21StripHeader = (buf) => {
    const hdrIdx = buf.indexOf(v2HdrAnchor);
    if (hdrIdx < 0) return null;
    const afterHdr = hdrIdx + v2HdrAnchor.length;
    const addIdx = buf.indexOf(v2HdrAfter, afterHdr);
    if (addIdx < 0 || addIdx - afterHdr >= 8192) return null;
    const chunk = buf.subarray(afterHdr, addIdx);
    if (!chunk.includes(v2BtnMark) || !chunk.includes(MH_MARK_RENDER)) return null;
    return Buffer.concat([buf.subarray(0, afterHdr), buf.subarray(addIdx)]);
  };
  const found = [];
  mem.each((p, ent) => {
    if (!p.startsWith("out/renderer/assets/") || !p.endsWith(".js") || ent.size < 100000) return;
    const b = mem.get(p);
    const isV1 = v1Bufs.some((x) => b.includes(x));
    const isV2 = b.includes(v2Buf);
    const isV3 = v3Buf && b.includes(v3Buf);
    if (isV1 || isV2 || isV3) found.push({ path: p, isV1, isV2, isV3 });
  });
  const v1hits = found.filter((f) => f.isV1);
  const v2hits = found.filter((f) => f.isV2);
  const v3hits = found.filter((f) => f.isV3);
  let mode = null;
  let rendRel = null;
  if (v1hits.length === 1 && v2hits.length === 0 && v3hits.length === 0) { mode = "v1"; rendRel = v1hits[0].path; }
  else if (v2hits.length === 1 && v1hits.length === 0 && v3hits.length === 0) { mode = "v2"; rendRel = v2hits[0].path; }
  else if (v3hits.length === 1 && v1hits.length === 0 && v2hits.length === 0) { mode = "v3"; rendRel = v3hits[0].path; }
  else {
    console.log(`[!] ${asar}\n    模型拉取锚点命中 v1=${v1hits.length} v2=${v2hits.length} v3=${v3hits.length} 个文件（期望恰一版=1），版本结构可能已变，跳过`);
    return false;
  }
  // 当前生效字节集：v3 与 v2 仅组件符号名不同，注入块/HDR 系共享（payload V3 字段缺省时回落 V2 以兼容旧载荷）
  const sigOldBuf = mode === "v3" ? (v3SigOld || v2SigOld) : v2SigOld;
  const sigNewBuf = mode === "v3" ? (v3SigNew || v2SigNew) : v2SigNew;
  const callAnchorBuf = mode === "v3" ? (v3Buf || v2Buf) : v2Buf;
  const propBuf = mode === "v3" ? (v3PropBuf || v2PropBuf) : v2PropBuf;
  if (!mem.has(MH_PRELOAD_REL) || !mem.has(MH_MAIN_REL)) {
    console.log(`[!] ${asar}\n    缺少 preload/main 条目，版本结构可能已变，跳过`);
    return false;
  }

  const marks = [
    [MH_PRELOAD_REL, MH_MARK_PRELOAD],
    [MH_MAIN_REL, MH_MARK_MAIN],
    [rendRel, MH_MARK_RENDER],
  ];
  const tagged = marks.filter(([rel, mark]) => mem.get(rel).includes(mark)).length;

  // preload 注入变体：原生 connectRemote 体的 ipcRenderer 绑定名随内核构建漂移
  // （3.14 起压缩器把 h 改名为 _，witness 串判版）。旧 h. 形态注入在新内核上运行时
  // h.ipcRenderer 为 undefined（renderer 报「Cannot read properties of undefined
  // (reading 'invoke')」），故按内核形态选注入串，漂移升级路径据此剥旧换新。
  const preWitness = ph.PRELOAD_V2_WITNESS ? Buffer.from(ph.PRELOAD_V2_WITNESS, "utf8") : null;
  const preInjV1 = Buffer.from(ph.PRELOAD_INJECT, "utf8");
  const preInjV2 = ph.PRELOAD_INJECT_V2 ? Buffer.from(ph.PRELOAD_INJECT_V2, "utf8") : null;
  const preNow = mem.get(MH_PRELOAD_REL);
  const preWantsV2 = !!(preWitness && preInjV2 && preNow.includes(preWitness));
  const preInjCur = preWantsV2 ? preInjV2 : preInjV1;
  const preInjPrev = preWantsV2 ? preInjV1 : preInjV2;
  const preDrift = !preNow.includes(preInjCur);

  let saved = null;
  if (fs.existsSync(side)) {
    try {
      const rec = readJson(side);
      if (rec.asar_size === asarSize) saved = rec;
    } catch { saved = null; }
  }

  if (checkOnly) {
    const rendBytes = mem.get(rendRel);
    const isNewForm = sigNewBuf && countBytes(rendBytes, sigNewBuf) === 1 && mhV21Injected(rendBytes);
    const isLegacyForm = v2LegacyBuf && countBytes(rendBytes, v2LegacyBuf) === 1;
    const st = tagged === 3 ? (isNewForm ? (preDrift ? "已打（preload 注入形态与内核不匹配，重跑 --modelhub 原地升级）" : "已打")
                              : isLegacyForm ? "已打（旧版独立行位置，重跑 --modelhub 原地升级）" : "已打")
      : (tagged ? `不完整（${tagged}/3）` : "未打");
    console.log(`[*] ${asar}\n    模型拉取补丁: ${st} | sidecar: ${saved ? "有" : "无"} | 渲染文件: ${rendRel.split("/").pop()}（锚点组 ${mode}）`);
    return false;
  }

  if (revert) {
    const anyTagged = marks.some(([rel, mark]) => mem.get(rel).includes(mark));
    if (!anyTagged && !saved) {
      console.log(`[.] ${asar}\n    未打模型拉取补丁，跳过`);
      return false;
    }
    const stickyRec = saved && (saved.files || []).find((f) => f.path === rendRel && f.sticky_after);
    const overwrite = {};
    let exact = 0, fallback = 0;
    for (const [rel, mark] of marks) {
      const cur = mem.get(rel);
      if (!cur.includes(mark)) {
        overwrite[rel] = cur;   // 已是原版
        continue;
      }
      let r = null;
      if (rel === MH_PRELOAD_REL) {
        for (const inj of [preInjV1, preInjV2]) {
          if (!inj || countBytes(cur, inj) !== 1) continue;
          r = replaceOnce(cur, inj, Buffer.alloc(0));
          break;
        }
      } else if (rel === MH_MAIN_REL) {
        const h = Buffer.from(ph.MAIN_HANDLERS, "utf8");
        if (countBytes(cur, h) === 1) r = replaceOnce(cur, h, Buffer.alloc(0));
      } else {
        // renderer：优先剥离 v2.1 三点注入（签名/传参/头部按钮），其次旧版 v2 注入块，最后走 v1 逐点反替换
        if (sigNewBuf && countBytes(cur, sigNewBuf) === 1) {
          let r2 = replaceOnce(cur, sigNewBuf, sigOldBuf);
          const propApplied = Buffer.concat([callAnchorBuf, propBuf]);
          if (countBytes(r2, propApplied) !== 1) {
            r = null;   // 传参串漂移：走 sidecar 字节兜底
          } else {
            r2 = replaceOnce(r2, propApplied, callAnchorBuf);
            r2 = mhV21StripHeader(r2);
            if (r2 === null) {
              r = null;   // 头部注入块漂移：走 sidecar 字节兜底
            } else {
              const hb = Buffer.from(ph.HELPER_BLOCK, "utf8");
              if (r2.includes(hb)) {
                if (countBytes(r2, hb) !== 1) {
                  console.log(`[!] ${asar}\n    ${rel} 的 HELPER 块出现多次（期望 1），拒绝盲改`);
                  return false;
                }
                r2 = replaceOnce(r2, hb, Buffer.alloc(0));
              }
              r = r2;
            }
          }
        } else if (v2LegacyBuf && cur.includes(v2LegacyBuf)) {
          if (countBytes(cur, v2LegacyBuf) !== 1) {
            console.log(`[!] ${asar}\n    ${rel} 的旧版 v2 注入块出现 ${countBytes(cur, v2LegacyBuf)} 次（期望 1），拒绝盲改`);
            return false;
          }
          let r2 = replaceOnce(cur, v2LegacyBuf, Buffer.alloc(0));
          const hb = Buffer.from(ph.HELPER_BLOCK, "utf8");
          if (r2.includes(hb)) {
            if (countBytes(r2, hb) !== 1) {
              console.log(`[!] ${asar}\n    ${rel} 的 HELPER 块出现多次（期望 1），拒绝盲改`);
              return false;
            }
            r2 = replaceOnce(r2, hb, Buffer.alloc(0));
          }
          r = r2;
        } else {
          r = revertMhRenderer(cur, ph, stickyRec ? stickyRec.sticky_after : null);
        }
      }
      if (r === null) {
        const f = saved && (saved.files || []).find((x) => x.path === rel);
        if (!f) { console.log(`[!] ${asar}\n    ${rel} 反向替换失败且无 sidecar 字节兜底，拒绝盲改`); return; }
        r = Buffer.from(f.original_b64, "base64");
        fallback++;
      } else exact++;
      overwrite[rel] = r;
    }
    for (const [rel, buf] of Object.entries(overwrite)) mem.set(rel, buf);
    rmQuiet(side);
    commit(".modelhub-tmp");
    console.log(`[+] ${asar}\n    已还原 3 个条目（精确反向替换 ${exact}，字节兜底 ${fallback}，记录已清理）`);
    return true;
  }

  let upgradeLegacy = false;
  let upgradeDrift = null;   // {mhIdx, mhEnd, helperIdx}：v2.1 载荷漂移升级的旧尾块边界
  if (tagged === 3) {
    const rendNow = mem.get(rendRel);
    const isNewForm = sigNewBuf && countBytes(rendNow, sigNewBuf) === 1 && mhV21Injected(rendNow);
    if (isNewForm) {
      // 载荷漂移检查：三点结构在即视为已打，但 main/renderer 尾部的 modelhub 代码块
      // 与当前载荷不一致时（修 bug/改排序/改文案后），按边界标记剥旧重注——
      // 否则已部署安装永远拿不到载荷更新。
      const mainNow = mem.get(MH_MAIN_REL);
      const mhMark = Buffer.from('import{ipcMain as MdlH}from"electron";', "utf8");
      const enhMark = Buffer.from('import{ipcMain as Zenh}from"electron";', "utf8");
      const helperMark = Buffer.from(";window.__mhToast=(", "utf8");
      const mainHandlers = Buffer.from(ph.MAIN_HANDLERS, "utf8");
      const helperBlock = Buffer.from(ph.HELPER_BLOCK, "utf8");
      const mhIdx = mainNow.lastIndexOf(mhMark);
      const enhIdx = mhIdx >= 0 ? mainNow.indexOf(enhMark, mhIdx) : -1;
      const mhEnd = enhIdx > mhIdx ? enhIdx : (mhIdx >= 0 ? mainNow.length : -1);
      const helperIdx = rendNow.lastIndexOf(helperMark);
      const mainTail = mhIdx >= 0 ? mainNow.subarray(mhIdx, mhEnd) : Buffer.alloc(0);
      const rendTail = helperIdx >= 0 ? rendNow.subarray(helperIdx) : Buffer.alloc(0);
      // 完整性自检：待剥尾部必须确实是我的块（含特征串），防边界标记在未来版本失配
      const tailIsOurs = (mainTail.length === 0 || (mainTail.includes(Buffer.from("modelhub:fetch-models")) && mainTail.includes(Buffer.from("probe-vision"))))
        && (rendTail.length === 0 || rendTail.includes(MH_MARK_RENDER));
      const drift = tailIsOurs && (preDrift || !mainTail.equals(mainHandlers) || !rendTail.equals(helperBlock) || countBytes(rendNow, v2HdrInsert) !== 1);
      if (!drift) {
        console.log(`[=] ${asar}\n    已打模型拉取补丁（v2.1 列表头部位置），跳过`);
        return false;
      }
      if (!tailIsOurs) {
        console.log(`[!] ${asar}\n    v2.1 尾块边界校验失败（疑似版本结构变化），先 --modelhub --revert 再重打`);
        return false;
      }
      console.log(`[*] 检测到 v2.1 载荷有更新（排序/去重/文案），按边界标记剥旧重注`);
      upgradeDrift = { mhIdx, mhEnd, helperIdx };
    } else {
      const isLegacyForm = v2LegacyBuf && countBytes(rendNow, v2LegacyBuf) === 1;
      if (!isLegacyForm) {
        console.log(`[!] ${asar}\n    注入形态无法识别（标记在但新/旧注入块均未命中），先 --modelhub --revert 再重打`);
        return false;
      }
      // 升级必须从 sidecar 原件整体回退三个条目后重打：当前 preload/main 已含旧注入，
      // 直接套用注入串会二次注入（main 里 ipcMain.handle 同通道注册两次会抛异常，应用无法启动）
      if (!saved || !(saved.files || []).some((f) => f.path === rendRel)) {
        console.log(`[!] ${asar}\n    旧版注入的 sidecar 原件缺失或失配，无法安全原地升级；先 --modelhub --revert 再重打`);
        return false;
      }
      console.log(`[*] 检测到旧版 v2 注入（独立行按钮），从 sidecar 原件回退后原地升级为 v2.1 列表头部位置`);
      upgradeLegacy = true;
    }
  }
  if (tagged && !upgradeLegacy && !upgradeDrift) {
    console.log(`[!] ${asar}\n    注入状态不完整（${tagged}/3），先 --modelhub --revert 再重打`);
    return false;
  }

  // —— 组装补丁字节（先校验锚点各唯一一次） ——
  let preBuf = mem.get(MH_PRELOAD_REL);
  let mainBuf = mem.get(MH_MAIN_REL);
  if (upgradeDrift) {
    // v2.1 载荷漂移升级（自包含分支）：main/renderer 尾部按边界剥旧重注；
    // 头部按钮位置式剥旧插新；preload 注入形态随内核漂移时同样剥旧重注——
    // 走公共组装路径会给 preload/main 二次注入，所以这里独立完成并返回。
    const { mhIdx, mhEnd, helperIdx } = upgradeDrift;
    const mainNow = mem.get(MH_MAIN_REL);
    const rendNow = mem.get(rendRel);
    const mainNew = Buffer.concat([
      mainNow.subarray(0, mhIdx),
      Buffer.from(ph.MAIN_HANDLERS, "utf8"),
      mainNow.subarray(mhEnd),
    ]);
    let rendNew = Buffer.concat([
      rendNow.subarray(0, helperIdx),
      Buffer.from(ph.HELPER_BLOCK, "utf8"),
    ]);
    const stripped = mhV21StripHeader(rendNew);
    const aIdx = stripped === null ? -1 : stripped.indexOf(v2HdrAnchor);
    if (aIdx < 0) {
      console.log(`[!] ${asar}\n    头部按钮注入块边界校验失败，拒绝漂移升级；先 --modelhub --revert 再重打`);
      return false;
    }
    const at = aIdx + v2HdrAnchor.length;
    rendNew = Buffer.concat([
      stripped.subarray(0, at),
      Buffer.from(ph.RENDER_V2_HDR_INSERT, "utf8"),
      stripped.subarray(at),
    ]);
    if (!checkBundleSyntax(rendNew, path.basename(rendRel))) return false;
    mem.set(MH_MAIN_REL, mainNew);
    mem.set(rendRel, rendNew);
    let preFixed = false;
    if (preDrift) {
      if (!preInjPrev || countBytes(preNow, preInjPrev) !== 1) {
        console.log(`[!] ${asar}\n    preload 旧注入形态不唯一/未命中，拒绝盲改；先 --modelhub --revert 再重打`);
        return false;
      }
      const preStripped = replaceOnce(preNow, preInjPrev, Buffer.alloc(0));
      const preAnchor = Buffer.from(ph.PRELOAD_ANCHOR, "utf8");
      if (countBytes(preStripped, preAnchor) !== 1) {
        console.log(`[!] ${asar}\n    剥离后 preload 锚点出现 ${countBytes(preStripped, preAnchor)} 次（期望 1），拒绝盲改`);
        return false;
      }
      const preNew = replaceOnce(preStripped, preAnchor, Buffer.concat([preAnchor, preInjCur]));
      if (!checkBundleSyntax(preNew, "out/preload/index.cjs")) return false;
      mem.set(MH_PRELOAD_REL, preNew);
      preFixed = true;
    }
    // sidecar 保留（仍持有首打时的干净原件，供 revert 兜底）；flush 内部刷新 asar_size
    mem.flush(".modelhub-tmp");
    console.log(`[+] ${asar}\n    模型拉取补丁载荷漂移升级完成（自然序排序 + 确认去重 + 按钮一次性锁）${preFixed ? "；preload 注入形态已随内核换新" : ""}`);
    return true;
  }
  let rendBuf = mem.get(rendRel);
  if (upgradeLegacy) {
    const orig = new Map((saved.files || []).map((f) => [f.path, Buffer.from(f.original_b64, "base64")]));
    const missing = [MH_PRELOAD_REL, MH_MAIN_REL, rendRel].filter((p) => !orig.has(p));
    if (missing.length) {
      console.log(`[!] ${asar}\n    sidecar 原件缺条目：${missing.join(", ")}，拒绝升级`);
      return false;
    }
    // sidecar 原件拍摄于 modelhub 首打时——若其后又打过别的 preload/main 类补丁（如 --enhance-btn），
    // 回退会连它们一起抹掉。检测到这种情况就提示重跑，避免静默丢失功能入口。
    const hadEnhance = mainBuf.includes(ENH_MARK_MAIN) || preBuf.includes(ENH_MARK_PRELOAD);
    preBuf = orig.get(MH_PRELOAD_REL);
    mainBuf = orig.get(MH_MAIN_REL);
    rendBuf = orig.get(rendRel);
    if (hadEnhance) {
      console.log("[*] 检测到此前打过增强按钮补丁，modelhub 回退会抹掉其 preload/main 注入——升级完成后请重跑 --enhance-btn 修复");
    }
  }

  const preAnchor = Buffer.from(ph.PRELOAD_ANCHOR, "utf8");
  const preCnt = countBytes(preBuf, preAnchor);
  if (preCnt !== 1) {
    console.log(`[!] ${asar}\n    preload 锚点出现 ${preCnt} 次（期望 1），拒绝盲改`);
    return false;
  }
  if (mode === "v1") {
    for (const key of ["ORIG_ADD_BTN", "ORIG_QPT", "STICKY_OLD", "LE_OLD"]) {
      const cnt = countBytes(rendBuf, Buffer.from(ph[key], "utf8"));
      if (cnt !== 1) {
        console.log(`[!] ${asar}\n    renderer 锚点 ${key} 出现 ${cnt} 次（期望 1），拒绝盲改`);
        return false;
      }
    }
  } else if (upgradeDrift) {
    // 不可达：漂移分支已在上方自包含返回；保留分支形状以防未来重排
    console.log(`[!] ${asar}\n    漂移升级流程异常，拒绝盲改`);
    return false;
  } else {
    const aCnt = countBytes(rendBuf, callAnchorBuf);
    const residue = [
      ["v2.1签名", sigNewBuf], ["v2.1传参", propBuf], ["v2.1按钮", v2HdrInsert],
    ].map(([lbl, b]) => b ? countBytes(rendBuf, b) : 0).reduce((a, b) => a + b, 0);
    if (aCnt !== 1 || residue !== 0
      || countBytes(rendBuf, sigOldBuf) !== 1 || countBytes(rendBuf, v2HdrAnchor) !== 1) {
      console.log(`[!] ${asar}\n    renderer 锚点组 ${mode} 计数异常（call=${aCnt} 残留=${residue} sigOld=${countBytes(rendBuf, sigOldBuf)} hdr=${countBytes(rendBuf, v2HdrAnchor)}，期望 1/0/1/1），拒绝盲改`);
      return false;
    }
  }

  const pNew = replaceOnce(preBuf, preAnchor,
    Buffer.concat([preAnchor, preInjCur]));
  const mNew = Buffer.concat([mainBuf, Buffer.from(ph.MAIN_HANDLERS, "utf8")]);
  let rNew;
  if (mode === "v1") {
    rNew = replaceOnce(rendBuf, Buffer.from(ph.ORIG_ADD_BTN, "utf8"),
      Buffer.from(ph.ADD_BTN + "," + ph.ORIG_ADD_BTN, "utf8"));
    rNew = replaceOnce(rNew, Buffer.from(ph.ORIG_QPT, "utf8"), Buffer.from(ph.EDIT_WRAP, "utf8"));
    rNew = replaceOnce(rNew, Buffer.from(ph.STICKY_OLD, "utf8"), Buffer.from(ph.STICKY_NEW, "utf8"));
    rNew = replaceOnce(rNew, Buffer.from(ph.LE_OLD, "utf8"), Buffer.from(ph.LE_NEW, "utf8"));
  } else {
    // v2.1/v3.1 三点注入：① 签名加 mhEndpoint 形参 ② 调用点 props 内传端点草稿数据（插在锚点之后才是 props 位置）③ 模型列表头部插入拉取按钮
    rNew = replaceOnce(rendBuf, sigOldBuf, sigNewBuf);
    rNew = replaceOnce(rNew, callAnchorBuf, Buffer.concat([callAnchorBuf, propBuf]));
    rNew = replaceOnce(rNew, v2HdrAnchor, Buffer.concat([v2HdrAnchor, v2HdrInsert]));
  }
  rNew = Buffer.concat([rNew, Buffer.from(ph.HELPER_BLOCK, "utf8")]);
  if (!checkBundleSyntax(rNew, path.basename(rendRel))) return;

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
  // sticky_after 仅 v1 需要（STICKY_NEW 在文件里有大量自然出现，需用注入点后文唯一定位）
  let stickyAfter = null;
  if (mode === "v1") {
    const soBuf = Buffer.from(ph.STICKY_OLD, "utf8");
    const soIdx = rendBuf.indexOf(soBuf);
    stickyAfter = soIdx >= 0
      ? rNew.subarray(soIdx + ph.STICKY_NEW.length, soIdx + ph.STICKY_NEW.length + 32).toString("base64")
      : null;
  }
  mem.set(MH_PRELOAD_REL, pNew);
  mem.set(MH_MAIN_REL, mNew);
  mem.set(rendRel, rNew);
  commit(".modelhub-tmp", (newSize) => writeJson(side, {
    asar_size: newSize,
    renderer_path: rendRel,
    mode: mode === "v2" ? "v2.1" : mode === "v3" ? "v3.1" : mode,
    files: originals.map(([rel, b]) => ({
      path: rel, size: b.length, original_b64: b.toString("base64"),
      ...(rel === rendRel && stickyAfter ? { sticky_after: stickyAfter } : {}),
    })),
  }));
  console.log(`[+] ${asar}\n    模型拉取补丁注入完成（preload/main/renderer 三条目改写；拉取按钮位于模型列表头部「添加模型」左侧）\n` +
              `    记录: ${path.basename(side)}`);
  return true;
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

function processEnhanceBtn(asar, checkOnly, revert, srcPath, mem) {
  const ph = loadMhPayload();
  const own = !mem;
  if (own) mem = memAsarOpen(asar);
  const commit = (suffix) => {
    if (own) {
      const newSize = mem.flush(suffix);
      console.log(`    新大小 ${newSize.toLocaleString()} 字节`);
      return newSize;
    }
    return null;
  };
  const need = ["out/preload/index.cjs", "out/main/index.js", ENH_INDEX_PATH];
  if (need.some((p) => !mem.has(p))) {
    console.log(`[!] ${asar}\n    缺少 preload/main/index 条目，版本结构可能已变，跳过`);
    return false;
  }
  const preBuf = mem.get("out/preload/index.cjs");
  const mainBuf = mem.get("out/main/index.js");
  const idxBuf = mem.get(ENH_INDEX_PATH);
  const scriptCur0 = mem.has(ENH_SCRIPT_PATH) ? mem.get(ENH_SCRIPT_PATH) : null;

  const flags = [
    idxBuf.includes(ENH_MARK_INDEX),
    !!scriptCur0,
    preBuf.includes(ENH_MARK_PRELOAD),
    mainBuf.includes(ENH_MARK_MAIN),
  ];
  const partial = flags.filter(Boolean).length;
  const tagged = partial === 4;

  const anchorA = Buffer.from(ph.ENH_PRELOAD_ANCHOR_A, "utf8");
  const anchorB = Buffer.from(ph.ENH_PRELOAD_ANCHOR_B, "utf8");
  const injectNew = Buffer.from(ph.ENH_PRELOAD_INJECT, "utf8");
  const injectOld = ph.ENH_PRELOAD_INJECT_V1 ? Buffer.from(ph.ENH_PRELOAD_INJECT_V1, "utf8") : null;
  // 内核 preload 第 2 代形态见证（3.14 起原生 connectRemote 体的 ipcRenderer 绑定名 h→_）：
  // 该形态下必须用 V3 注入串，否则运行时 h.ipcRenderer 为 undefined（「reading 'invoke'」报错）。
  const injectV3 = ph.ENH_PRELOAD_INJECT_V3 ? Buffer.from(ph.ENH_PRELOAD_INJECT_V3, "utf8") : null;
  const preWitness = ph.PRELOAD_V2_WITNESS ? Buffer.from(ph.PRELOAD_V2_WITNESS, "utf8") : null;
  const injCur = injectV3 && preWitness && preBuf.includes(preWitness) ? injectV3 : injectNew;
  const preIsCurrent = preBuf.includes(injCur);
  const handlers = buildEnhanceMainBlock(ph);
  const isV2 = mainBuf.includes(Buffer.from("zcode-enhance:list-models", "utf8"));
  // 新旧判读：主块与当前载荷逐字节一致、注入脚本与源文件一致，才算"已打（最新）"；
  // 载荷/脚本更新后 apply 会自动剥离旧注入重打（原地升级），无需先 revert。
  const enhSrcPath = srcPath || path.join(__dirname, "zcode-enhance.js");
  const scriptSrc = fs.existsSync(enhSrcPath) ? fs.readFileSync(enhSrcPath) : null;
  const mainIsCurrent = countBytes(mainBuf, handlers) === 1;
  const scriptIsCurrent = !!scriptCur0 && !!scriptSrc && scriptSrc.equals(scriptCur0);

  if (checkOnly) {
    const st = tagged ? (isV2 ? (mainIsCurrent && scriptIsCurrent ? (preIsCurrent ? "已打" : "已打（preload 注入形态与内核不匹配，重跑 --enhance-btn 原地升级）")
                              : "已打（载荷/脚本有更新，重跑 --enhance-btn 原地升级）")
                              : "已打（旧版，重跑 --enhance-btn 原地升级）")
                      : (partial ? `不完整（${partial}/4）` : "未打");
    console.log(`[*] ${asar}\n    增强提示词按钮: ${st}`);
    return false;
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

  /** 移除 preload 注入串：按内核形态的新版优先，旧版串兜底（升级前的存量安装）。 */
  function stripPreload(buf, bad) {
    for (const inj of [injectV3, injectNew, injectOld].filter(Boolean)) {
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
      return false;
    }
    mem.set("out/preload/index.cjs", pre2);
    mem.set("out/main/index.js", main2);
    mem.set(ENH_INDEX_PATH, idx2);
    mem.del(ENH_SCRIPT_PATH);
    commit(".enhance-tmp");
    console.log(`[+] ${asar}\n    已精确移除增强按钮注入（preload/main/index 复原，脚本条目已删）`);
    return true;
  }

  // 打补丁 / 原地升级（旧版注入先剥离再按当前载荷重注入，partial 状态一并修复）
  if (tagged && isV2 && mainIsCurrent && scriptIsCurrent && preIsCurrent) { console.log(`[=] ${asar}\n    已打增强按钮（载荷为最新），跳过`); return false; }
  const bad = [];
  let pre2 = stripPreload(preBuf, bad);
  let main2 = mainBuf.includes(ENH_MARK_MAIN) ? stripMainBlock(mainBuf, bad) : mainBuf;
  if (bad.length || pre2.includes(ENH_MARK_PRELOAD) || main2.includes(ENH_MARK_MAIN)) {
    console.log(`[!] ${asar}\n    ${bad.join("；") || "注入残留无法识别"}，先 --enhance-btn --revert 再重打`);
    return false;
  }

  const cntA = countBytes(pre2, anchorA), cntB = countBytes(pre2, anchorB);
  if (cntA + cntB !== 1) {
    console.log(`[!] ${asar}\n    preload 锚点命中 ${cntA + cntB} 个（期望 1），拒绝盲改`);
    return false;
  }
  const anchor = cntA === 1 ? anchorA : anchorB;
  const tail = cntA === 1 ? "connectRemote" : "modelhubFetchModels";
  const scriptBytes = loadEnhanceSrc(srcPath);

  const head = anchor.subarray(0, anchor.length - Buffer.byteLength(tail));
  const preNew = replaceOnce(pre2, anchor, Buffer.concat([head, injCur, Buffer.from(tail)]));
  const sep = main2.length && main2[main2.length - 1] === 0x0a ? Buffer.alloc(0) : Buffer.from("\n");
  const mainNew = Buffer.concat([main2, sep, handlers]);
  let idxNew = idxBuf;
  if (!idxNew.includes(ENH_MARK_INDEX)) {
    if (countBytes(idxNew, Buffer.from("</body>")) !== 1) {
      console.log(`[!] ${asar}\n    index.html 的 </body> 出现 ${countBytes(idxNew, Buffer.from("</body>"))} 次（期望 1），拒绝盲改`);
      return false;
    }
    idxNew = replaceOnce(idxNew, Buffer.from("</body>"), Buffer.concat([ENH_MARK_INDEX, Buffer.from("</body>")]));
  }

  mem.set("out/preload/index.cjs", preNew);
  mem.set("out/main/index.js", mainNew);
  mem.set(ENH_INDEX_PATH, idxNew);
  mem.set(ENH_SCRIPT_PATH, scriptBytes);
  commit(".enhance-tmp");
  console.log(`[+] ${asar}\n    增强提示词按钮注入完成${tagged ? "（旧版已原地升级）" : ""}（preload IPC×2 + main handler×2 + 工具栏按钮脚本）`);
  return true;
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
  // 每项为变体列表：旧内核 y/m → v/f → 3.12.x A/w 形态（混淆名随版本漂移，结构不变），打时按内容命中选一。
  const variants = [
    ["P1", [[ph.P1_OLD, ph.P1_NEW], [ph.P1_OLD_V2, ph.P1_NEW_V2], [ph.P1_OLD_V3, ph.P1_NEW_V3]]],
    ["P2", [[ph.P2_OLD, ph.P2_NEW], [ph.P2_OLD_V2, ph.P2_NEW_V2]]],
  ].map(([lbl, list]) => [lbl, list.map(([o, n]) => [Buffer.from(o, "utf8"), Buffer.from(n, "utf8")])]);

  let data;
  try {
    data = fs.readFileSync(target);
  } catch {
    console.log(`[!] 无权限读取 ${target}`);
    return;
  }

  const cnt = (v) => [countBytes(data, v[0]), countBytes(data, v[1])];
  const applied = variants.filter(([, list]) => list.some((v) => cnt(v)[1] >= 1 && cnt(v)[0] === 0)).length;
  const st = applied === 2 ? "已打" : (applied === 1 ? "部分（异常）" : "未打");
  console.log(`[*] ${target}`);
  console.log(`    全消息可编辑: ${st}`);

  if (checkOnly) return;

  if (revert) {
    if (applied === 0) { console.log("    [.] 未打，跳过"); return; }
    let changed = data;
    for (const [, list] of variants)
      for (const v of list)
        if (cnt(v)[1] === 1) changed = replaceOnce(changed, v[1], v[0]);
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
  for (const [lbl, list] of variants) {
    const hit = list.filter((v) => cnt(v)[0] === 1 && cnt(v)[1] === 0);
    if (hit.length !== 1) {
      const detail = list.map((v) => `旧=${cnt(v)[0]} 新=${cnt(v)[1]}`).join("，");
      console.log(`    [!] 锚点 ${lbl} 变体命中 ${hit.length} 个（${detail}），版本可能不兼容，拒绝盲改`);
      return;
    }
  }
  let changed = data;
  for (const [, list] of variants)
    for (const v of list)
      if (cnt(v)[0] === 1) changed = replaceOnce(changed, v[0], v[1]);

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

  // asar 补丁注册表：新增 asar 类补丁 = 加一行 + processX 支持 mem 参数（批量合并落盘）。
  // repack: true 的补丁走 MemAsar 共享内存态，多个同时请求时合并为一次全量重打包；
  // 顺序即历史 wrapper 顺序（continue→tps→modelhub→enhance），保证锚点所见状态与
  // 逐个顺序执行字节一致。in-place（等长原位改）补丁先行，避免 repack 读到旧文件。
  const ASAR_PATCH_TABLE = [
    { opt: "usageChart",  label: "用量页去截断补丁", run: (a, c, r) => processUsageChart(a, c, r) },
    { opt: "menuWidth",   label: "模型菜单加宽",     run: (a, c, r) => processMenuWidth(a, c, r) },
    { opt: "quotaBanner", label: "去额度骚扰横幅",   run: (a, c, r) => processQuotaBanner(a, c, r) },
    { opt: "continueBtn", label: "继续按钮注入",     repack: true, run: (a, c, r, m) => processContinueBtn(a, c, r, opts.contSrc, m) },
    { opt: "tpsFooter",   label: "TPS 统计栏注入",   repack: true, run: (a, c, r, m) => processTpsFooter(a, c, r, opts.tpsSrc, m) },
    { opt: "modelhub",    label: "模型拉取补丁（modelhub）", repack: true, run: (a, c, r, m) => processModelhub(a, c, r, m) },
    { opt: "enhanceBtn",  label: "增强提示词按钮",   repack: true, run: (a, c, r, m) => processEnhanceBtn(a, c, r, opts.enhanceSrc, m) },
  ];
  const guardFileBusy = (e, a) => {
    if (e.code === "EACCES" || e.code === "EPERM" || e.code === "EBUSY") {
      console.log(`[!] ${a}\n    文件被占用（ZCode 正在运行）或无写入权限；完全退出 ZCode 后重试`);
    } else throw e;
  };

  if (asarFlags) {
    const asars = resolveAsars(opts.target);
    const mode = opts.check ? "检查" : (opts.revert ? "还原" : "打补丁");
    const active = ASAR_PATCH_TABLE.filter((t) => opts[t.opt]);
    const inPlace = active.filter((t) => !t.repack);
    const repackable = active.filter((t) => t.repack);
    for (const t of active) console.log(`=== ${t.label}，目标 ${asars.length} 处，模式：${mode} ===`);
    for (const a of asars) {
      for (const t of inPlace) {
        try { t.run(a, opts.check, opts.revert); }
        catch (e) { guardFileBusy(e, a); }
      }
      if (repackable.length) {
        try {
          // MemAsar 批量：一次打开、N 个补丁内存叠加、单次落盘（revert/apply 同一套路）
          const mem = memAsarOpen(a);
          let touched = 0;
          for (const t of repackable) {
            if (t.run(a, opts.check, opts.revert, mem)) touched++;
          }
          if (!opts.check && mem.dirtyCount()) {
            const newSize = mem.flush(".batch-tmp");
            console.log(`[*] ${a}\n    ${touched} 项补丁合并为一次重打包（新大小 ${newSize.toLocaleString()} 字节）`);
          }
        } catch (e) { guardFileBusy(e, a); }
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
