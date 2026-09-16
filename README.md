# zcode-patcher

ZCode 客户端本地补丁工具。零依赖 Node.js 脚本 + Go 单文件启动器，一套代码交叉编译出 Windows / macOS / Linux 的原生可执行文件。

9 项补丁：思考等级透传、全消息可编辑、用量页去截断、模型菜单加宽、继续按钮、TPS 统计栏、模型拉取、增强提示词按钮、去额度骚扰横幅。全部幂等、可检查、可还原。

## 原理

```
zcode-patch-<os>-<arch>[.exe]   Go 二进制，go:embed 内嵌全部脚本
  │  运行时把内嵌文件原子解包到 ~/.zcode/patcher/
  └─ 用系统 node 执行补丁脚本，原样透传命令行参数
```

- 优先用系统 PATH 里的 `node`；没有 node 时回退到 VS Code 系编辑器（VS Code / Cursor / Windsurf / Trae 等）自带的 Electron，以 `ELECTRON_RUN_AS_NODE=1` 当纯 Node 用。这是体积只有 ~1.7MB 而非 pkg 的 ~40MB 的原因，也让没装 Node 的 Windows 用户装了任意这类编辑器即可用。
- 解包走「临时文件 + rename」原子写入，内容相同则跳过，避免每次运行都写盘。

## 用法

**无参数 → 交互式菜单**：

```bash
./zcode-patch-macos-arm64          # macOS / Linux
zcode-patch-win-x64.exe            # Windows
```

| 键 | 作用 |
|---|---|
| ↑ / ↓ | 移动选择 |
| Enter（或 `h`） | 执行：已打→还原，未打/未知→打（幂等，可安全重复） |
| 1-9 | 快选对应补丁 |
| `/` | 查看全部补丁状态总览 |
| `q` / Ctrl-C | 退出 |

菜单首项为「全部打我」，末项为「全部还原」，前后加确认框防误触。所有状态来自只读探测，改动经确认后才调用真实补丁子进程。

**非交互命令**：

| 命令 | 作用 |
|---|---|
| `--status`（别名 `--check-all`） | 打印全部补丁状态与汇总 |
| `--json` | 输出机器可读 JSON（每项 `name`/`flag`/`state`） |
| `--apply-all` | 给所有未打项打上 |
| `--revert-all` | 全部退回原状 |

```bash
./zcode-patch-macos-arm64 --status            # 状态报告
./zcode-patch-macos-arm64 --json              # JSON，供脚本解析
./zcode-patch-macos-arm64 --apply-all         # 一键全打
./zcode-patch-macos-arm64 --revert-all        # 一键全还原
```

`--status` / `--json` 全程只读，不改任何补丁；任一补丁为 `partial`/`unknown` 时退出码为 2，全部正常为 0。

`--json` 输出示例：

```json
[
  { "name": "思考等级透传", "flag": "(default)",  "state": "applied" },
  { "name": "全消息可编辑", "flag": "--edit-all", "state": "applied" }
]
```

**其他参数 → 与直接跑 `node zcode-patcher.js` 完全一致**：

```bash
./zcode-patch-macos-arm64 --check                      # 只检查
./zcode-patch-macos-arm64 --quota-banner               # 打单个补丁
./zcode-patch-macos-arm64 --quota-banner --revert      # 还原
./zcode-patch-macos-arm64 --help                       # 全部参数
```

功能开关：`--usage-chart --menu-width --continue-btn --tps-footer --modelhub --enhance-btn --quota-banner --edit-all`；通用参数：`--check / --revert / --extract`。

> 二进制对 ZCode 安装的探测、备份、还原逻辑全部复用自 `scripts/zcode-patcher.js`，未作改动。Windows 的 UTF-8/VT 控制台修复见 `run_windows.go`。

## 构建

需要 **Go toolchain**（≥1.22）。脚本会自动把 `scripts/` 里的文件复制进 `launcher/`（供 `go:embed`），再交叉编译。

```bash
npm test             # 冒烟测试（零依赖，含明文密钥守护）
npm run build        # Windows 两个目标（默认）
npm run build:all    # 六平台全出（Windows + macOS + Linux × amd64/arm64）
npm run build:host   # 仅本机平台（本地测试）
```

产物（`dist/`）：

| 文件名 | 平台 |
|---|---|
| `zcode-patch-win-x64.exe` / `zcode-patch-win-arm64.exe` | Windows x64 / ARM64 |
| `zcode-patch-macos-x64` / `zcode-patch-macos-arm64` | macOS Intel / Apple Silicon |
| `zcode-patch-linux-x64` / `zcode-patch-linux-arm64` | Linux x86-64 / AArch64 |

构建参数：`CGO_ENABLED=0`（纯静态、无动态依赖）、`-s -w`、`-trimpath`、`-buildvcs=false`，版本号经 `-ldflags -X main.version=…` 注入。

## 自动化发布

每次 push 到 `main`，GitHub Actions 自动完成「测试 → bump patch 版本 → 交叉编译六平台 → 打 tag → 发 Release」，无需本地手工打包。

| 工作流 | 触发 | 作用 |
|---|---|---|
| `test.yml` | push / PR | 跑冒烟测试 + 六平台构建，不发布 |
| `auto-release.yml` | push `main` | 自动 bump 版本、构建、打 tag、发布 Release（主路径） |
| `release.yml` | push `v*` tag | 校验 tag 与 `package.json` 版本一致后发布（手动备份路径） |

`auto-release.yml` 先构建校验、全部通过后才 push commit+tag，因此构建失败不会污染远程，已发布的 tag 必然对应一份构建成功的产物。发布后自动清理旧 Release，只保留最新一版（不删 git tag）。

**不含任何明文密钥**：发布使用 GitHub 自动注入的 `GITHUB_TOKEN`（`permissions: contents: write`），无需配置 Secret；仓库不提交 `dist/`、`node_modules/` 等产物；`npm test` 内置明文密钥守护检查。

手动指定版本号发布：改 `package.json` 的 `version` 并推送，再打同名 tag：

```bash
git tag v0.2.0 && git push origin v0.2.0   # 触发 release.yml
```

## 结构

```
launcher/
  main.go            入口：解包内嵌文件 + 定位 node + 透传参数执行
  run_unix.go        !windows：syscall.Exec 原地替换进程
  run_windows.go     windows：spawn 子进程 + 转发三流 + UTF-8/VT 控制台
  go.mod             module github.com/jonntd/zcode-patcher/launcher
scripts/
  build-launcher.js  交叉编译脚本（入口，npm run build）
  zcode-patcher.js   零依赖补丁 CLI
  zcode-tui.js       交互式菜单 / 非交互命令
  zcode-tps.js / zcode-enhance.js / zcode-continue.js / modelhub_payload.json
                     注入用 sidecar（与主脚本同目录解包）
  zcode-patch.cmd    Windows 快捷批处理
  legacy/            退役的 Python 实现，仅供回退参考
tests/
  smoke.test.js      零依赖冒烟测试（npm test，CI 用）
.github/workflows/   test.yml / auto-release.yml / release.yml
```

## 许可

AGPL-3.0-or-later
