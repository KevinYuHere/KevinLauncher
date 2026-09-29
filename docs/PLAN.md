# KevinLauncher 实施方案

> 一个 Windows 多应用启动器。默认支持任意应用的自定义添加；对原神、崩坏：星穹铁道、绝区零、明日方舟四款游戏解锁增强模块（抽卡记录、图库、预下载/更新）。
> 架构与逻辑主要参考借鉴 Starward。

## 1. 调研参考

| 项目 | 技术栈 | 许可 | 借鉴点 |
|---|---|---|---|
| Starward (Scighost) | C# / WinUI 3 | MIT | 模块划分：抽卡 / 时长 / 截图 / 预下载 / 背景 |
| FufuLauncher | C# / WebView2 | MIT | 抽卡 URL 捕获（CaptureApp）、视频背景 |
| Collapse (neon-nyan) | C# | — | 插件式游戏支持 |
| Xel-Launcher (lTinchl) | C# WinForms | Apache-2.0 | 方舟/终末地 多服切换、下载/更新 |
| ArknightsLauncher (lTinchl) | C# | MIT | 方舟 PC 切服 |
| Hi3Helper.Plugin.Arknights / .Hypergryph | C# | MIT | 方舟更新/下载 API 实现 |
| AceDroidX/arknights-gacha-export | Rust | **无 LICENSE** | 仅参考 `API.md` 接口事实，**不拷贝代码** |
| RWoxiN/ArknightsDataAnalysis | Python | GPL-3.0 | 方舟官网寻访记录链路 |

**关键结论**：明日方舟**没有游戏内抽卡记录页面**，无法「游戏内打开记录页自动抓取」。改用**鹰角官网账号 API**。终末地同理（`ef-webview.hypergryph.com/api/record/*`）。

## 2. 已确认决策

| 项 | 决定 |
|---|---|
| 技术栈 | **Electron + Vite + React + TypeScript**（`electron-vite`） |
| 主进程 | Node：进程控制 / 代理 / 抽卡 / 更新 / 持久化 |
| 渲染进程 | React UI，经 preload IPC 通信 |
| 米哈游抽卡 URL 捕获 | 本地代理 / 网络捕获（HTTPS MITM，仅 loopback） |
| 明日方舟抽卡 | 鹰角官网账号 API（WebView2/浏览器登录取 token） |
| 目标形态 | 个人自用；仅国服 |
| 默认权限 | 所有应用**默认以管理员身份运行**（可单条关闭）；需要提权的目标自动回退提权 |
| UI 风格 | **布局/交互照抄 Starward**：左侧图标栏 + 左上角一排游戏头像（切换/添加）+ 右上窗口按钮 + 右下「时长胶囊 + 大号启动按钮」；全屏游戏背景，所有浮层半透明模糊（frosted glass）；页面切换带过渡动画；配色默认品牌蓝 `#3778e5`，**可按游戏自定义/自动提取** |
| 多账号 / 游戏内注入 | 不做 |
| 上游跟进 | 手动阅读上游代码移植；保留溯源注释 + `docs/UPSTREAM.md` + `metadata/*.json` |

## 3. 核心设计原则

### 3.1 不假定启动目标（重要）

四款游戏的增强功能**不得假定直接启动 `YuanShen.exe` 等本体**。实际启动目标可能是：游戏本体 exe、厂商官方启动器、`start.bat` / PowerShell 脚本，或第三方启动器（再由它启动游戏）。因此：

- **应用条目与增强模块解耦**：`AppEntry` 只描述「启动什么、怎么启动」；`Addon` 只描述「该游戏能做什么」；两者由用户**显式绑定**（`addonId`），**绝不靠 exe 名自动推断**。
- 参数 / 工作目录 / 环境变量全部显式配置，脚本与二级启动器都能正确传递。
- **时长记录用进程树**：记录被启动进程 PID，追踪其全部后代进程；中间脚本退出后，已发现的后代 PID 继续跟踪。不依赖具体进程名。
- **抽卡捕获用网络**：代理层匹配 `getGachaLog` 请求，与「谁启动、什么进程名」无关。
- 图库 / 更新：使用显式配置目录与官方 API，与启动目标无关。
- 对「以管理员启动」这类无法取到 PID 的情况，用可选的 `monitorProcessNames` 兜底。

### 3.2 分层

主进程（Node）承载全部系统能力；渲染进程只做 UI；`src/shared` 存放两者共用的类型。后续抽卡 / 更新等重逻辑继续放主进程，便于单测。

### 3.3 进程与线程（避免 UI 阻塞）

- 启动器**整体以管理员身份运行**：`scripts/dev.ps1` 自提权（开发），打包版由 manifest/自重启提权。这样启动需要提权的游戏时**不再逐次弹 UAC**，且能拿到真实 PID、可停止。
- 启动器已提权时，游戏**直接 spawn**（拿到 PID）；未提权时才回退 `Start-Process -Verb RunAs`。
- **进程枚举在 worker 线程**（`ProcessScanner` + `workers/processWorker.ts`）中执行，主进程事件循环与 UI 不被阻塞；失败时回退内联扫描。
- 日志异步写入，不阻塞主线程。

## 4. 项目结构（当前）

```
KevinLauncher/
├─ package.json
├─ electron.vite.config.ts
├─ tsconfig.json / tsconfig.node.json / tsconfig.web.json
├─ src/
│  ├─ shared/types.ts              # 主/渲染共用类型
│  ├─ preload/index.ts             # contextBridge 暴露 window.api
│  ├─ main/
│  │  ├─ index.ts                  # 生命周期、窗口、kevin-media:// 协议
│  │  ├─ ipc.ts                    # IPC 处理器
│  │  ├─ addons/registry.ts        # 游戏模块目录（仅描述能力，无路径/进程名）
│  │  └─ services/
│  │     ├─ appStore.ts            # config.json 读写
│  │     ├─ background.ts          # 背景文件管理
│  │     ├─ launcher.ts            # 启动 exe/bat/ps1，提权，参数解析
│  │     ├─ processTree.ts         # 进程快照与后代枚举
│  │     └─ runtime.ts             # 运行时进程树追踪
│  └─ renderer/
│     ├─ index.html
│     └─ src/{main.tsx,App.tsx,components/,assets/}
├─ tests/                          # vitest 单测
├─ metadata/                       # 易变 API 元数据（M3 起）
└─ docs/
```

## 5. 依赖

- 运行时：`@electron-toolkit/preload`、`@electron-toolkit/utils`
- 构建：`electron`、`electron-vite`、`vite`、`@vitejs/plugin-react`、`typescript`、`vitest`
- 后续：`better-sqlite3`（时长/抽卡库）、`win-dpapi`（凭据加密）、`http-mitm-proxy` + `node-forge`（M3 抓取）、`electron-builder`（M6）

## 6. 数据模型

- 配置：`%APPDATA%/kevin-launcher/config.json`（`{ version, apps: AppEntry[] }`）。
- 背景：`%APPDATA%/kevin-launcher/bg/<uuid>.<ext>`，经 `kevin-media://bg/<file>` 加载。
- 后续 SQLite（`kevin.db`）：

```sql
PlaySession(Id PK, AppId, StartUtc, EndUtc, DurationSec)
GachaRecord(Id PK, AppId, Uid, GachaType, ItemId, ItemName, RankType, TimeUtc,
            IsUp, Seq, SourceUid, UniqueHash)
UpdateHistory(Id PK, AppId, Version, Kind, FinishedUtc)
```

- 凭据（方舟 token、代理根证书）用 DPAPI 加密，绝不上传。

## 7. 功能规格

### 7.1 通用应用管理（M0，已完成）
- 添加 exe / bat / cmd / ps1 / lnk / 任意文件 → 自动提取图标（`app.getFileIcon`，存为文件）。
- **自定义显示名与图标**：可改名；可从图片文件导入自定义图标（存于 `icons/`，经 `kevin-media://icon/<file>` 加载）。
- 配置：显示名、启动参数、工作目录、环境变量、以管理员运行、绑定游戏模块、截图目录、监视进程名。
- **默认以管理员身份运行**（配置 v2 迁移）。
- 启动：启动器已提权时直接 `child_process.spawn`（拿 PID）；否则回退提权；bat/cmd 经 `cmd /c`，ps1 经 `powershell -File`。
- **停止**：`taskkill /PID <pid> /F` 结束被追踪的进程树。

### 7.2 自定义背景（M0，已完成）
- 每应用一张背景：图片（png/jpg/webp…）或视频（mp4/webm），经自定义协议加载。

### 7.3 时长记录（M1）
- 进程树追踪（已实现），落库 + 统计图表。

### 7.4 抽卡记录（M3 / M4）
- 米哈游三作：缓存扫描 / 手动链接 → `getGachaLog` 分页 → 去重 → 统计 + UIGF 导入导出。
- 明日方舟：**打开鹰角账号登录页**（无需粘贴 token）→ 自动获取凭据 → 官网寻访记录链路。
- **凭据缓存**：token 用 Electron `safeStorage`（DPAPI）加密保存；优先复用缓存 → 失效时用持久会话静默刷新 → 仍失败才弹登录页，**不会每次打开都要求登录**。
- **仅保留最高 / 次高品级**：记录列表隐藏其他品级，并提供「显示次高品级」开关。
- **逐件垫抽**：每条记录显示「距上次同级别」的抽数。
- **卡池互通分组（独立计算）**：米哈游按卡池类型（角色池之间互通、武器池/常驻各自独立）；明日方舟**标准寻访全部互通**、**各限定寻访互不继承**（按具体卡池分组）。每个分组独立显示当前垫抽（距上次最高/次高品级多少抽）与上一件物品。
- **主题色**：每个应用可自定义主题色，或**从背景图自动提取**；切换游戏时全套 UI 配色自动切换（`--brand` 系列 CSS 变量）。
- **保底统计（按游戏区分品级）**：原神/星铁最高 5★、次高 4★；绝区零最高 S(4)、次高 A(3)；明日方舟最高 6★(5)、次高 5★(4)。每个卡池显示：最高品级距上次过了几抽（当前垫抽）、上一件最高品级物品；以及次高品级同理。

### 7.5 图库（M2）
- 打开显式配置的截图目录；可选内置浏览页。

### 7.6 预下载 / 更新（M5）
- 米哈游：HoYoPlay `getGameConfigs` / `getGamePackages`（`main` / `pre_download`、Sophon segments），断点续传 + 校验。
- 明日方舟：鹰角 CDN 版本检测 + 差分下载。

## 8. 上游跟进策略（手动）

- 上游更新时，手动阅读其变更代码并移植到对应模块。
- 保留：① 移植文件头溯源注释；② `docs/UPSTREAM.md` 映射表；③ `metadata/*.json` 让端点/参数变动尽量只改数据。
- 不做：自动同步脚本 / lock / CI / 通知。

## 9. 里程碑

| 阶段 | 交付 | 状态 |
|---|---|---|
| **M0** | 工程骨架、应用 CRUD、启动（exe/bat/脚本）、图标、背景、进程树追踪 | ✅ 完成 |
| **M1** | 时长落库（`playtime.json`）+ 总时长/今日/近 7 天/近 30 天 + 柱状图统计弹窗 | ✅ 完成 |
| **M2** | 四游戏 Addon 骨架 + 图库（打开截图目录） | ✅ 完成 |
| **M3** | 米哈游抽卡：`getGachaLog` 分页 + 缓存扫描/手动链接 + 去重 + 统计 + 导入导出 | ✅ 完成（本地代理待补） |
| **M4** | 明日方舟抽卡：官网 token 链（oauth→binding→u8→role→gacha history） | ✅ 完成 |
| **M5** | 更新检测：HoYoPlay `getGamePackages` / 鹰角版本接口 | ✅ 完成（检查；实际打补丁规划中） |
| **M6** | electron-builder 打包（NSIS + `requireAdministrator`） | ✅ 配置完成 |

> 说明：米哈游抽卡优先走「游戏缓存扫描 + 手动链接」，本地代理（HTTPS MITM）作为后续增强；完整游戏补丁/预下载下载器规划中。

## 10. 风险

- **HTTPS MITM 需装根证书**（敏感）：仅 loopback、首次明确告知、可一键卸载；保留缓存扫描兜底。
- **官方 API 易变**：端点/`launcher_id`/`appCode` 外置到 `metadata`。
- **大文件下载**：>100MB 资源不代下，提供链接与放置路径。
- **合规**：非官方/学习交流 + 免责声明；仅借鉴 MIT/Apache 代码并保留版权。

## 11. 开发环境要求

- Node.js ≥ 18（当前 v24）
- Windows 10 1809+，WebView2 运行时（游戏通常已装）
- 安装依赖：`npm install`（会下载 Electron 二进制，约 100MB+）
- 命令：`npm run dev`（开发）、`npm run build`、`npm test`、`npm run typecheck`
