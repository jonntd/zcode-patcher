# AGENTS.md

给 AI 助手的项目级规则。改完代码不是结束——**编译产物不同步 = 没改完**。

## 改动后必须执行的命令

| 改了什么 | 必须做 |
|---|---|
| `launcher/**`（Go 源码） | `npm run build:all` 重建 dist/ 六平台二进制，然后 `npm test` |
| `scripts/*.js` / `scripts/*.json`（补丁脚本/载荷） | 同上——这些文件是 `go:embed` 进二进制的，不重编 dist 分发出去的就是旧补丁 |
| 只改文档（README/SKILL.md） | `npm test` 即可 |

`npm run build:all` = `node scripts/build-launcher.js --all`（先把 `scripts/` 拷入 `launcher/` 再 embed 编译）。

## 测试红线的含义

`npm test`（23 项冒烟）里这些失败对应固定原因，按对应方式修，不要绕过断言：

- **「launcher/ 内嵌副本与 scripts/ 一致」失败** → 忘了同步：先 `cp scripts/*.js scripts/*.json launcher/`（或直接跑 build:all，它会拷）再重测；
- **「--apply-all 打印用法」类 CLI 契约失败** → 改坏了 patcher/TUI 的参数面，先修代码。

## 本仓库的坑（踩过的）

- `npm run build` **只编 Windows 目标**；macOS/Linux 必须 `--all` 或 `build:all`，否则 dist 里的 mac 二进制是旧的。
- 验证二进制里有没有中文字符串**别用 `strings`**（默认只认 ASCII，UTF-8 全漏）；用 `grep -a "中文"` 按字节搜。
- Go 1.21+ 编译器会裁掉 `runtime.GOOS` 不匹配的分支：在 darwin 二进制里搜不到 Windows 专属字符串是正常的，反查对应平台的 exe 才有效。
- 仓库已配置 `.gitignore` 忽略 `.zcode/`（ZCode 工作区状态）与 `dist/`（构建产物）；一次性调试脚本用完即删，不留仓库。

## ZCode 升级后的快速迭代流程

ZCode 自动升级会覆盖 app.asar/zcode.cjs（补丁消失是设计使然），随后锚点可能漂移。固定流水线：

1. **摸底**：`node ~/.zcode/patcher/zcode-patcher.js --status --json`（或逐个 `--check`）→ 看哪些补丁仍命中、哪些报「版本结构可能已变」。锚点体系是按内容定位的，很多补丁跨版本天然可用，别一上来就全改。
2. **解包分析**：`node scripts/asar-extract.js <新asar> --list out/renderer/assets` 找大 bundle；`-o /tmp/newver out/main/index.js out/preload/index.cjs ...` 提取后 `node --check`（.mjs）+ 对旧版本副本 diff 搜符号改名。
3. **适配原则**：锚点漂移 = **给 payload 加新变体组**（`*_V2` 模式，参照 quota 的 v1/v2、modelhub 的 v1/v2.1、editall 的 P1_V2），绝不改写旧变体——多版本安装共存靠这个。
4. **验证**：`scripts/dev-bed.sh start`（拷副本→打全套→隔离启动→CDP 探活）→ 用 CDP 探针确认 `root-startup-loading` 不存在、rootLen 正常、注入按钮/DOM 几何正确。**不要在宿主上验证。**
5. **分发**：`npm test` 全绿 → `npm run build:all` → `cp scripts/*.js scripts/*.json ~/.zcode/patcher/` → 对真实安装打补丁（只动文件，重启交给用户）。

## 宿主即目标

这台机器的 ZCode 桌面端就是补丁的目标安装，**绝不 `pkill`/强杀 ZCode 进程**（agent 自己就跑在里面）。测试补丁效果一律用副本：拷 `/Applications/ZCode.app` 到 /tmp、配 `ZCODE_DESKTOP_USER_DATA_DIR` + `ZCODE_DESKTOP_HOME_DIR` 隔离运行（不设会强制回落到真实数据目录并和宿主撞单实例锁，表现为「秒退」，那是锁冲突不是补丁坏了）。
