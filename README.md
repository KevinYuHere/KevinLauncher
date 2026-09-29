# KevinLauncher

一个面向 Windows 的多应用启动器，内置米哈游三款游戏（原神 / 崩坏：星穹铁道 / 绝区零）与明日方舟的扩展模块：
抽卡记录、游戏更新与预下载、截图图库、使用时长统计。

界面为 Starward 风格的深色毛玻璃（Acrylic 观感），并支持亮/暗玻璃、背景模糊与暗化、跟随主题色自动黑/白文字。

> 本项目为**非官方第三方工具**，与 miHoYo / HoYoverse / Hypergryph 无任何关联。
> 功能与接口流程参考了 [Starward](https://github.com/Scighost/Starward)，详见 [THIRD-PARTY-NOTICES](./THIRD-PARTY-NOTICES.md)。

仓库地址：https://github.com/KevinYuHere/KevinLauncher

---

## 功能

### 通用（任意应用）

- 任意程序均可作为启动项：`exe` / `bat` / `cmd` / `ps1` / `lnk`（快捷方式按其当前指向直接通过资源管理器打开）。
- 以**管理员身份**运行，启动游戏客户端不需要每次都弹 UAC；启动后可跟踪并结束进程。
- 图标：可选择图片，或从 `exe / bat / lnk` 中提取图标，并支持**框选 + 缩放**裁剪。
- 使用时长统计：总时长、每日时长、热力图；按会话记录。
- 截图图库：浏览截图目录，缩略图在 Worker 中按需生成，大图在独立查看器窗口打开。
- 外观：每个应用可单独设置主题色、亮/暗玻璃、背景图与背景模糊/暗化；主题色会自动适配黑/白文字。
- 启动器设置：启动器图标、界面字体、关闭按钮行为、启动应用后的行为、全部设置的导出 / 导入备份。
- **检查更新**：基于 GitHub Releases，启动时与每 24 小时自动检查一次；设置页也提供手动检查。
  检测到新版本弹出更新日志，可选择「立即更新」或「暂不更新」。
  选择更新后**不会打开安装程序窗口、也不需要任何选择**：左侧导航（设置按钮上方）会出现
  **主题色进度环**，点击可**暂停 / 继续**下载（8 连接、断点续传、自动重试），悬停展开浮层显示
  百分比、已下载 / 总大小与预计剩余时间。下载完成后自动进入**安装阶段**并在同一个环形上显示
  安装进度（安装不可暂停），完成后重启完成升级，全程不阻塞界面。
- 全新安装使用**完全自行绘制**的安装界面（见下）。

### 安装程序

- NSIS 安装向导（非静默）：可视化选择安装目录，自动写入开始菜单与桌面快捷方式（不询问）。
- 安装包带有深色品牌页眉 / 侧边栏与程序图标，风格与启动器一致。

### 后台行为

- **单实例**：重复点击快捷方式不会打开新窗口，而是把已有窗口切到前台。
- **托盘常驻**：只要启动器在运行，托盘区就有图标（可显示主界面 / 退出）。
- **开机自启**：设置页可选「关闭 / 打开窗口 / 静默托盘」。使用**计划任务（`schtasks /RL HIGHEST`）**
  注册，登录时静默以管理员权限启动，**不会弹 UAC**；失败时回退到注册表 Run 项。

### 游戏模块

- **抽卡记录**：原神 / 星穹铁道 / 绝区零（从游戏 web 缓存读取）与明日方舟（账号登录授权）。
  支持卡池分类、5★/4★ 统计、保底计数、记录分页；抓取过程**不阻塞界面**，结果在顶部通知栏提示。
- **游戏更新与预下载**：米哈游 Sophon 全量 / 文件级增量 / 差分补丁（HDiffPatch），明日方舟分包更新。
  支持**多线程分块下载**、**断点续传**（已完成文件按大小 + MD5 跳过）、**校验失败自动重试**，以及**预下载 → 正式更新复用**。
- 下载界面：进度环 + 百分比，悬停显示速度 / 已下载与总大小 / 预计剩余时间；点击可暂停 / 继续。
- 同版本预下载的暂存目录会在正式更新时被复用，只下载缺失部分。

---

## 技术栈

| 层 | 技术 |
| --- | --- |
| 运行时 | Electron 33 |
| 界面 | React 18 + TypeScript，原生 CSS（毛玻璃设计令牌） |
| 构建 | electron-vite + Vite 5 |
| 打包 | electron-builder（NSIS） |
| 测试 | Vitest |
| 存储 | JSON 文件（`%APPDATA%\kevin-launcher`），无数据库 |
| 关键依赖 | `fzstd`（zstd 解压）、`hpatchz.exe`（差分补丁） |

数据与实现细节见 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)。

---

## 快速开始（开发）

环境要求：**Windows 10/11**、**Node.js 20+**、PowerShell 5.1+。

```powershell
# 1) 安装依赖（使用 npmmirror + Electron 镜像）
powershell -ExecutionPolicy Bypass -File scripts\install.ps1

# 2) 以管理员身份启动开发模式（会自动请求一次 UAC）
powershell -ExecutionPolicy Bypass -File scripts\dev.ps1

# 3) 运行测试 / 类型检查
npm run test
npm run typecheck
```

> `scripts\dev.ps1` 会重新以管理员权限启动自己，因此只会弹一次 UAC。
> 直接执行 `npm run dev` 也可以，但启动游戏时可能每次都需要授权。

### 构建 Windows 安装包

```powershell
npm run build:win
```

由于 `electron-builder.yml` 中设置了 `win.signAndEditExecutable: false`（避免联网下载 winCodeSign），
打包出的 exe 图标需要在打包后手动写入：

```powershell
& "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign\<hash>\rcedit-x64.exe" `
  release\win-unpacked\KevinLauncher.exe --set-icon resources\icon.ico
```

---

## 发布新版本

```powershell
# 1) 改 package.json 的 version（例如 0.1.0）
# 2) 一条命令完成：构建 -> 打包 -> 生成差分资源 -> 发布到 GitHub Releases
npm run release
```

`scripts\release.ps1` 会依次执行 electron-vite 构建、`electron-builder --dir` + 图标写入、
NSIS 打包、`scripts/build-update-payload.mjs`（生成升级用的 zip 与清单），最后用 `gh` 把
5 个资源上传到 `v<version>`：

| 资源 | 用途 |
| --- | --- |
| `KevinLauncher-Setup-<version>.exe` | 全新安装的安装程序 |
| `...exe.blockmap`、`latest.yml` | electron-builder 产物（校验 / 兼容其他工具） |
| `KevinLauncher-<version>.zip` | 升级载荷：应用文件树（旧客户端下载并解包） |
| `update-manifest.json` | 升级清单：版本、解包总大小（安装进度分母）、载荷 SHA-256 |

> 参数：`-SkipUpload` 只构建不上传；`-Draft` 发草稿；`-Version x.y.z` 指定版本。

---

## 数据存放位置

开发模式与打包版本共用同一目录（`app.setName('kevin-launcher')`）：

```
%APPDATA%\kevin-launcher\
├─ config.json          # 应用列表 + 界面 + 全局设置（含版本号与迁移）
├─ playtime.json        # 使用时长会话
├─ gacha\<appId>.json   # 抽卡记录缓存
├─ fonts.json           # 本机字体缓存
├─ icons\ brand\ bg\    # 图标 / 启动器图标 / 背景图
├─ predownload\         # 预下载暂存（正式更新时复用）
└─ launcher.log         # 运行日志
```

> 抽卡接口的 `authkey` / 账号 token 等凭据**只保存在本机**，不参与任何上传。

---

## 目录结构

```
src/
├─ main/            # 主进程（Electron）
│  ├─ update/       # 更新与预下载：sophon / sophonPatch / hoyoplay / arknightsUpdate / updateManager
│  ├─ gacha/        # 抽卡：mihoyo / arknights / 缓存扫描与鉴权
│  ├─ services/     # launcher / runtime / playTimeStore / appStore / icon / brand / background / downloader / logger ...
│  └─ workers/      # worker 线程：sophon 下载装配、进程快照
├─ preload/         # contextBridge（window.api）
├─ shared/          # 主进程与渲染进程共享类型
└─ renderer/        # React 界面
   └─ src/components/   # HomeView / GachaView / GalleryView / UpdateView / SettingsView / PlayTimeView ...
tests/              # Vitest 单元测试（含本地 HTTP 服务模拟下载）
docs/               # ARCHITECTURE / PLAN / UPSTREAM
resources/          # 图标、hpatchz.exe
```

---

## 第三方与致谢

- 直接使用的第三方库（Electron、React、fzstd 等）：见 [THIRD-PARTY-NOTICES](./THIRD-PARTY-NOTICES.md)。
- 参考的开源项目：
  - [Starward](https://github.com/Scighost/Starward)（MIT）— 米家启动器功能布局与接口流程的重要参考；
  - [HDiffPatch](https://github.com/sisong/HDiffPatch)（MIT）— 增量更新思路与 `hpatchz` 可执行文件。

---

## 免责声明

本项目仅供学习与研究使用，为**非官方**工具，与任何游戏厂商及其关联公司无关联，
也未获得其授权或认可。所有游戏名称、图标、素材等归各自权利人所有。

使用本工具调用非公开接口、读取本地缓存等行为可能违反游戏用户协议，
由此产生的任何后果（包括但不限于账号风险、数据损坏）由使用者自行承担。
请自行判断并在合规范围内使用。

---

## License

[MIT](./LICENSE) © 2026 Kevin
