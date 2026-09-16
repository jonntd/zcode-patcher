# zcode-patcher 跨平台单文件启动器

`zcode-patcher` 本身是**零依赖的 Node.js 脚本**。本目录（`launcher/` + `scripts/build-launcher.js`）用 Go 给它包了一层**每个平台一个的独立可执行文件**，避免依赖外置卷/长路径下的 `scripts/` 目录。

最终产物是一个 ~1.7MB 的原生二进制，用户拿到**一个文件**就能在对应系统上运行全部补丁，无需安装 Go 或拷贝多个脚本。

## 原理

```
zcode-patch-<os>-<arch>[.exe]  (Go 二进制，go:embed 六个文件)
  │
  │ 每次运行时把内嵌文件原子解包到  ~/.zcode/patcher/
  │   (zcode-patcher.js + zcode-tps.js + zcode-enhance.js
  │    + zcode-continue.js + modelhub_payload.json)
  │
  └─ 用系统 PATH 里的 node 执行 zcode-patcher.js，原样透传命令行参数
```

- 优先系统 PATH 中的 `node` 运行；没有 node 时回退到 VS Code 系编辑器（VS Code / Insiders / VSCodium / Cursor / Windsurf / Trae 等）自带的 Electron，以 `ELECTRON_RUN_AS_NODE=1` 当纯 Node 用——这是体积只有 ~1.7MB 而非 pkg 的 ~40MB 的原因，也让没装 Node 的 Windows 用户装了任意这类编辑器即可用。
- sidecar 必须与主脚本同目录，因为 `zcode-patcher.js` 用 `path.join(__dirname, …)` 读取它们，所以启动器把它们全部解包到同一目录。
- 解包走「临时文件 + rename」原子写入，内容相同则跳过，避免每次运行都写盘（也减少被杀软/索引扫描）。

## 单文件二进制用法

**无参数启动 → 进入交互式菜单（TUI）**，可方向键选补丁、Enter 打/还原、1-9 快选、q 退出：

```bash
./zcode-patch-macos-arm64          # 交互式菜单
zcode-patch-win-x64.exe            # Windows 同样无参数进入菜单
```

**`--status`（别名 `--check-all`）→ 非交互状态报告**，一次性列出全部 9 个补丁与汇总，供脚本/CI 用：

```bash
./zcode-patch-macos-arm64 --status
```

**`--json` → 机器可读的状态 JSON**，可直接被脚本解析。输出一份数组，每项含 `name` / `flag` / `state`（`applied` / `partial` / `not` / `unknown`）。退出码：全程只读、不改任何补丁；若任一补丁为 `partial`/`unknown` 返回 2，全部正常返回 0：

```bash
./zcode-patch-macos-arm64 --json
# 可与 --status 混用（等价）
./zcode-patch-macos-arm64 --status --json
```

```json
[
  { "name": "思考等级透传",   "flag": "(default)",     "state": "applied" },
  { "name": "全消息可编辑",   "flag": "--edit-all",    "state": "applied" }
]
```

**`--apply-all` / `--revert-all` → 一次整组打/还原全部补丁**，非交互执行、带退出码（有部分/未知状态时返回 2），适合放进安装脚本：

```bash
./zcode-patch-macos-arm64 --apply-all      # 给所有未打/部分项打上
./zcode-patch-macos-arm64 --revert-all     # 全部退回原状
```

**其他带参数 → 与直接跑 `node zcode-patcher.js` 完全一致**：

```bash
# macOS / Linux
./zcode-patch-macos-arm64 --check
./zcode-patch-linux-x64 --check
./zcode-patch-macos-arm64 --quota-banner --revert

# Windows (cmd / PowerShell)
zcode-patch-win-x64.exe --check
```

可用参数与原脚本一致：`--check / --revert / --extract`，功能开关 `--usage-chart --menu-width --continue-btn --tps-footer --modelhub --enhance-btn --quota-banner --edit-all`，`--help` 查看全部。带参数（如 `--check`）走 CLI；无参数才启动 TUI；`--status`/`--check-all`/`--json` 走非交互状态报告；`--apply-all`/`--revert-all` 走批量操作。

> 二进制对 ZCode 安装的探测、备份、还原逻辑全部复用自 `scripts/zcode-patcher.js`，未作任何改动。三个平台跨码制输出均经启动器处理（Windows 走 UTF-8/VT 修复，见 `run_windows.go`）。菜单即 `scripts/zcode-tui.js`，同样零依赖、被嵌入二进制。

## 交互式菜单（TUI）

无参数启动即进入菜单，所有「已打/未打」状态来自对 `zcode-patcher.js <flag> --check` 的只读探测，改动经确认后才调用真实的补丁子进程——不重复实现任何补丁逻辑，中断也不留半截：

| 键 | 作用 |
|---|---|
| ↑ / ↓ | 移动选择 |
| Enter（或 `h`） | 执行：**已打→还原**，**未打/未知→打**（幂等，可安全重复） |
| 1-9 | 快选对应项 |
| `q` / Ctrl-C | 退出 |

选中的补丁会高亮反显，Enter 时显示「… 执行中」，结束后自动刷新该行状态。

## 构建

需要本机安装 **Go toolchain**（任意新于 1.22 的版本）。脚本会自动把 `scripts/` 里六个文件复制进 `launcher/`（它们被 `go:embed`），再交叉编译。

```bash
npm test                # 冒烟测试（零依赖，含明文密钥守护）

# 默认：Windows 两个目标（.exe）
npm run build           # 等价 node scripts/build-launcher.js

# 六个平台全出（Windows + macOS + Linux × amd64/arm64）
npm run build:all       # 等价 node scripts/build-launcher.js --all

# 仅本机平台（本地测试）
npm run build:host      # 等价 node scripts/build-launcher.js --host
```

产物（`dist/`）：

| 文件名 | 平台 |
|---|---|
| `zcode-patch-win-x64.exe` / `zcode-patch-win-arm64.exe` | Windows x64 / ARM64 |
| `zcode-patch-macos-x64` / `zcode-patch-macos-arm64` | macOS Intel / Apple Silicon |
| `zcode-patch-linux-x64` / `zcode-patch-linux-arm64` | Linux x86-64 / AArch64 |

构建参数：`CGO_ENABLED=0`（纯静态、无动态依赖，拷哪都能跑）、`-s -w`（去符号瘦身）、`-trimpath`、`-buildvcs=false`，并把版本号经 `-ldflags -X main.version=…` 注入。

## 结构

```
launcher/
  main.go            入口：解包内嵌文件 + 定位 node + 透传参数执行
  run_unix.go        !windows：syscall.Exec 原地替换进程，子进程接管终端/信号
  run_windows.go     windows：spawn 子进程 + 转发三流 + 拼 UTF-8/VT 控制台
  go.mod             module github.com/jonntd/zcode-patcher/launcher
  *.js / *.json      (由 build 脚本从 scripts/ 复制，go:embed；构建产物、不入库)
scripts/
  build-launcher.js  交叉编译脚本（入口，npm run build）
  zcode-patcher.js   零依赖补丁 CLI
  zcode-tui.js       交互式菜单 / 非交互 --status --json --apply-all --revert-all
  zcode-tps.js / zcode-enhance.js / zcode-continue.js / modelhub_payload.json
                     注入用 sidecar（与主脚本同目录解包）
  zcode-patch.cmd    Windows 快捷批处理
  legacy/            退役的 Python 实现，仅供回退参考
tests/
  smoke.test.js      零依赖冒烟测试（npm test，CI 用）
.github/workflows/
  test.yml           push/PR：跑冒烟测试 + 六平台构建
  auto-release.yml   push main：自动 bump 版本、构建、打 tag、发布 Release
  release.yml        手动打 v* tag 时的发布备份路径
```

## 自动化发布（CI/CD）

参考 [`incipit`](https://github.com/jonntd/incipit) 的发布方式：**每次 push 到 `main`，GitHub Actions 自动完成「测试 → bump patch 版本 → 交叉编译六平台 → 打 tag → 发 Release」**，无需本地手工打包。

- `.github/workflows/auto-release.yml`：主发布路径。先 `npm test`，再把 `package.json` 版本号 patch +1，构建六平台产物，校验产物内嵌版本号与 `--json` 可运行后，才提交版本号、打 `vX.Y.Z` tag 并推送，最后把六平台二进制挂到该 tag 的 Release。**构建失败只会留下未推送的本地版本号，不会污染远程**；已发布的 tag 必然对应一份构建通过的产物。
- `.github/workflows/release.yml`：备份路径。手动推 `vX.Y.Z` tag 时触发，会先校验 tag 与 `package.json` 版本一致再发布。
- `.github/workflows/test.yml`：PR / push 时跑冒烟测试与六平台构建，不发布。

> 说明：GitHub 规定 `GITHUB_TOKEN` 推送的 commit/tag 不会触发其他 workflow（防循环），因此 auto-release 里自包含完成全部构建与发布，不依赖 release.yml 的 tag 触发。

**工作流中不含任何明文密钥**：发布使用 GitHub 自动注入的 `GITHUB_TOKEN`（`permissions: contents: write`），无需配置任何 Secret。仓库未提交 `dist/`、`node_modules/`、编辑器副本等产物（见 `.gitignore`），也不含令牌/私钥明文（`npm test` 内置了明文密钥守护检查）。

本地复现 CI 做的事：

```bash
npm test          # 冒烟测试
npm run build:all # 六平台二进制 → dist/
```

手动发布（需要指定版本号时）：先改 `package.json` 的 `version`，提交推送后再打同名 tag：

```bash
git tag v0.2.0 && git push origin v0.2.0   # 触发 release.yml
```

## 与 incipit 的关系

此启动器改编自 [`incipit`](https://github.com/jonntd/incipit) 的同名 Go launcher 思路：薄 Go 壳 + `go:embed` 内嵌业务 JS + 复用机器上的 JS 运行时，一套代码交叉编译出多平台单文件。`incipit` 在此之上还支持内嵌一个 JS bundle 并对版本做「旧 exe 不降级新缓存」。本工具的六个内嵌文件是 CLI 补丁脚本 + TUI 菜单，不做版本比较，因此启动器每次保持与嵌入内容同步即可。