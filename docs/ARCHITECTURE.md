# KevinLauncher 架构与进展

> Windows 多应用启动器。默认支持任意应用的自定义添加；对原神、崩坏：星穹铁道、绝区零、明日方舟四款游戏解锁增强模块（抽卡记录、图库、预下载/更新、游戏时长）。
> 交互与模块划分参考 Starward（Scighost），仅在必要处移植其逻辑并在文件头/文档中注明来源。

---

## 1. 技术栈

| 层 | 选型 |
|---|---|
| 外壳 | Electron 33（`requireAdministrator`，启动即以管理员运行） |
| 构建 | electron-vite（Vite 5）+ TypeScript 5 |
| 主进程 | Node（子进程 / 进程枚举 / 下载 / 抽卡 / 更新 / 持久化） |
| 渲染进程 | React 18 + 手写 CSS（`src/renderer/src/assets/main.css`） |
| 通信 | `contextBridge` 暴露 `window.api`（`src/preload/index.ts`），类型定义在 `src/shared/types.ts` |
| 压缩 | `fzstd`（Sophon 清单/分块）；`hpatchz.exe`（HDiffPatch，块级补丁） |
| 测试 | vitest（`tests/`） |

进程内另有 **worker 线程**：`processWorker`（进程枚举，避免阻塞 UI）、`sophonWorker`（更新下载）、`thumbWorker`（图库缩略图）。

---

## 2. 目录结构

```
src/
├─ shared/types.ts              主/渲染共用类型 + window.api 契约
├─ preload/index.ts             contextBridge 暴露 API
├─ main/
│  ├─ index.ts                  生命周期、窗口、kevin-media:// 协议、启动图标
│  ├─ ipc.ts                    所有 IPC handler
│  ├─ addons/registry.ts        游戏模块目录（仅描述能力）
│  ├─ gacha/                    抽卡：metadata / mihoyo / arknights / urlSource / hypergryphAuth / gachaStore
│  ├─ update/                   更新：hoyoplay / sophon / sophonPatch / arknightsUpdate / updateManager
│  ├─ services/                 通用服务（见 §4）
│  └─ workers/                  processWorker / sophonWorker
└─ renderer/
   ├─ index.html
   └─ src/
      ├─ App.tsx                顶层状态与视图切换
      ├─ theme.ts               applyTheme：--brand / --on-brand 变量
      ├─ media.ts               kevin-media:// URL 生成
      ├─ viewTypes.ts           ViewId
      ├─ assets/main.css        设计系统（全部样式）
      └─ components/            Rail / GamesRow / HomeView / GachaView / GalleryView /
                                PlayTimeView / SettingsView / UpdateView /
                                AppFormDialog / IconCropper / WindowControls / Icon
```

---

## 3. 启动与窗口

1. `app.setName('kevin-launcher')`：dev 与打包版共用 `%APPDATA%\kevin-launcher`。
2. 打包版若未提权则 `relaunchElevated()`（`Start-Process -Verb RunAs`）；dev 由 `scripts/dev.ps1` 自提权。
3. 注册 `kevin-media://` 协议（`standard/secure/supportFetchAPI/stream`），host 区分：
   - `icon` → `%userData%/icons`
   - `brand` → `%userData%/brand`（启动器自定义图标）
   - `default` → 内置 `resources`（打包后 `process.resourcesPath`）
   - `file` → 任意绝对路径（base64url，用于图库）
   - 其它 → 背景目录
4. `createWindow(icon)` 在**创建时**就带上启动器图标；`ready-to-show` 时 `show()+focus()` 并短暂置顶（Windows 前台锁定兜底）。
5. `×` 行为与「启动游戏后」行为由 `services/behavior.ts` + 托盘实现。

---

## 4. 主进程服务

| 文件 | 职责 |
|---|---|
| `appStore.ts` | `config.json` 读写 + 版本迁移（当前 v5） |
| `launcher.ts` | 启动 exe/bat/cmd/ps1/lnk；`.lnk` 直接走 ShellExecute（**不解析目标**）；提权回退 |
| `runtime.ts` | 运行时追踪：进程树 + 监视进程名；无 PID 启动有 5 分钟"等待被监视进程"宽限 |
| `processTree.ts` / `processScanner.ts` | 进程快照与后代枚举（worker + 内联回退） |
| `playTimeStore.ts` | `playtime.json` 会话持久化与聚合 |
| `background.ts` / `icon.ts` / `brand.ts` | 背景 / 应用图标 / 启动器图标文件管理 |
| `theme.ts` | 从背景图提取强调色 |
| `appIcon.ts` | 把启动器图标应用到窗口 / 托盘 / 快捷方式 |
| `behavior.ts` | 托盘图标与菜单、`×` 关闭行为、退出标记 |
| `downloader.ts` | HTTP 下载（断点续传、分块合并） |
| `elevation.ts` | 是否管理员 |
| `logger.ts` | 异步日志 |
| `tokenStore.ts` | `safeStorage` 加密缓存（方舟 token） |

---

## 5. 数据模型与持久化

`%APPDATA%/kevin-launcher/`：

- `config.json`
  ```ts
  { version: 5, apps: AppEntry[], ui: { gamesRowHidden }, launcher: { iconFile, fontFamily, closeAction, afterLaunch } }
  ```
  `AppEntry` 关键字段：`targetPath / arguments / workingDirectory / gameDirectory / environmentVariables /
  runAsAdmin / addonId / iconFile / backgroundFile / themeColor / glassStyle('dark'|'light') /
  autoTheme / backgroundBlur / backgroundDim / screenshotDirectory / monitorProcessNames`。
- `playtime.json`：`{ version, sessions: {appId,startUtc,endUtc,durationSec}[] }`
- `gacha.json`：抽卡记录（按应用）
- `icons/` `brand/` `bg/`：图标 / 启动器图标 / 背景文件

迁移：v2 默认管理员；v3 玻璃风格；v4 背景模糊/压暗；v5 `autoTheme` 与压暗默认值调整。

---

## 6. IPC 接口（`window.api`）

- 应用：`listApps / addApp / updateApp / removeApp / reorderApps`
- 外观：`setBackground / setIcon / setIconData / resetIcon / resetBackground / setThemeColor / extractThemeColor / setGlassStyle / setBgTuning / setAutoTheme`
- 图标来源：`pickIconSource`（图片或 exe/bat/lnk → 提取图标为图片）、`readImage`
- 启动：`launchApp / listRunning / stopApp`
- 时长：`playTimeTotals / playTimeSummary`
- 抽卡：`gachaList / gachaStats / gachaClear / gachaUpdateMiHoYo / gachaLoginArknights / gachaScanUrl / gachaExport / gachaImport`
- 更新：`updateInfo / updateStart / updateCancel / updateStatus`
- 图库：`galleryList / galleryOpenViewer / galleryContextMenu`
- 选择器：`pickExecutable / pickBackground / pickImage / pickDirectory / openPath`
- 窗口：`windowMinimize / windowToggleMaximize / windowClose / windowIsMaximized / hideToTray`
- 全局设置：`getLauncherSettings / setLauncherIcon / setLauncherFont / setLauncherBehavior / listFonts / appVersion / getUiPrefs / setGamesRowHidden`
- 事件：`onAppsChanged / onRunningChanged / onPlayTimeChanged / onWindowMaximized / onUpdateProgress / onLauncherChanged`

---

## 7. 渲染进程

- **页面**：主页(Home) / 游戏时长(PlayTime) / 抽卡(Gacha) / 图库(Gallery) / 更新(Update) / 设置(Settings)；`ViewId` 见 `viewTypes.ts`。
- **布局**：左侧图标栏 + 左上游戏栏（可拖动排序、可隐藏、悬停预览）+ 右上窗口按钮 + 右下「时长胶囊 + 启动键」。
- **主题**：每个应用可设主题色或从背景自动提取（`autoTheme`），切换游戏整套配色切换；明亮主题色时 `--on-brand` 自动转黑。
- **毛玻璃**：统一 `blur(18px)`；每个应用可选明/暗玻璃与背景模糊/压暗。
- **背景**：切换游戏时先解码新图再连同其模糊一起替换，避免"闪清晰"。
- **图标框选**：`IconCropper`（Delaunay 无关，简单缩放/拖动），输出 256×256 PNG。
- **设置**：两页（游戏设置 / 启动器设置）；启动器页含图标、字体（读取本机字体并按字体渲染）、`×` 行为、启动游戏后行为、版本号。

---

## 8. 功能状态

| 模块 | 状态 |
|---|---|
| 应用 CRUD / 启动（exe/bat/cmd/ps1/lnk + 提权 + 进程树） | ✅ |
| 自定义图标（含框选）/ 背景 / 主题色（含自动提取） | ✅ |
| 游戏栏拖动排序 / 隐藏（持久化） | ✅ |
| 每应用明暗玻璃 / 背景模糊 / 背景压暗 | ✅ |
| 游戏时长：会话落库 + 总/日/周/月 + GitHub 式热力图 | ✅ |
| 抽卡：米哈游（缓存抓取/手动链接/导入导出/UIGF）+ 方舟（官网登录） | ✅（逻辑对齐 Starward） |
| 图库：任意应用可用 | ✅ |
| 更新：米哈游 Sophon 全量+文件级增量+块级补丁（hpatchz）；方舟 CDN 包+分卷解压；预下载（可被更新复用） | ✅ |
| 打包：NSIS 配置 + `requireAdministrator` | ⚠️ 见 §9 |
| 启动器图标：窗口/任务栏/托盘/快捷方式/exe | ✅（exe 需手工 rcedit，见 §9） |

---

## 9. 打包与发布

- `npm run build`（electron-vite）→ `out/`；`npx electron-builder --win --dir` → `release/win-unpacked`。
- 打包配置设了 **`win.signAndEditExecutable: false`**：签名 / rcedit 步骤需要联网下载 `winCodeSign`，故关掉它让打包**正常完成**；代价是 exe 不写入图标与版本信息。
- 因此 **exe 内嵌图标需手工写入**：本机已有离线 rcedit，
  ```
  rcedit-x64.exe release\win-unpacked\KevinLauncher.exe --set-icon resources\icon.ico
  ```
  每次重新打包后都要再跑一次。
- **默认图标**：`resources/icon.png` + `resources/icon.ico`（当前为 K 字标 `K-f8`），通过 `extraResources` 随包分发；未设置自定义图标时即用它。
- 开始菜单快捷方式：`%APPDATA%\Microsoft\Windows\Start Menu\Programs\KevinLauncher.lnk`（已设"以管理员身份运行"标记）。

---

## 10. 已知缺口 / 待办

- 米哈游抽卡的**本地代理自动抓取（HTTPS MITM）**未实现，目前用"缓存抓取 + 手动链接"。
- Starward 只保留聚合时长（无逐日），故**无法导入逐日游玩分布**；已放弃导入。
- 打包签名/自定义 exe 图标需能联网或用离线 rcedit 手工处理。
- 测试覆盖仅 `argParser` / `processTree`。

---

## 11. 上游参考

| 模块 | 来源 |
|---|---|
| 抽卡 API / 缓存抓取 / 卡池类型 | Scighost/Starward `Starward.Core/Gacha/*` |
| HoYoPlay 更新（Sophon） | Scighost/Starward `Starward.Core/HoYoPlay/*` |
| 方舟抽卡 API | AceDroidX/arknights-gacha-export `API.md`（仅接口事实） |
| 布局与模块划分 | Scighost/Starward |

移植文件在头部注明来源；其余实现为本项目独立编写。
