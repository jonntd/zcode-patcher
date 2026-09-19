---
name: zcode-patcher
description: "[仅手动调用，禁止自动触发] ZCode 客户端本地补丁工具：①自定义模型供应商思考等级（effort/thinking/budget_tokens 真正下发到请求体）②用量页去截断（打开统计图：趋势图/饼图全量展示）③模型菜单加宽（供应商子菜单 192/160px→384px，长模型名完整显示）④继续按钮（工具栏一键填入「继续」并发送）⑤TPS 状态栏（打开状态栏：输入框工具栏统计胶囊，时间·首 token·tok/s·out）⑥模型拉取（打开模型拉取：渠道页拉取模型/自定义请求头/视觉探测/删除持久化）⑦全消息可编辑（打开编辑历史：解除只有最后一条用户消息可编辑的限制）⑧去额度广告（去额度骚扰横幅：关闭「今日免费计划额度剩余 x%，可升级」升级广告，保留耗尽/受限提示）。只有当用户明确要求执行本 skill、或明确点名「zcode-patcher」时才加载；用户只是泛泛提到思考等级、用量图、状态栏、模型拉取、编辑历史、补丁等话题时，一律不要自动触发本 skill。"
---

# ZCode 客户端补丁工具

> 实现为零依赖 Node.js 脚本 `scripts/zcode-patcher.js`（旧 Python 实现已退役，存于 `scripts/legacy/` 仅供回退参考，勿与新功能混用）。

三类补丁，均幂等、可检查、可还原、ZCode 升级后需重打：

| 能力 | 说法 | 命令 | 改哪里 |
|---|---|---|---|
| 思考等级透传 | 给自定义模型配思考等级 | `node zcode-patcher.js [--check/--revert/--extract]` | 内核 zcode.cjs（原地改写，.bak 备份） |
|   ↳ 3.12+ 注意 | 内核已移除档位换算函数，补丁显示「不适用」属预期；原生替代＝模型设置的「推理档位映射」（levels=配置补丁集） | `--check` | 同上 |
| 打开统计图 | 用量页趋势图/饼图去截断 | `node zcode-patcher.js --usage-chart [--check/--revert]` | app.asar 内渲染文件（同长度原地改字节） |
| 打开模型菜单加宽 | 供应商子菜单 192/160px→384px，长模型名完整显示 | `node zcode-patcher.js --menu-width [--check/--revert]` | app.asar 内渲染文件（同长度原地改字节） |
| 继续按钮 | 输入框工具栏一键填入「继续」并发送（✨右侧；快捷键 `Cmd/Ctrl+Shift+J`） | `node zcode-patcher.js --continue-btn [--check/--revert]` | app.asar（重打包级：index.html 挂 zcode-continue.js + 新增脚本条目） |
| 打开状态栏 | 输入框工具栏 TPS 统计胶囊 | `node zcode-patcher.js --tps-footer [--check/--revert]` | app.asar（重打包级：注入脚本 + 挂载 index.html） |
| 打开模型拉取 | 渠道页「拉取模型」/自定义请求头/视觉探测/删除持久化 | `node zcode-patcher.js --modelhub [--check/--revert]` | app.asar（重打包级：preload/main/renderer 三条目改写） |
| 打开编辑历史 | 解除只有最后一条用户消息可编辑的限制 | `node zcode-patcher.js --edit-all [--check/--revert]` | 内核 zcode.cjs（两处可逆文本替换） |
| 增强提示词 | 输入框工具栏「✨ 增强」按钮：把草稿改写为结构化提示词（快捷键 `Ctrl+/`，Mac/Windows/Linux 通用；右键面板可指定模型/模式），原文可一键撤销 | `node zcode-patcher.js --enhance-btn [--check/--revert]` | app.asar（重打包级：preload IPC×2 + main handler×2 + index.html 挂 zcode-enhance.js） |
| 去额度广告 | 关闭「今日免费计划额度剩余 x%，可升级」骚扰横幅，保留耗尽/受限提示 | `node zcode-patcher.js --quota-banner [--check/--revert]` | app.asar 内渲染文件（同长度原地改字节） |

两个及以上功能可一次执行：`node zcode-patcher.js --usage-chart --menu-width --continue-btn --tps-footer --modelhub --enhance-btn --quota-banner`。

**推荐安装**（摆脱外置卷/长路径依赖）：把 `scripts/` 下五个文件（`zcode-patcher.js`、`modelhub_payload.json`、`zcode-tps.js`、`zcode-enhance.js`、`zcode-continue.js`）复制到 `~/.zcode/patcher/`，并使用同目录一键脚本 `zcode-patch`（已 alias 进 ~/.zshrc）：

- `zcode-patch` — 打/重打全部补丁（ZCode 在运行会拒绝；`zcode-patch -f` 自动退出 ZCode，打完自动启动）
- `zcode-patch check` — 各项状态
- `zcode-patch revert` — 全部还原
- Windows：五个文件复制到 `%USERPROFILE%\.zcode\patcher\`，一键脚本用仓库内 `scripts\zcode-patch.cmd`（子命令同上：无参 / `check` / `revert` / `-f`；需 Windows 10+，Program Files 安装需管理员终端，打补丁前完全退出 ZCode）
- **运行检测（sh 版，勿改用 `pgrep -xq ZCode`）**：判据是 `ps -eo comm= | grep -qxE 'ZCode|zcode|.*/(ZCode|zcode)'`。实测 macOS + Electron 41 打包的 ZCode 3.11.x 上 `pgrep -x` **看不见** ZCode 主进程（同一时刻 `ps -eo comm=` 有 `ZCode` 行，`pgrep -x ZCode` 却返回 1），而 `lsappinfo` 只认已登记 bundle 的 App、对在跑的应用也可能返回空（实测 Finder 在跑时输出为空），都不能用来判断。判据要同时认短名与完整路径两种 `comm` 形态，并尾部锚定，才不会命中 `ZCode Helper` / `zcode-cli` / `ZCode Computer Use`。漏报的后果是：守卫误判「未运行」直接开打，asar 被原子替换但运行中的实例仍握着旧 inode（旧代码），收尾的 `open -a ZCode` 只把旧实例切到前台、不会重载 —— 用户以为生效了，实际跑的还是旧代码。

**ZCode 升级后**：官方更新会覆盖 zcode.cjs 与 app.asar、五补丁全失效，跑一次 `zcode-patch -f` 即可；思考等级/TPS 备份检测到升级覆盖会自动刷新为新版原样（还原不降级）。

五个补丁两两独立、幂等、可任意顺序打与还原（还原均为定点还原，互不踩踏；唯一例外见下方「还原顺序」）。

## 标准执行流程（AI 代执行与人工自助通用）

调用本 skill 时按以下序列执行，**AI 代执行时必须走完全部步骤，不得跳过核实与展示**：

1. **定位安装**：脚本自动探测（运行中进程 → 注册表 → 常见目录，跨 Windows/macOS/Linux，见「跨平台约定」）；探测不到就把安装根目录作为位置参数传入。
2. **只读核实**（能否生效的判断，全部只读，可放心先跑）：
   - `node zcode-patcher.js --check`：思考等级补丁状态；ZCode 版本不在「已知符号表」时跑 `--extract`——能提取出锚点即可生效，提取失败说明内核结构变了，按「新版本锚点提取」人工分析后再动。
   - `node zcode-patcher.js --usage-chart --check`：两个截断表达式是否命中。
   - `node zcode-patcher.js --tps-footer --check`：index.html 是否找到、注入状态。
   - 脚本对「表达式出现次数 ≠1」「锚点不唯一」等情况一律拒绝盲改并报告原因——报告即结论，不要绕过。
3. **确认备份就绪并展示还原命令**（打补丁前必须完成，AI 代执行时明确提示用户保存还原命令）：
   - 思考等级：首次打补丁自动生成 `zcode.cjs.bak`（整文件备份）
   - 状态栏：首次注入自动生成 `app.asar.tps.bak`（整包备份）+ `app.asar.tps-patch.json`（原始 index.html 记录）
   - 统计图：sidecar `app.asar.chart-patch.json` 记录全部原始字节
4. **展示执行命令与还原命令**——**单功能单命令，按用户点名的功能给对应命令，不要捆绑其他功能**（各补丁相互独立；低风险的思考等级/统计图 AI 可在核实与备份确认后直接代执行，重打包级的状态栏交由用户执行）。以「打开状态栏」为例：
   ```bash
   # 执行
   node "<skill目录>/scripts/zcode-patcher.js" --tps-footer
   # 还原（万一异常，保存备用；完全退出 ZCode 后执行，还原后重启 ZCode）
   node "<skill目录>/scripts/zcode-patcher.js" --tps-footer --revert
   ```
   人工自助时用户自行执行；AI 代执行时经用户确认后由 AI 运行，或用户复制命令自己跑。
5. **重启验证**：完全退出并重启 ZCode（Windows 运行中锁 app.asar，打补丁前必须退出）后，按各功能的「验证」说明确认。
6. **失败回退**：执行上面展示的还原命令 → 重启 ZCode → 重新核实。思考等级补丁还原走 zcode.cjs.bak；状态栏还原自动清理 `.tps.bak` 与 sidecar。

## 还原顺序（唯一注意点）

- app.asar 三补丁（统计图/状态栏/模型拉取）与内核 edit-all 的还原都是**定点还原**：只恢复本补丁改过的字节/条目，任意顺序、任意组合互不影响。
- 内核思考等级补丁的还原是**整文件恢复 zcode.cjs.bak**：若 .bak 拍摄于 edit-all 打上之前，还原思考等级会连带抹掉 edit-all（`--edit-all --check` 可发现，重打即可）。约定**先 `--edit-all --revert` 再还原思考等级**，或打补丁时先 edit-all 后思考等级（此时 .bak 已含 edit-all，顺序无所谓）。
- 上游独立版 zcode-modelhub-patch（`一键安装补丁.cmd`，整包备份 app.asar.modelhub-backup）与本融合版不可混用：装过 .cmd 版的先跑上游「还原补丁.cmd」，再用本工具管理。

## 跨平台约定

| 系统 | 安装根目录（resources 的上一级） | 典型位置 |
|---|---|---|
| Windows | `D:\ZCode`、`%LOCALAPPDATA%\Programs\ZCode` 之类 | 探测顺序：运行中进程路径 → 注册表卸载信息 → Program Files 系目录 |
| macOS | `/Applications/ZCode.app/Contents` | 探测 /Applications 与 ~/Applications 下的 `.app` 包（自动进入 `Contents`） |
| Linux | `/opt/ZCode`、`/usr/share/ZCode` 之类 | 探测 /opt、/usr/share |

- 关键文件相对安装根目录固定：`resources/glm/zcode.cjs`（内核）、`resources/app.asar`（桌面端资源包）
- Node.js（任意 LTS 版本）即可运行；`zcode-patcher.js` 零第三方依赖（asar 解析/重打包内置实现，modelhub 载荷经 `require` 加载 modelhub_payload.json）
- Windows 探测依赖系统内置 PowerShell：运行中进程路径 + HKLM（64/32 位视图）与 HKCU 卸载键，子进程输出强制 UTF-8（中文用户名/路径不乱码）；补丁落盘遇杀软/索引服务短暂占用（EBUSY）会自动退避重试
- Program Files / /Applications 类目录可能需要管理员/sudo 权限
- 执行 AI 可按上述规则自行定位安装（如 `ls /Applications`、查运行中进程的 exe 路径）

## 升级后自查清单

ZCode 升级会覆盖 zcode.cjs 与 app.asar，升级后过一遍：

```bash
node zcode-patcher.js --check            # 思考等级补丁状态
node zcode-patcher.js --usage-chart --check
node zcode-patcher.js --menu-width --check
node zcode-patcher.js --continue-btn --check
node zcode-patcher.js --tps-footer --check
node zcode-patcher.js --modelhub --check
node zcode-patcher.js --enhance-btn --check
node zcode-patcher.js --quota-banner --check
node zcode-patcher.js --edit-all --check
```

失配的按「自助使用流程」重打；思考等级补丁在新内核上先 `--extract` 确认锚点可提取。

## 一、思考等级：完整结论一张表

> 从零接入一个自定义模型（建渠道、写模型条目、两条集成路径）见「七、自定义模型接入指南」；本节只解决已接入模型的思考档位透传。

| 场景 | 档位来源 | 是否需要 config 配置 | 是否需要内核补丁 |
|---|---|---|---|
| 模型 id 含 "ox-alpha"，ZCode ≥ 3.9.1 | 内核硬编码白名单（`isOxAlphaReasoningModelId`），天生 low/high/max，defaultLevel=max | **不需要**（配了也是冗余） | **不需要** |
| 其它模型，ZCode ≥ 3.9.1，标准档名（low/medium/high/xhigh/max） | 引擎原生通用表：anthropic → `thinking:{type:"adaptive"}` + `output_config.effort` | **需要**：模型条目配 `reasoning.variants` | **不需要** |
| 其它模型，自定义档名（如 "turbo"） | 无原生表，留空 | 需要 | **需要**：补丁兜底合成 |
| ZCode ≤ 3.8.1，任何模型任何档位 | 无原生表 | 需要 | **需要** |

判别某次请求走的哪条路：`thinking:{type:"adaptive"} + output_config.effort` = 原生路径；`thinking:{type:"enabled", budget_tokens:N}` = 补丁兜底。补丁在原生表非空时惰性（`??` 短路），留着无害但升级后要重打才有意义。

### 档位从配置到请求的完整链路（补丁原理）

```
~/.zcode/v2/config.json  模型条目 reasoning.variants      ← 档位名数组（UI 显示的就是它）
      │  桌面端 host：variants → 内部 levels（每档参数对象）
      │  内核 override 构建器 → catalogOverrides 注入模型目录
      ▼
capability.reasoning = { enabled, levels, providerOptionsByLevel }
      │  内核档位解析函数 sD(3.8.1)/AD(3.9.1)/mN(3.11.2)(modelRef, 选中档名, catalog)
      ▼
{ level, providerOptions: providerOptionsByLevel[档名] }   ← 断点：自定义模型此表为空
      │  合并进请求
      ▼
anthropic: thinking:{type:"enabled",budget_tokens:N} + effort
openai 系: reasoning_effort:"档名"
```

`providerOptionsByLevel`（档名→请求参数表）只给内核认识的白名单家族（claude/glm/deepseek 等）下发；自定义模型拿到空表，档位能选中却不产生任何请求参数。补丁 = 在取参处加 `?? zCfgEffort(档名)` 兜底，按档名现场合成参数；白名单模型表非空，`??` 短路，行为零变化。

### ox-alpha 白名单的代码依据（3.9.1+ 原生支持）

- **(a) 硬编码白名单**：内核 override 构建函数 `t2t` 首分支 `t.reasoningProfile===Iue || j5(t.modelId)` → anthropic 协议拿 `jye()` = `{defaultLevel:"max", levels:["low","high","max"], providerOptionsByLevel:每档{effort, thinking:{type:"adaptive"}}}`。其中 `Iue=iLe([111,120,45,97,108,112,104,97])="ox-alpha"`，`j5` 注册名 `isOxAlphaReasoningModelId`（正则 `/ox-alpha/i` 子串匹配 + 两个内部预览模型）。与端点协议无关，同端点其它模型无此待遇。
- **(b) 标准档名通用表**：非白名单模型配了 `reasoning.variants` 且档名为标准名，构建时也套通用表（anthropic → adaptive+effort）。config 里配的档位集合即 UI 显示的集合。

### 工作流

1. **配档位**（每模型一次，完全退出 ZCode 后改 `~/.zcode/v2/config.json`）：
   ```json
   "reasoning": {"enabled": true, "variants": ["low", "high", "max"], "defaultVariant": "max"}
   ```
   **必须同时给该模型条目补 `"zcode": {"modified": true}`**——没有该标记的条目会被客户端目录同步重写，`reasoning` 配置丢失（表现为档位退回"开启/关闭"开关，实测 deepseek-flash 踩坑）。
2. **仅当需要补丁时**（见判断表）：`--check` → 打补丁 → 完全退出并重启 ZCode。新版本无已知锚点先 `--extract`。
3. **验证**：rollout（`~/.zcode/cli/rollout/model-io-*.jsonl`）请求体里 `thinking`/`effort` 随档位变化；引擎日志（`~/.zcode/cli/log/`）无 400。**注意 rollout 请求体是脱敏的，`thinking` 字段会被剥掉（内置模型也一样），不能作为判据**——以 OpenRouter Dashboard → Activity Log 之类的外部请求日志为准。

### 内核补丁点与版本匹配

断点只有一处——内核 `resources/glm/zcode.cjs` 里的**思考档位解析函数**（见上方链路图）。zcode.cjs 是 esbuild 压缩产物，**每个版本的顶层符号名整体重排**，锚点（解析函数完整原文）必须与已安装版本逐字符一致：

| 版本 | 已知符号 |
|---|---|
| 3.8.1 | sD / G_e / Fgo / gXe |
| 3.9.1 | AD / Zye / fxo / utt |
| 3.9.2 | RD / Xye / Sxo / ptt |
| 3.11.2 | mN / k2e / CIo / _nt（本版返回处局部变量名为 s，替换逻辑已通用化） |

脚本按「全文唯一匹配」自动选择版本：对每个已知锚点统计出现次数，**恰好有一版 =1 才动手**；全为 0 或多版命中都拒绝修改。锚点匹配失败 ≠ 补丁思路失效——要改的内核点（解析函数返回处 `providerOptionsByLevel?.[X]` 查表表达式）所有版本语义不变，变的只是符号名。

**新版本锚点提取**：首选 `--extract` 自动提取——按结构特征（函数以 `{level:...providerOptionsByLevel?.[...]}:void 0}` 收尾、体内无嵌套 function）定位，已打补丁的文件自动回退 .bak 原始件，打印可直接粘贴进脚本 `ANCHORS` 字典的锚点（打印格式即条目格式，加个版本号键即可）。`--extract` 失败（候选数 ≠1）时人工提取：在内核里搜 `providerOptionsByLevel?.[`，找到以 `:void 0}` 收尾的完整解析函数整段复制为锚点；若函数体结构有变（不止符号改名），同步调整 `replacement_for()` 的拼接假设。加锚点后用 `--check` 验证恰好唯一命中再打。

### 档名与预算映射（补丁内置）

| 档名 | anthropic budget_tokens | openai 系 reasoning_effort |
|---|---|---|
| low | 4000 | low |
| medium | 8000 | medium |
| high | 16000 | high |
| xhigh | 32000 | xhigh |
| max | 32000 | xhigh（openai 侧折算） |
| 其它任意名 | 16000 兜底 | 不带 |
| disabled / none / off / nothink | thinking disabled | thinking disabled |

改数值或加档名：编辑脚本 `HELPER` 里的映射行 `{low:4e3,medium:8e3,high:16e3,xhigh:32e3,max:32e3}[t]??16e3`，重打补丁。

**输出上限约束**：anthropic 协议要求 `budget_tokens < max_tokens`，等值会被内核钳到 max-1。模型条目不写 `limit.output` 时请求不带 max_tokens，由网关兜默认值；若写了 `limit.output`，必须大于所选档位预算（如 output 32000 配 max 档 32000 会直接 400）。

### deepseek 家族实测记录（3.11.2）

- 内核 override 构建器（`gwt`）分支顺序：ox-alpha 白名单 → glm-5.3 → kimi-k3 → **config.reasoning（自定义档位在此生效）** → 家族兜底
- 无自定义配置时 deepseek 走兜底 `CA()`：只有 enabled/disabled 两档开关、预算固定 1024
- 配了 variants + 内核补丁后：deepseek-flash 实测 max 档下发 `budget_tokens:32000 + effort:"max"`（补丁兜底路径，与内置 1024 明显区分）

### 故障排查

| 现象 | 原因与处理 |
|---|---|
| 档位能选但请求无 thinking | 内核补丁没打或打完没重启；`--check` 确认（3.9.1+ 标准档名走原生，无补丁也应生效） |
| 400: budget_tokens 必须小于 max_tokens | 所选档位预算 ≥ `limit.output`；调大上限或不设上限 |
| 400: max_tokens 缺失 | 不设 output 上限且网关不兜默认时出现；给模型设较大的 `limit.output` |
| 升级后失效 | 内核/app.asar 被覆盖；重跑补丁（无已知锚点先 `--extract`） |
| 档位选不到某名字 | `variants` 里没写，或 `defaultVariant` 不在列表内 |

## 二、打开统计图：用量页去截断

「设置 → 用量」两处展示截断，本补丁一并放开：

| 位置 | 原始行为 | 补丁点 |
|---|---|---|
| 每日 Token 趋势图 | 只画 Top 6 模型折线（`n.models.slice(0,6)`；每日 total 含全部模型） | 改为 `n.models` 全量出线 |
| 模型用量饼图 | 模型 >6 个时只画 Top 5，其余合并为「其他模型」（`i=n.length>Q,a=i?Q-1:Q`，Q=6） | 改为 `i=!1,a=1/0` 全量出块、无合并 |

```bash
node zcode-patcher.js --usage-chart            # 打补丁（asar 内同长度字节级原地覆盖）
node zcode-patcher.js --usage-chart --check    # 查状态
node zcode-patcher.js --usage-chart --revert   # 从 sidecar 还原全部原始字节
```

- 原理：解析 asar 头定位渲染文件偏移，替换截断表达式后用空格补齐到原字节长度原地写回——asar 头、offset、unpacked 结构零改动，无需重打包
- 原始字节 base64 存同目录 `app.asar.chart-patch.json`（sidecar，含全部补丁点记录）
- **sidecar 带 asar 尺寸指纹**：每条记录绑定当时的 app.asar 总大小，ZCode 升级覆盖 asar 后旧 offset 不可信，指纹失配的记录自动作废重建（实测 3.9.1→3.9.2 升级后重打正常；TPS 重打包后脚本自动同步本 sidecar 的 offset/指纹）
- 两处调色盘均 6 色循环取色，第 7+ 个模型颜色重复，靠图例/标签区分
- 定位按文件名特征 + 截断表达式匹配，与文件名哈希无关，跨版本稳定（3.9.1→3.9.2 文件名哈希变化仍能命中）

## 二点五、模型菜单加宽（--menu-width）

模型选择器（输入框工具栏）的供应商子菜单两档固定宽度导致长模型名省略号截断，本补丁等长字节替换放宽到 w-96（384px）：

| 补丁点 | 原始 → 替换 | 覆盖场景 |
|---|---|---|
| ① 子菜单默认宽 | ``j??`w-48` `` → ``j??`w-96` `` | 内置渠道选中态及所有未传 providerSubmenuClassName 的调用点（192px→384px） |
| ② composer 窄分支 | `` `w-40 min-w-0 max-w-(--radix-dropdown-menu-content-available-width)` `` → `` `w-96 …` `` | composer 选中自定义渠道时的动态窄分支（160px→384px，保留视口可用宽钳制） |

```bash
node zcode-patcher.js --menu-width            # 打补丁（同长度字节级原地覆盖）
node zcode-patcher.js --menu-width --check    # 查状态
node zcode-patcher.js --menu-width --revert   # 定点还原（内容寻址，抗重打包）
```

- 原理：`w-48`/`w-40` 与 `w-96` 同为 4 字节，替换后文件总长不变，asar 头/offset/integrity 零改动；编译 CSS 为 Tailwind v4 动态 spacing，`w-96` 样式必然存在
- 布局安全：条目行为 flex 布局（名称 min-w-0 flex-1 + 徽标 + 勾号），变宽只给名称更多空间；`truncate` 保留兜底（极端长名悬停有 title 提示）；`max-h-72` 滚动、sticky 页脚、Radix 碰撞规避均不受影响
- 定位：渲染层 `out/renderer/assets/*.js` 按双锚点内容扫描（文件名哈希随版本变，不硬编码），两锚点须落在同一文件且各恰好 1 处，否则拒绝盲改
- sidecar `app.asar.menuwidth-patch.json` 仅记状态与 asar 尺寸指纹；还原按内容寻址反向替换，与统计图/TPS/modelhub 重打包互不踩踏

## 二点六、继续按钮（--continue-btn）

输入框工具栏「✨增强」右侧新增「继续」按钮：单击把「继续」填入 composer（已有草稿则空格追加，不丢原文）并立即发送。快捷键 **`Cmd/Ctrl+Shift+J`**（Continue 的 J，与增强键 `Ctrl+/` 相邻好记），仅输入框聚焦时生效。

```bash
node zcode-patcher.js --continue-btn            # 注入（重打包级：index.html 挂载 + 新增脚本条目）
node zcode-patcher.js --continue-btn --check    # 查状态
node zcode-patcher.js --continue-btn --revert   # 定点还原（strip 自身 tag + 删脚本条目）
node zcode-patcher.js --continue-btn --cont-src /path/to/zcode-continue.js   # 指定注入源
```

- **提交通路**：composer 是 `<form>`，原生发送按钮即 `type=submit`（`data-testid=chat-send-button`）；脚本优先 `btn.click()` 走与用户点击「↑」完全相同的路径——生成中排队、权限锁定等状态语义全部交给应用自身判断，不绕过任何禁用守卫；按钮 disabled 时中止并提示（已填入的「继续」保留在输入框）。
- **发送确认**：提交后轮询草稿清空才算成功；未清空降级合成 Enter 兜底一次，再失败 toast 提示手动发送——绝不重复发送。
- **写入（v6，与增强按钮同一套模型层通路）**：`__lexicalEditor` 句柄 + `parseEditorState/setEditorState` 整体替换；仅无句柄时回退 DOM 通路（先 `deleteByCut` 确认清空、再逐行填）。旧实现用 `execCommand(selectAll + insertText)` 一次同步写入，在 Lexical 下有三重失败：①全选只覆盖最后一段，多段草稿写不进去；②`execCommand` 之间需要让出事件循环 Lexical 才同步内部选区，同步连发必然被丢弃（实测：`focus→selectAll→insertText` 零等待必失败，每步 `await` 50ms 才成功）；③多段文本里的换行会被吞掉。内容未确认写入成功绝不触发提交。
- **快捷键**：`Cmd/Ctrl+Shift+J`，document 捕获阶段拦截并 `preventDefault`；只在 composer 聚焦（`activeElement` 是 composer 或其子节点）时生效，组字中（`isComposing`）、按键重复、带 Alt、以及无 Shift/无修饰键的变体全部放行给应用。
- **挂载位置**：✨增强按钮右侧（红框位）；✨ 不存在时挂「完全访问」容器末尾。与 TPS 胶囊共存：enhance 脚本对胶囊的邻接强制已放宽为「在胶囊之前即可」（需重跑 `--enhance-btn` 升级注入），三个注入脚本互不搬移。
- **幂等/升级**：已打 = tag + 条目 + 条目与注入源逐字节一致；`zcode-continue.js` 更新后重跑即原地升级。还原精确 strip 自身 tag；脚本条目仅在与注入记录一致时删除。sidecar `app.asar.continue-patch.json` 记录脚本指纹，重打包后随 `refreshSidecarsAfterRepack` 自动刷新。

## 三、打开状态栏：TPS 统计胶囊

输入框工具栏常驻一枚统计胶囊（水平居中于工具栏行，宽度上限 50%），展示**当前会话最近一轮**的生成指标：

```
生成中:  ● 21:03 · 32 tok/s · out 410
结束后:  ● 21:03 · 首 token 37s · out 1.7k
```

```bash
node zcode-patcher.js --tps-footer             # 注入（默认用本 skill scripts/zcode-tps.js）
node zcode-patcher.js --tps-footer --check     # 查状态
node zcode-patcher.js --tps-footer --revert    # 整体还原
node zcode-patcher.js --tps-footer --tps-src /path/to/zcode-tps.js   # 指定注入源
```

### 行为规则（验收标准）

- **绿点 ● 与时间常驻**：有可展示的轮次就在；流式生成中绿点发亮，空闲静态。无省略号占位。
- **分隔符 `·`** 隔开各段；标签灰、数值白、tok/s 橙、tabular-nums 对齐。
- **同一 turnId 复用（编辑重发/重试）自动清零**：检测到新一轮开始即重置旧统计，杜绝「时间变新、指标是旧的」残留。
- **out 语义**：**本轮累计输出**（最近一次提问→回答完成为止），非会话累计。
- **动态刷新**：流式中 1 秒节奏刷新——tok/s 为 4s 滑动窗口即时速度、out 为本轮估算值；基于回答文本的 token 估算（CJK 1 字≈1 token、其余 4 字符≈1 token）。`usage.delta` 精确值随每次模型请求完成到达即覆盖估算；轮结束后为精确值（精确 out ÷ 首块→末次 usage 的解码窗口）。
- **静默期保持**：工具执行期间文本停止增长，速度保持最近值不消失；点停止/出错时该次请求不报 usage，out 以内容估算兜底、速度保持最近值——已产生的数据不凭空消失。
- **切换会话立即消失**：渲染只认「DOM 可见轮次（`section[data-turn-id]`）+ `data-session-id` 匹配当前会话」双重条件，不依赖任何会话切换事件；多会话并行时各 tab 互不干扰。
- **历史会话只有 `● 时间`**：usage.delta 不回放，重新打开旧会话拿不到当时的 token 统计，属预期。
- **无假时钟**：轮次连时间戳都没有且无生成活动时不渲染，绝不拿当前时间冒充轮次时间。

### 数据链路原理（无常驻服务）

1. ZCode 桌面端 preload 把主进程的 MessagePort 经 `window.postMessage` 转交渲染页面；注入脚本监听该事件接管端口（`window.__ztpsHook` 可对存量端口手动补挂，`window.__ztpsPort` 暴露端口供调试旁路监听）。消息形态两代都要认：旧 preload 为裸字符串 `"zcode:service-port"`；新 preload（u3+）为对象 `{ type: "zcode:service-port", databaseStartupId }`（主会话端口）与 `{ type: "zcode:scoped-service-port", attachmentId, sessionId, target }`（远程 workspace 端口）。只认旧形态时主会话端口会静默漏接——turns 恒空，统计栏永不出现。
2. 会话协议帧为二进制（Uint8Array）内嵌 JSON（自首个 `{` 起），两类：
   - **version:1 事件流**（顶层带 sessionId/sourceCommandId/occurredAt）：`usage.delta`（inputTokens/outputTokens/cacheReadTokens/totalTokens/reasoningTokens，**每次模型请求完成时发**——一轮含工具调用会有多条，out 为该次请求输出）、`stream.chunk`（`assistantMessageId` + `chunkLength` + `channel`，流式期间每 50-100ms 一批）
   - **conversation 行事件**（`frame.payload.deltas`/`events`）：`turnHeader`（startedAt/endedAt/state）、`userInput`（createdAt）、`reasoning`/`assistantText`（`text` 全量 + `assistantResponseId`）、`row.delta`（`{rowId, path:"text", append:"文本增量"}`）
3. **轮关联链**（事件里的 id 有两套，务必分清）：轮的 key 是 productTurnId（`msg_xxx`，与 DOM `section[data-turn-id]` 一致）；stream.chunk 的 `assistantMessageId` 是 assistantResponseId（另一个 msg_xxx），需经行事件的 `assistantResponseId → turnId` 映射中转；usage.delta 经 `sourceCommandId` 关联（turnHeader/userInput 行携带）。关联断了的表现：out/tok/s 一直不出现。
4. 渲染：扫描 `section[data-turn-id]` + sessionId 双条件取当前会话最新轮 → 算指标 → 更新胶囊。
5. 刷新机制：MutationObserver 回调里 16ms 节流的**同步**刷新（切换会话零残留）＋ 60ms 防抖全量扫 ＋ 1s 估算刷新节奏；渲染带内容签名（stamp/ttft/tps/out/streaming），数据未变零 DOM 写，保证同步刷新不触发 observer 自激。

### 注入原理（asar 重打包级）

与统计图补丁的同长度原地覆盖不同，状态栏要**新增文件**，必须整体重打包：

1. 注入内容：`out/renderer/index.html` 的 `</body>` 前插 `<script src="./zcode-tps.js"></script>`；zcode-tps.js 作为新条目写入 `out/renderer/`。index.html 无 CSP meta、无 nonce，普通脚本标签即可（在 `type="module"` 的 React bundle 之前同步执行，注册监听早于应用挂载）。
2. asar 布局（读/写同一公式）：头 16 字节 = 4 个 uint32 LE `[4, headerSize, pickleLen, jsonLen]`，`pickleLen = 4 + jsonLen + pad4`，`headerSize = 8 + jsonLen + pad4`，数据区起点 = `16 + jsonLen + pad4`（pad4 把 JSON 补齐到 4 字节倍数）；文件条目 `offset` 为相对数据区起点的字符串，全部文件带 integrity（SHA256 全文 + 4MB 分块 hex）。
3. 重打包流程：读全量 → 树上删条目/插占位/标记覆盖 → 全部条目 offset 重排 → 覆盖与新增条目重算 integrity → 写临时文件 → **回读校验**（逐条比对注入条目字节）→ 原子替换。
4. **实现关键坑**（改 `_repack_asar` 前必读）：offset 重排会直接改写条目，此后从旧文件切片必须用**重排前快照的旧位置**，否则「新 offset + 旧数据区起点」错位读取（实测 50 个抽查文件错 11 个，且改动文件恰好走覆盖分支不受影响，极易漏测）；新增条目的树插入必须在重打包函数内部做（外层持有的树引用与函数内部重新读入的不是同一棵）。
5. 备份与记录：首次注入前整包备份 `app.asar.tps.bak`；`app.asar.tps-patch.json` 记录原始 index.html（base64）与 asar 尺寸指纹。
6. 与统计图补丁联动：重打包使 chart sidecar 的绝对 offset/指纹失效，脚本自动按「文件路径 + 尺寸」重定位同步；反向无影响（统计图是同长度覆盖，不改 offset）。

### 升级 / 回退 / 排障

| 现象 | 处理 |
|---|---|
| 升级后胶囊消失 | app.asar 被覆盖，重跑 `--tps-footer`（注入源默认 skill 自带 zcode-tps.js） |
| 重启后无胶囊 | `--tps-footer --check` 看 state；渲染进程 console 查 `window.__ztps` 是否存在 |
| console 出现 CSP 拦截报错 | 当前版本 index.html 无 CSP；若未来版本加了，需同步放宽 `script-src` 允许同目录脚本 |
| 指标一直只有「● 时间」 | usage.delta 未关联到轮（看 `window.__ztpsTurns` 里轮的 out/lastUsageAt 是否为空）；版本升级导致帧结构变化时，用 `window.__ztpsPort` 旁路监听原始帧比对字段 |
| tok/s 不出现 | 该轮从未有过文本流（纯工具调用轮）时无速度可算，属预期；有文本流后静默期（工具执行）保持最近值 |
| 想换脚本逻辑 | 改 zcode-tps.js 后 `--tps-footer --revert && --tps-footer` 重打（幂等） |

## 四、模型拉取：渠道页增强（modelhub，融合自 zcode-modelhub-patch v1.2.1, MIT）

给「设置 → 模型供应商」的添加/编辑渠道页注入第三方模型管理能力：

| 功能 | 说明 |
|---|---|
| 拉取模型按钮 | 一键拉取任意 OpenAI 兼容端点的全量模型列表，ZCode 风格选择面板（搜索/全选/逐个勾选），确认后模型列表 = 勾选集合（手动添加的保留） |
| 方言感知回退 | anthropic 渠道 `/v1/models` 优先、openai 系 `/models` 优先、gemini 走 `v1beta`，带不带 `/v1` 都能拉 |
| 按方言认证 | anthropic 附 `x-api-key`+`Authorization` 双头、gemini 走 `x-goog-api-key` |
| 自定义请求头 | Claude (`claude-cli`) / Codex (`codex_cli_rs`) 全套预设头，逐条勾选生效/移除、值可编辑、`session_id` 一键换新；粘性生效（改模型配置不再剥头） |
| 视觉能力实测 | 对勾选模型发 1×1 测试图，OpenAI/Anthropic 双协议适配，真实响应判定 |
| 删除持久化 | 删除的模型写入 `zcode.deletedModels`，不再被目录同步复活 |

```bash
node zcode-patcher.js --modelhub            # 注入（app.asar 重打包级）
node zcode-patcher.js --modelhub --check    # 查状态
node zcode-patcher.js --modelhub --revert   # 定点还原
```

### 与上游实现的差异（本融合版改进点）

- **renderer 文件按内容锚点定位**：上游硬编码带哈希的文件名（如 `styles-DyAcaLKy.js`），构建哈希一变即失效；本版优先固定名、失配时按「添加按钮」内容锚点全量扫描回退（期望唯一命中）。
- **定点还原**：上游整包备份/整包还原（会连带抹掉其它补丁）；本版 sidecar `app.asar.modelhub-patch.json` 只记录 preload/main/renderer 三个条目的原始字节（base64 + asar 尺寸指纹），还原时按路径定点写回，统计图/状态栏补丁不受影响。
- **integrity 完整**：上游重打包会删掉改动条目的 integrity；本版复用 `_repack_asar` 重算全部改动条目 integrity，重打包后自动同步 chart/tps sidecar。
- 载荷字符串逐字取自上游（`scripts/modelhub_payload.json`，含出处注释）；上游的 Windows `.cmd` 入口/强杀进程/注册表探测不再使用——统一走本脚本的跨平台探测，ZCode 需手动完全退出。
- 上游锚点与 ZCode 版本强耦合（符号名随构建变化），失配时明确报错放弃、不会损坏文件；等上游仓库更新载荷后替换 `modelhub_payload.json` 即可。

## 五、全消息可编辑（--edit-all，融合自上游 engine 补丁）

解除「只有最后一条用户消息能编辑」的限制，历史任意用户消息均可编辑重发。

- 补丁点：内核 `zcode.cjs` 两处——P1 投影层放行所有存在编辑目标的 `userInput` 行（`canEdit` + `editDisposition:"rewind"`），P2 解析器去掉「必须是当前可编辑实体」的限制。
- 命令：`node zcode-patcher.js --edit-all [--check/--revert]`。
- 幂等：已打自动跳过；锚点出现次数 ≠1 明确报错拒绝盲改。
- **语法自检**：装有 Node.js 时打补丁前先 `node --check` 校验补丁后文件，失败则零改动放弃（未装 node 时跳过自检直接写入，可用 `--check` 复核）。
- **还原 = 反向文本替换**（不是整文件恢复），与思考等级补丁互不干扰；与思考等级补丁共存及还原顺序见「还原顺序」一节。

## 六、增强提示词（--enhance-btn）

输入框工具栏「✨ 增强」按钮：把当前草稿改写为清晰、结构化的提示词（模型来源优先级：右键面板指定 > enhance-config.json 手动配置 > 渠道评分链，见下方 v5 条目）。ZCode 官方已预留 `chat.promptEnhance.*` 文案但无实现，本补丁补齐该能力。

- **提示词模板**：移植自 WB Enhance Prompt 1.5.5（社区分享，模板原文保留）——模式经**右键面板**切换（localStorage 持久化）：**简洁模式**（WorkBuddy 原版，约 800 字符内，含分析流程与正反示例）、**创意模式**（充分展开不设字数，含意图范围/证据缺失上下文/精确内容保护/最终自检），两者都追加 OUTPUT LAYOUT 分段规则；语言严格跟随草稿，实际请求 max_tokens 简洁 4096 / 创意 16384（模板原文的 2048/4096 不采用）。模板对象在注入时以 JSON 字面量替换 main 块的 `__WB_TEMPLATES__` 占位（apply/revert 用同一最终串）。
- **手动配置兜底**：`~/.zcode/enhance-config.json` 存在且含 baseURL+apiKey+model 时优先于评分链使用：`{"baseURL":"https://…/v1","apiKey":"sk-…","model":"模型id","kind":"openai或anthropic"}`（可选 headers 对象）。适合自动链路全部不可用时指定任意健康端点。
- **渠道与模型选择（v4）**：候选渠道**先整体排除 `builtin:` 官方渠道**（官方 plan 渠道网关校验必 400，见下条），再按评分排序（selected +10、自带 apiKey +2、baseURL +1）；渠道凭据 = `options.apiKey` → `~/.zcode/v2/credentials.json` 的 OAuth token 兜底，无凭据直接跳过；渠道内模型按 `zcode.priority` 降序最多试 3 个（503 model_not_found 换下一模型），401/403 跳渠道、400+captcha/sign 特征识别为网关校验直接跳渠道；端点拼接防 `/v1/v1`；渠道 `options.headers` 自定义请求头透传。max_tokens：简洁 4096 / 创意 16384。
- **渠道回退原因**：官方 plan 渠道（`zcode.z.ai`）有请求签名 + PoW + 阿里云 captcha 三层网关校验（内核 `X-Client-Sig`/`X-Client-Pow` 体系），纯直连必被 `HTTP 400 code:3007` 拦截且无法复刻——因此增强链路对 `builtin:` 官方渠道做**三层屏蔽**：自动评分链整体排除、面板不列出、面板指定路径（含 localStorage 旧残留）同样拒绝；增强流量只会落到手配的自定义渠道。
- **模型/模式选择面板（v5，右键 ✨）**：面板实时列出 config.json 全部启用的自定义渠道（`builtin:` 官方渠道不列出；评分排序，标注协议/★当前渠道/无凭据）与渠道内全部模型（按 `zcode.priority` 降序，P 值标注），顶部切简洁/创意模式，另有「自动」档清除指定；enhance-config.json 手动条目以提示行展示。点击模型即指定并持久化（localStorage `zcode-enhance-model`），选择优先级：**面板指定 > enhance-config.json 手动配置 > 渠道评分链**；指定的渠道/模型在 config 中失效（被删/禁用/属 `builtin:` 官方渠道）时自动回退评分链——主进程拒绝指定、面板打开时顺手清掉失效指定并 toast 提示，toast 以实际使用的 model 为准。面板数据经新增 IPC `zcode-enhance:list-models` 实时读盘（改 config 即点即生效，无需重启）。preload 升级为四参转发 `(text, mode, channel, model)`——旧版单参 preload 会丢弃后三个参数；渲染端以 `enhanceListModels` 是否暴露判新版（contextBridge 包装的函数 `.length` 恒为 0，早期 `.length` 检测必误报「旧版」，勿再使用），判旧时在面板与 toast 中提示重打。
- **引擎**：主进程实现 `zcode-enhance:run`（改写）与 `zcode-enhance:list-models`（面板数据）两个 IPC handler，均实时读盘：读 `~/.zcode/v2/config.json` + `setting.json`（`modelProviderFamilySelectedKeys` 解析当前渠道，兼容 `family:builtin:xxx` 多段前缀）与 `enhance-config.json`；anthropic 协议走 `{baseURL}/v1/messages`，openai 系走 `/v1/chat/completions`；max_tokens 简洁 4096 / 创意 16384，45s 超时，429 重试一次。
- **交互**：空草稿 toast 提示；单击增强（按钮转「增强中…」）、或按快捷键 **`Ctrl+/`**（仅输入框聚焦时生效），**右键**打开模型/模式选择面板；结果**替换输入框内容**，原文进撤销栈，toast「点击撤销」8 秒内可还原；失败 toast 错误详情。
- **快捷键（v6）**：`Ctrl+/`——**Mac 与 Windows/Linux 都用 Ctrl**，没有平台分支（未采用 `Cmd+/`：应用已把 `Cmd` 系留给自身，且 Mac 上再多一把同义键反而增加冲突面）。判定只看 `ev.key === "/"` + `ctrlKey`，**不看 `code`/`keyCode`**，因为 `ev.key` 是「按当前布局实际打出的字符」：德语区 / 法语 AZERTY 等布局上 `/` 本身要 Shift 才打得出来，用 `code === 'Slash'` 判定会在这些键盘上完全按不动（实测 DE `Ctrl+Shift+7`、FR `Ctrl+Shift+-` 的 `key` 都是 `/`）。放开 shift 不会引入歧义：US 布局上 `Ctrl+Shift+/` 打出的是 `?`，字符不符直接不命中。`/` 是输入框里触发应用「能力菜单」的字符，所以只在 composer 聚焦时（`activeElement` 为 composer 或其子节点）于 document 捕获阶段拦截，并 `preventDefault` + `stopPropagation`，既不吞掉其他位置的组合键，也不让 `/` 漏进草稿或弹出能力菜单。组字中（`isComposing`）、按键重复、带 `Cmd`/`Alt` 的变体、以及选模型面板打开时一律放行；`ev.defaultPrevented` 已为真时同样让路（应用先处理了就不抢）。选键位时排除了 `Cmd+J`（应用未绑定但易误按）与 `Cmd+K`（终端已占用）。
- **写回实现（v6，修「偶尔不清空 / 直接叠加」）**：正常通路直接操作 Lexical 模型层——根 DOM 上的 `__lexicalEditor` 句柄 + `parseEditorState(按 \n 切成 paragraph 的状态)` + `setEditorState()` 做**一次性原子替换**（清空旧稿与写入新稿是同一个状态切换，不存在中间态；状态 JSON 与编辑器自身 `toJSON` 同构），随后 `editor.focus()` 并把 DOM 光标补到末尾，用户接着打字不丢焦点。仅在拿不到句柄或模型层写入抛错时才回退 DOM 通路，回退里「先确认清空、再逐行填」各自校验，任一步不确认即报失败走剪贴板兜底，**绝不把新文本叠在残留旧稿上**。旧实现（v5 及之前）默认用 `execCommand('selectAll' + 'insertText')` 做替换，但 `execCommand` 的全选只把浏览器选区落在**最后一段文本节点**（`0..该段长度`）：单段草稿看不出问题，多段草稿只删掉最后一段，其余段落被随后的插入顶走，于是出现「清不干净 / 覆盖混乱」。同因，回退通路的删除改用 `deleteByCut` 的 beforeinput（Lexical 唯一转成 REMOVE_TEXT、真删选区且能跨段的输入类型；`deleteContent` 只删单字符），填入按行发 `insertParagraph` 的 beforeinput（Lexical 忽略 `execCommand('insertParagraph')`）。草稿读取也优先走模型层（`getEditorState().toJSON()` 还原段落换行），与 DOM `textContent` 归一后不一致才回退 DOM 读法（遇到 mention 等非文本节点时更保守）。
- **注入四点**：preload 暴露 `enhancePromptDraft` + `enhanceListModels` IPC（双形态锚点：原生或 modelhub 已打后形态，恰一命中）、main 尾部追加 `zcode-enhance:list-models` + `zcode-enhance:run` handler（仅 run 收尾使用边界标记，list 刻意异串防误配）、index.html 挂 `zcode-enhance.js`、asar 新增该脚本条目。**原地升级**：apply 自动剥离旧版注入（旧 preload 串存载荷 `ENH_PRELOAD_INJECT_V1` 兜底）后按当前载荷重注入，旧版存量与 partial 状态无需先 revert；「已打跳过」仅在主块与当前载荷、注入脚本与源文件**逐字节一致**时生效——载荷或 zcode-enhance.js 更新后重跑 `--enhance-btn` 即原地升级（`--check` 标注「载荷/脚本有更新」）；revert 的 main 移除为边界式（import 行起、catch-return 止，含旧版块尾换行剥离），与载荷版本无关。
- **还原 = 全精确反向替换**（不依赖 sidecar 字节），与 modelhub/TPS 任意安装、还原顺序互不踩踏。
- 配套加固：TPS revert 改为 strip 自身 tag 优先；modelhub revert 改为精确反向替换优先（apply 时在 sidecar 记录 STICKY 注入点后文 32 字节用于定位，注意注入点从 STICKY_OLD 位置推导而非 `indexOf(STICKY_NEW)`——后者会命中文件里 300+ 处自然出现的第一个）。
- 失配处理：preload 锚点失配（≥2 或 0）明确报错拒绝；`chat.promptEnhance` 官方文案若在未来版本被实装，建议移除本补丁改用官方功能。

## 六点五、去额度广告（--quota-banner）

关闭聊天输入框上方的额度骚扰横幅：「(i) GLM-5.3-Flash 今日免费计划额度剩余 46%，可升级获得更稳定额度。[升级 150% 配额] ×」。免费计划额度还剩**一半**（≤50%）就开始弹，随用随弹，纯属升级营销。

- **原理**：渲染层阈值函数 `bZ` 按剩余比例产出横幅类型——`ratio<=0` 走 `exhaustedKind`（model-exhausted/daily-exhausted），`prefix==="daily"` 恒 null，随后 `≤.1→model-very-low`、`≤.2→model-low`、`≤.5→model-half-used` 三档即骚扰源。补丁把三个阈值**等长改为 `-1`**（比例恒 ≥0，永不命中），广告档全部消失。
- **保留的有用提示**（不受影响）：模型额度真正耗尽（0%）、服务端每日额度耗尽、并发受限（系统繁忙）、供应商受限、MCP 额度通知——这些是真实故障/状态反馈，且横幅组件（`data-testid: v4-session-quota-banner`）对它们与广告档共用，故不做整组件屏蔽。若连「剩余 0%」的 model-exhausted 横幅也想去掉，把补丁点①②③的阈值改法推广到 `e.ratio<=0?e.exhaustedKind` 分支即可（会连累 daily-exhausted，需按 prefix 拆分，勿直接等长替换）。
- **补丁点**：`e.ratio<=.1?\`model-very-low\``→`e.ratio<=-1?…`、`e.ratio<=.2?\`model-low\``→`-1?…`、`e.ratio<=.5?\`model-half-used\``→`-1?…`，三锚点在全 asar 均唯一；渲染文件名带哈希随版本变，按内容定位（`out/renderer/assets/*.js` 且 ≥100KB 的唯一命中文件）。
- **等长原地覆盖**：asar 头/offset/integrity 零改动，与统计图/菜单加宽同类；状态记录 `app.asar.quota-patch.json`（仅记 asar_size 指纹与描述），还原 = 反向字节替换（内容锚点，不依赖 sidecar），其它补丁重排 asar 后照常可查可还原。
- **验证**：`--quota-banner --check` 三点全「已打」后重启 ZCode，把免费模型用到 50% 以下——不再出现「额度剩余 x%，可升级」横幅；把额度用到 0% 或触发系统繁忙，横幅仍正常出现。
- **失配处理**：`--check` 报「锚点命中 N 个文件」或「计数异常」说明未来版本重构了阈值函数，按新代码重新分析补丁点，勿盲目替换。内核 zcode.cjs 无此横幅（startPlan 字样仅为供应商 ID/限流上下文），终端 CLI 不受影响也不需要打。

## 七、自定义模型接入指南（纯配置层起步，从零到可用）

> 回答「如何把自己的模型接入 ZCode」：模型条目的标准接口、三层继承规范、必须实现的属性、配置文件与渠道页（注册中心）两条集成路径、按业务需求的决策表。定制深度分三级、逐级递进，多数需求停在 L1：
>
> | 深度 | 动哪里 | 覆盖需求 |
> |---|---|---|
> | L1 配置层 | `~/.zcode/v2/config.json` + 渠道页 UI | 建渠道 / 加模型 / 思考档位 / 视觉标注 / 自定义请求头——本节 7.2–7.6 |
> | L2 载荷层 | modelhub 注入（`--modelhub`，见「四」） | 渠道页长出「拉取模型 / 视觉探测 / 自定义请求头 / 删除持久化」 |
> | L3 内核层 | zcode.cjs 锚点补丁（`--check/--extract`，见「一」） | 自定义档名的思考参数真正下发到请求体 |
>
> AI 代执行约定：改 config.json 前先备份、确认 ZCode 已完全退出、写完做 JSON 语法校验，其余遵循「标准执行流程」。

### 7.1 模型条目的生命周期：四步管线就是它的「方法集」

模型的「方法」不是开发者要写的代码，而是内核管线对条目各字段的消费方式——字段配齐 = 四步全通，缺字段则在对应一步静默降级（表现与处置见 7.7）：

```
~/.zcode/v2/config.json  provider.<渠道>.models.<模型id>
      │ ① 启动·目录同步：无 zcode.modified 的条目被客户端目录同步重写（扩展属性全丢）
      ▼
② 内核 override 构建器（3.11.2 符号 gwt）按分支顺序给模型「定档」：
      ox-alpha 白名单 → glm-5.3 → kimi-k3 → config.reasoning（自定义档位在此生效）→ 家族兜底
      ▼
capability.reasoning = { enabled, levels, providerOptionsByLevel }
      │ ③ 档位解析函数（sD/AD/mN，符号随版本变）：档名 → { level, providerOptions }
      │    自定义模型参数表为空 = 断点 → 思考等级补丁 `?? zCfgEffort(档名)` 兜底
      ▼
④ 合并进请求体：anthropic → thinking{type,budget_tokens} + effort；openai 系 → reasoning_effort
```

### 7.2 模型条目标准接口（config schema）

**渠道级**（`provider.<渠道id>`，一个渠道 = 一个端点 + 一张模型表；渠道 id 任意字符串，`builtin:` 前缀是内置渠道命名空间，自定义渠道避开它）：

| 字段 | 必填 | 说明 |
|---|---|---|
| `kind` | ✅ | 协议方言，也是模型的默认继承来源：`anthropic` / `openai-compatible` / `gemini` |
| `enabled` | 建议 | `false` 的渠道会被增强链路等直接跳过 |
| `options.baseURL`（或顶层 `baseURL`） | ✅ | 服务端点；不带 `/v1` 结尾时调用方自动补（防 `/v1/v1`） |
| `options.apiKey`（或顶层 `apiKey`） | 建议 | 为空时按凭据回退链取 OAuth token（见 7.7） |
| `options.headers` | 可选 | 渠道级自定义请求头，随请求透传（自定义请求头的落点） |
| `models` | ✅ | 模型表，键 = 模型 id（即请求体 `model` 字段的取值） |
| `zcode.deletedModels` | 自动 | 删除持久化：删过的模型 id 记在这里，目录同步不再复活（L2 写入） |

**模型级**（`provider.<渠道id>.models.<模型id>`）：

| 字段 | 必填 | 说明 |
|---|---|---|
| 键名（模型 id） | ✅ | 同时决定家族行为与命名白名单（见 7.3 的二、三层） |
| `kinds` + `defaultKind` | ✅ | 本模型的协议方言数组与默认值，通常继承渠道 `kind`；拉取/手动一般只写一种，数组形态为多协议网关按模型切协议预留 |
| `contextWindow` | 建议 | 上下文窗口（token） |
| `maxOutputTokens` / `limit.output` | 建议 | 输出上限。anthropic 协议要求 `budget_tokens < max_tokens`：配了 `limit.output` 就必须大于所选档位预算（output 32000 + max 档 32000 = 直接 400） |
| `modalities` | 建议 | `input: ["text"]` 或 `["text","image"]`；标注视觉能力，可用视觉探测实测后回填 |
| `reasoning` | 档位需要 | `{enabled, variants[], defaultVariant}`；`variants` 就是 UI 显示的档位集合，`defaultVariant` 必须在列表内 |
| `modified` | 建议 | L2 编辑页拉取写入的条目自带顶层 `modified: true`（UI 表单标记）；防同步重写以下一条为准 |
| `zcode.modified` | ✅ **最关键** | 缺失则启动时被目录同步重写，`reasoning` 等扩展属性全部丢失（表现为档位退回开/关开关，实测 deepseek-flash 踩坑） |
| `zcode.priority` | 建议 | 渠道内模型排序权重，增强按钮按此降序最多试 3 个 |

**最小可用模板**（标准档名 + ZCode ≥ 3.9.1 时零补丁即可用思考档位）：

```json
{
  "provider": {
    "my-relay": {
      "kind": "anthropic",
      "enabled": true,
      "options": { "baseURL": "https://relay.example.com", "apiKey": "sk-..." },
      "models": {
        "my-model-a": {
          "kinds": ["anthropic"], "defaultKind": "anthropic",
          "contextWindow": 200000, "maxOutputTokens": 128000,
          "modalities": { "input": ["text"], "output": ["text"] },
          "reasoning": { "enabled": true, "variants": ["low", "high", "max"], "defaultVariant": "max" },
          "zcode": { "modified": true, "priority": 10 }
        }
      }
    }
  }
}
```

### 7.3 继承规范（三层，从外到内）

1. **协议方言继承（渠道 → 模型）**：模型 `kinds/defaultKind` 缺省继承渠道 `kind`，决定端点路径（anthropic `/v1/messages`、openai 系 `/v1/chat/completions`、gemini 走 `v1beta`）与认证头（anthropic `x-api-key` + `Authorization` 双头、openai 系 `Bearer`、gemini `x-goog-api-key`）。多协议网关在模型上覆盖 `kinds` 即可按模型切协议。
2. **家族行为继承（模型 id → 内核家族分支）**：override 构建器按「ox-alpha 白名单 → glm-5.3 → kimi-k3 → config.reasoning → 家族兜底」顺序匹配；落到家族兜底（如未配 reasoning 的 deepseek 走 `CA()`）只有开/关两档、预算固定 1024。每档参数表 `providerOptionsByLevel` 只给白名单家族（claude/glm/deepseek 等）下发，自定义模型拿到空表——这正是 L3 补丁的兜底点。
3. **命名白名单继承（最强，免配置免补丁）**：模型 id 含 `ox-alpha`（`/ox-alpha/i` 子串匹配）即进内核硬编码白名单，anthropic 协议原生获得 `low/high/max` 三档、`defaultLevel=max`；同端点其它模型无此待遇。想免费获得原生档位，命名是零成本手段（代价是 id 语义被占用）。

### 7.4 集成路径 A：配置文件（手动，少量模型 / 精确控制）

1. **完全退出 ZCode**（运行中改配置会被内存态覆盖回去）。
2. 备份 `~/.zcode/v2/config.json`，按 7.2 模板写入渠道与模型条目；已有渠道只需在 `models` 下加新键。
3. 需要思考档位时逐项自查：`zcode.modified: true`（最关键）、`variants` 完整、`defaultVariant` 在列表内、`limit.output` 大于最高档预算。
4. 启动 ZCode → 设置 → 模型供应商 确认渠道出现、模型可选。
5. 验证见 7.7。
6. 「当前用哪个渠道」由 UI 维护，落在 `~/.zcode/v2/setting.json` 的 `modelProviderFamilySelectedKeys`（兼容 `family:builtin:xxx` 多段前缀），一般不用手改。

### 7.5 集成路径 B：注册中心（渠道页 + modelhub 补丁，批量接入 / 免手写 JSON）

前置：`--modelhub` 已打（见「四」）。入口：设置 → 模型供应商 的添加/编辑渠道页。

1. 填 baseURL + apiKey，选协议格式（方言）。
2. **拉取模型**：按方言自动回退端点（anthropic `/v1/models` 优先、openai 系 `/models` 优先、gemini 走 `v1beta`；带不带 `/v1` 都能拉），全量列表 → 搜索/全选/逐个勾选 → 确认后**模型列表 = 勾选集合，手动添加的条目保留**。
3. **视觉探测**：对勾选模型发 1×1 测试图实测（OpenAI/Anthropic 双协议适配），结果回填 `modalities`。
4. **自定义请求头**：Claude (`claude-cli`) / Codex (`codex_cli_rs`) 全套预设头，逐条勾选、值可编辑、`session_id` 一键换新；写入渠道 `options.headers`，粘性生效（后续改模型配置不再剥头）。
5. **删除持久化**：删除的模型写入渠道 `zcode.deletedModels`，目录同步不会复活。
6. 注意：拉取写入的条目用宽默认值（contextWindow 1M / maxOutputTokens 128000），有真实配额约束的模型回到路径 A 精修这两个字段与 `limit.output`。

### 7.6 按业务需求的接入决策表

| 业务需求 | 配置动作 | 补丁 | 验证 |
|---|---|---|---|
| 能用自定义端点模型即可 | 路径 A/B 建渠道 + 模型条目 | 无 | 模型可选、能对话 |
| 标准档名思考等级（low/medium/high/xhigh/max，≥3.9.1） | `reasoning.variants` 用标准名 | 无（原生通用表） | 请求体 `effort` 随档位变 |
| 自定义档名（如 turbo）/ ZCode ≤ 3.8.1 | `reasoning.variants` 自定义名 | 思考等级补丁（「一」） | 外部日志见 `thinking.budget_tokens` 随档位变 |
| 批量接入端点全量模型 | 路径 B | `--modelhub` | 渠道页出现「拉取模型」按钮 |
| 网关校验 UA/版本头 | 自定义请求头（或手写 `options.headers`） | `--modelhub` | 外部请求日志可见自定义头 |
| 视觉模型能力标注 | `modalities.input` 加 `image` | `--modelhub`（探测） | 带图对话成功 |
| 增强按钮优先用某模型 | ✨ 右键面板直接选（存 localStorage，最简单）；或该条目 `zcode.priority` 调高 | 无（增强按钮见「六」） | 增强 toast 显示所选 model |
| 指定任意健康端点做增强 | `~/.zcode/enhance-config.json`：`{baseURL, apiKey, model, kind}`（可选 `headers`），优先于评分链 | `--enhance-btn` | toast 返回 manual 渠道结果 |
| 用官方 plan 渠道（`zcode.z.ai`）直连 | 无法直连：签名 + PoW + 阿里云 captcha 三层网关校验（内核 `X-Client-Sig`/`X-Client-Pow`），纯直连必 `HTTP 400 code:3007`；增强链路已整体屏蔽 `builtin:` 官方渠道（评分链/面板/指定路径三层过滤） | 无解 | 换自定义渠道 |

### 7.7 验证与排障（自定义模型专属）

- **档位是否真下发**：rollout 请求体是脱敏的（`thinking` 字段被剥，内置模型也一样），不能作判据——以 OpenRouter Dashboard → Activity Log 之类外部请求日志为准；引擎日志（`~/.zcode/cli/log/`）无 400。
- **模型配置丢失 / 档位退回开关**：`zcode.modified` 没配，目录同步重写了条目——补上后重配 `reasoning`。
- **400: budget_tokens 必须小于 max_tokens / max_tokens 缺失**：`limit.output` 与档位预算的约束关系，见「一」的映射表与输出上限约束。
- **模型列表被拉取结果覆盖**：拉取语义 = 勾选集合 + 保留手动条目；被覆盖说明条目 id 撞车，检查重名。
- **凭据回退链（增强链路实现）**：`options.apiKey` → `credentials.json` 的 OAuth token（`oauth:<provider>:access_token`，`enc:v1` 为 AES-256-GCM 密文，密钥取 `ZCODE_CREDENTIAL_SECRET` 或 `zcode-credential-fallback:<platform>:<home>:<username>`；优先 active provider 匹配）。
- **增强按钮选中的渠道 ≠ UI 当前渠道**：先排除 `builtin:` 官方渠道，再按评分排序（选中 +10、自带 apiKey +2、baseURL +1）取最高；渠道内模型按 `zcode.priority` 降序最多试 3 个——503 model_not_found 换下一模型、401/403 跳渠道、400 + captcha/sign 特征识别为网关校验直接跳渠道。✨ 右键面板显式指定的渠道/模型优先于整条评分链（失效自动回退）。
