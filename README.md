# zcode-patcher

ZCode 客户端本地补丁工具。零依赖 Node.js 脚本 + Go 单文件启动器，一套代码交叉编译出 Windows / macOS / Linux 的原生可执行文件。

9 项补丁：思考等级透传、全消息可编辑、用量页去截断、模型菜单加宽、继续按钮、TPS 统计栏、模型拉取、增强提示词按钮、去额度骚扰横幅。全部幂等、可检查、可还原。

> **思考等级透传 × ZCode ≥3.12**：新内核已移除档位换算函数（providerOptionsByLevel 仅存 schema），补丁在 3.12+ 显示「不适用」是预期行为。原生替代：设置 → 模型设置 → 对应模型的「推理档位映射」，按档位直接 set/unset 任意配置路径（如 `reasoningEffort`、`thinking.budgetTokens`），能力等价且可视化。

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
./zcode-patch-macos-arm64 --apply-all -f      # 一键全打；ZCode 在跑时自动优雅退出，打完自动拉起
./zcode-patch-macos-arm64 -f --quota-banner   # 单个补丁也支持 -f（打前自动退出，完成后不拉起）
./zcode-patch-macos-arm64 --revert-all        # 一键全还原
```

`-f` / `--force` 是运行中守卫：`--apply-all` 或裸 `-f` 检测到 ZCode 正在运行时，不带 `-f` 会直接拒绝（避免换了 asar 但运行中的实例还握着旧代码的「假生效」）；带 `-f` 则优雅退出（osascript / CloseMainWindow / SIGTERM，绝不强杀），最多等 20 秒，退不干净就放弃。`--check` / `--status` / `--revert` 等只读或还原参数不加守卫，与 shell 版 `scripts/zcode-patch` 行为一致。

`--status` / `--json` 全程只读，不改任何补丁；任一补丁为 `partial`/`unknown` 时退出码为 2，全部正常为 0。

**关于 `unknown`（未知）**：只有当检查子进程能明确判定 已打/未打/不完整 时才显示对应状态；其余情况（如 ZCode 升级后渲染层结构变化导致锚点失配、文件被占用无法读取）标为 `unknown`，并且会紧跟一条简短原因——`--status` / `--json` / 交互菜单总览里都会显示，例如 `未知（renderer 内容锚点命中 0 个文件，版本结构可能已变，跳过）`。按 Enter 仍会尝试执行，成功后会重新检查并刷新状态。

升级兼容：渲染层锚点按 ZCode 版本分组适配（如「去额度骚扰横幅」同时内置旧版三元档位与新版提醒式横幅两代锚点组），运行时会自动选用命中的那组，老版本部署与新版本都能正确判读与还原。

`--json` 输出示例：

```json
[
  { "name": "思考等级透传", "flag": "(default)",  "state": "applied" },
  { "name": "全消息可编辑", "flag": "--edit-all", "state": "applied" },
  { "name": "模型拉取",     "flag": "--modelhub",  "state": "unknown",
    "reason": "renderer 内容锚点命中 0 个文件（期望 1），版本结构可能已变，跳过" }
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
NOTICE.md            第三方作品归属与许可声明
LICENSE              AGPL-3.0-or-later
```

## 免责声明

本项目是**非官方**的第三方工具，与 ZCode 客户端及其开发/运营方**无任何隶属、赞助或授权关系**。「ZCode」及相关名称、商标、代码版权归其权利人所有，本项目仅以指称性方式引用。

- 本项目**不包含也不分发** ZCode 客户端的任何完整程序文件；它只在用户本机对**用户自己已安装并合法持有**的软件副本做本地修改。
- 所有改动均**可逆**：脚本在修改前自动备份，`--revert` 可完整还原。
- 使用本工具修改软件可能违反该软件的**用户协议**，并可能影响官方更新与支持。是否使用、以及由此产生的任何后果，由使用者**自行判断并承担**。
- 本项目按「现状」提供，不附带任何明示或暗示的担保（见 LICENSE）。
- 建议仅用于**个人学习、研究与自用**，请勿用于商业分发。

第三方作品归属见 [NOTICE.md](NOTICE.md)。如权利人认为本项目内容不当，请通过 Issues 联系，我们会**立即配合处理或下架**相关内容。

> 以上为一般性说明，不构成法律意见；如有疑问请咨询专业人士。

## 许可

AGPL-3.0-or-later（仅适用于本项目自身编写的代码，见 [NOTICE.md](NOTICE.md)）
