#!/usr/bin/env node
"use strict";
/**
 * asar-extract —— ZCode 升级后的锚点分析工具（零依赖）
 * 从 app.asar 里按条目提取文件，供锚点漂移时 diff/搜索新版本的 bundle。
 *
 * 用法：
 *   node scripts/asar-extract.js <asar> --list [路径前缀]        # 列条目（可按前缀过滤）
 *   node scripts/asar-extract.js <asar> -o <输出目录> <条目...>   # 提取条目到输出目录
 *
 * 例：
 *   node scripts/asar-extract.js /Applications/ZCode.app/Contents/Resources/app.asar --list out/renderer/assets
 *   node scripts/asar-extract.js /Applications/ZCode.app/Contents/Resources/app.asar -o /tmp/newver \
 *        out/main/index.js out/preload/index.cjs package.json
 */

const fs = require("fs");
const path = require("path");

function die(msg) { console.error("[x] " + msg); process.exit(1); }

function asarOpen(asar) {
  const raw = fs.readFileSync(asar);
  if (raw.length < 16 || raw.readUInt32LE(0) !== 4) die(`asar 头格式不符: ${asar}`);
  const headerSize = raw.readUInt32LE(4);
  let header;
  try {
    header = JSON.parse(raw.subarray(16, 16 + raw.readUInt32LE(12)).toString("utf8"));
  } catch (e) {
    die(`asar 头 JSON 解析失败: ${e.message}`);
  }
  return { raw, header, dataStart: 8 + headerSize };
}

function walk(node, prefix, out) {
  for (const name of Object.keys(node.files || {})) {
    const ent = node.files[name];
    const p = prefix ? `${prefix}/${name}` : name;
    if (ent.files) walk(ent, p, out);
    else out.push([p, ent]);
  }
  return out;
}

const args = process.argv.slice(2);
const asar = args[0];
if (!asar || !fs.existsSync(asar)) die("用法: node asar-extract.js <asar> --list [前缀] | -o <目录> <条目...>");

const state = asarOpen(asar);
const ents = walk(state.header, "", []);

if (args[1] === "--list") {
  const prefix = args[2] || "";
  for (const [p, e] of ents) {
    if (prefix && !p.startsWith(prefix)) continue;
    console.log(`${String(e.size).padStart(10)}  ${p}${e.unpacked ? "  (unpacked)" : ""}`);
  }
  process.exit(0);
}

if (args[1] !== "-o") die("用法: node asar-extract.js <asar> --list [前缀] | -o <目录> <条目...>");
const outDir = args[2];
const entries = args.slice(3);
if (!entries.length) die("未指定要提取的条目");
fs.mkdirSync(outDir, { recursive: true });

let n = 0;
for (const want of entries) {
  const hit = ents.find(([p]) => p === want);
  if (!hit) { console.error(`[!] 未找到条目: ${want}`); continue; }
  const [p, e] = hit;
  const off = state.dataStart + Number(e.offset);
  const dst = path.join(outDir, p.split("/").pop());
  fs.writeFileSync(dst, state.raw.subarray(off, off + e.size));
  console.log(`[+] ${p} -> ${dst} (${e.size} 字节)`);
  n++;
}
console.log(`共提取 ${n}/${entries.length} 项到 ${outDir}`);
