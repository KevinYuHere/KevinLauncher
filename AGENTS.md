# KevinLauncher — 项目要求（AGENTS.md）

本文件是本仓库的**项目级规则**，opencode 会在本项目会话中自动读取（项目根目录的 `AGENTS.md` 优先于 `CLAUDE.md`；全局规则在 `~/.config/opencode/AGENTS.md`）。**请与代码一起提交。**

---

## 1. 项目概览

- Windows 多应用启动器：Electron 33 + React 18 + TypeScript + electron-vite，打包用 electron-builder（**只有 portable 目标**，即自绘安装程序）。
- 内置游戏模块：原神 / 崩坏：星穹铁道 / 绝区零 / 明日方舟（抽卡记录、游戏更新与预下载、截图图库、使用时长）。
- 两条核心卖点：**精致界面 + 高度自定义**、**原·铁·绝·舟 专属适配**。README 只保留 功能 / 游戏模块 / 第三方与致谢 / 免责声明 四节。

## 2. 环境与常用命令

- **Node 24**（`.nvmrc` 与 `package.json` 的 `engines` 已锁定）。本机用 **fnm** 管理（`D:\fnm\fnm.exe`）。
  `zlib.zstdCompressSync` 需要 Node 22.15+/24（部分测试用它造数据；缺失时会带原因跳过）。
- 安装依赖：`powershell -ExecutionPolicy Bypass -File scripts\install.ps1`（npmmirror + Electron 镜像）。
- 开发（自动提权，仅一次 UAC）：`powershell -ExecutionPolicy Bypass -File scripts\dev.ps1`。
- 类型检查 / 测试 / 构建：`npm run typecheck`、`npm test`、`npm run build`。
- 本地打包（**顺序不能变**）：
  1. `npx electron-builder --win --dir`
  2. `rcedit release\win-unpacked\KevinLauncher.exe --set-icon resources\icon.ico`
  3. `npx electron-builder --win --prepackaged release\win-unpacked --publish never`
  4. `node scripts\build-update-payload.mjs release\win-unpacked <版本>`
- 发布：`npm run release`（本地）或推送 `v*` tag（CI）。

## 3. 发布规则（强制）

1. **版本号必须三处一致**：`package.json` 的 `version`、git tag `v<版本>`、`CHANGELOG.md` 中的段落。
   CI 会校验 tag 与 `package.json`，不一致直接失败。
2. **`CHANGELOG.md` 是唯一事实来源**：
   - **新版本写在文件最上方**（不追加到末尾）；
   - 发布时由 `scripts/extract-changelog.mjs <版本>` 抽取该版本段落，作为 Release 说明与应用内更新日志；
   - **文件缺失或缺少该版本段落时，一律拒绝发布**（本地 `scripts/release.ps1` 与 CI 都会以非零退出中断）。
3. 发布产物固定 3 件：`KevinLauncher-Installer-<版本>.exe`、`KevinLauncher-<版本>-app.zip`、`update-manifest.json`。
4. CI：`.github/workflows/release.yml`，在 `windows-latest` 上构建并发布；触发方式只有 **推送 `v*` tag** 或 **手动 `workflow_dispatch`**（普通提交不会触发）。

## 4. 数据与目录规则

- 用户数据默认在 `%APPDATA%\kevin-launcher`；自定义数据目录记录在 `HKCU\Software\KevinLauncher\DataDir`，并在 `app.ready` **之前** `app.setPath('userData', …)`。
- **数据目录不得与程序目录相同或互相包含**（安装器与设置页都会校验；主进程二次拦截）。
- 迁移数据时：**跳过 Chromium/Electron 缓存与临时项**（GPUCache、DawnGraphiteCache、logs、update-staging 等），容忍被占用文件；
  **仅在"零失败 + 目标可读 config.json"时才删除源目录**，否则保留并记录原因。
- 路径都要支持中文与空格；外部命令一律用**参数数组**或 PowerShell 单引号字面量传路径（不要拼字符串）。

## 5. 安装与升级架构

- 打包布局：`resources/app`（极小 shell：`package.json` + `loader.js` + `out/main/index.js` 垫片）+ `resources/app-<版本>`（真正的应用代码）+ `resources/app-version.txt`（版本指针）。`asar: false`，依赖被打包进代码，应用目录自包含。
- 应用内升级：只下载**应用载荷**（约 0.1 MB）→ 解包到新的 `app-<新版本>` 目录（**不碰正在使用的文件**）→ 改写 `app-version.txt` → `app.relaunch()`；启动时清理旧版本目录。
- **运行库（Electron）升级**：下载完整安装程序、校验后**自动打开安装包**，由安装程序完成覆盖安装。
- 安装器（portable）**启动即以管理员权限运行**；覆盖安装时**按目标目录精确匹配 PID** 关闭旧实例（绝不能用进程名批量杀，否则会杀掉安装器自己）。
- 安装后写入卸载入口（`HKCU\...\Uninstall\KevinLauncher`）与开始菜单/桌面快捷方式，并以**计划任务**默认开启开机自启。
- 应用内升级后要**同步注册表 `DisplayVersion` 与 `install.json`**；安装器读取"已安装版本"时以 `resources/app-version.txt` 为准。

## 6. UI 约定

- 毛玻璃设计令牌（`--glass` / `--brand` / `--on-brand` 等）；**主题色自动适配黑/白文字**。
- 更新指示：左侧导航"设置"上方，**独立图标**（与游戏更新图标不同）、**颜色跟随主题（黑/白，不用主题色）**；
  下载中为环形进度、**点击暂停/继续**、悬停显示百分比/大小/预计时间；**未开始下载时悬停不弹层**；安装阶段不可暂停。
- 安装/卸载界面：**整页自绘**（不是弹窗排版），主题色流光背景 + **线性进度条**。
- **不使用原生弹窗**（`window.confirm`/`alert`），统一用毛玻璃 `components/confirm.tsx`；**任何弹窗都不允许点遮罩关闭**。

## 7. 编码与编辑约定（重要）

- **禁止用 PowerShell 的 `Set-Content` / `Get-Content -Raw` + 回写来改文件内容**：会写入/破坏 UTF-8 BOM，
  曾导致 `package.json` 被加 BOM → Vite JSON 解析失败 → 构建静默失败。请使用仓库提供的文件编辑工具；
  确需字节级操作时用 `[System.IO.File]::ReadAllBytes/WriteAllBytes` 配合 `UTF8Encoding($false)`。
- `.gitignore` 中的构建产物忽略规则**必须锚定到仓库根**（`/out/`、`/dist/`、`/release/`、`/release-*/`、`/logs/`）：
  `shell/out/main/index.js` 是**源码**，曾被未锚定的 `out/` 忽略，导致 CI 打包缺文件。
- 提交信息用**英文**；面向用户的说明、Release 说明、界面文案用**中文**。

## 8. 测试约定

- Vitest；测试**不得依赖外网**（下载类测试用本地 HTTP 服务模拟 Range/重试/续传）。
- 新增下载/升级/安装逻辑时补测试：并发、断点续传、重试、校验失败、差量/复用等。
- 涉及 `zstdCompressSync` 的测试需在旧 Node 上**跳过而不是失败**。

## 9. 日志与磁盘

- `launcher.log` 超过 5 MB 自动轮转为 `launcher.log.1`。
- 启动时清理 `update-staging` 下**非当前版本**的目录。
- 设置页有「清理与占用」区块（暂存 / 缩略图 / 日志），提供逐个与全部清理。

## 10. 与用户协作的约定

- **除非用户明确要求，否则不要推送 GitHub**（本地提交即可；发布/推送前先询问）。
- 需要用户在本机验证的改动，**先构建本地测试版**（可伪装版本号、不上传）。
- 如实说明限制与不确定项（例如网络不可达、无法本地验证的路径），不要假设已通过。
- 本地 PowerShell 会话**不是管理员**；需要提权的操作通过 `Start-Process -Verb RunAs` 包装并等待。
