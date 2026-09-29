# 安装与升级的实现方案

> 状态：**更新（老应用自升级）已实装**；**自绘安装界面尚未实装**（当前仍用 NSIS 向导）。
> 本文描述两条安装路径的统一设计。

## 0. 两种安装路径

| 场景 | 触发方式 | 谁来安装 | UI |
| --- | --- | --- | --- |
| **A. 升级** | 老应用检测到新版本 | 老应用自己：下载 → 解包 → 退出后换文件 → 重启 | 左侧导航的**主题色进度环**（已有） |
| **B. 全新安装 / 手动下载安装包** | 用户双击 `KevinLauncher-Setup-<ver>.exe` | 安装程序 | **完全自绘的安装界面**（三页） |

两条路径共用**同一份 zip 载荷**与**同一套"把载荷写进安装目录"的代码**，区别只在于
A 需要联网下载、B 载荷就在安装程序里，且 B 多了"选目录 / 写快捷方式 / 写注册表"。

## 1. 关键前提：用户数据不在安装目录里

这是"覆盖安装不丢数据"的**结构性保证**，不是靠小心：

```
<安装目录>                                  %APPDATA%\kevin-launcher\
├─ KevinLauncher.exe      ← 程序，可整目录覆盖  ├─ config.json        应用列表 / 界面 / 全局设置
├─ resources\app.asar                           ├─ playtime.json      使用时长
├─ *.dll, locales\ …                            ├─ gacha\*.json       抽卡记录
└─ hpatchz.exe                                  ├─ icons\ brand\ bg\  图标 / 背景
                                                ├─ predownload\       预下载暂存
                                                └─ launcher.log
```

覆盖安装只写**左边**，右边的用户数据目录**完全不动**；卸载时才询问是否删除。

## 2. 检测本机已有安装（自动沿用老版本路径）

按优先级：

1. `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\KevinLauncher` →
   `InstallLocation`（我们自己写的，最权威）；
2. `HKLM\...\Uninstall\KevinLauncher`（如果以后支持全机安装）；
3. 默认路径 `%LOCALAPPDATA%\Programs\KevinLauncher` 下存在 `KevinLauncher.exe`；
4. 便携/解压目录外正在运行的 `KevinLauncher.exe` 所在目录（弱信号，仅作提示）。

命中后：

- 安装页的路径输入框**预填老路径**，并显示
  「检测到已安装 **0.0.2**（安装于 …），将**覆盖安装**到该目录，**保留全部用户数据**」；
- 若老版本 > 新版本，额外提示「本机已安装更新版本 0.0.5，这是**降级**安装，是否继续？」；
- 未命中则用默认路径，用户可改。

安装目录识别还带一层保险：覆盖前校验目标目录里存在 `KevinLauncher.exe`（或注册表指向它），
否则视为普通目录，**拒绝覆盖**并要求换路径，避免误删用户自己的文件夹。

## 3. 覆盖安装算法（可中断、可重试、不动用户数据）

1. **确认程序未运行**：枚举 `KevinLauncher.exe` 进程；若在运行，提示「请关闭后继续 / 由我关闭」。
2. **释放载荷到同卷暂存**：把安装程序内嵌的 zip 解到
   `<目标盘>\…\.kevin-install-<ver>\`（与目标同卷，最后一步是同卷改名，快且不易留半成品）。
   *先解压完再动目标目录*，因此解压失败时老版本毫发无损。
3. **记录旧文件清单**：读目标目录里的 `install.json`（安装时写入，含版本 + 文件列表 + 安装时间）。
   用它删除**新版已不存在**的旧文件；没有该文件时退化为"只覆盖不删除"。
4. **写入**：把暂存目录的文件逐个覆盖到目标目录，按字节上报进度（安装界面第 3 页）。
   - 文件被占用（程序未退干净）→ 报错并保留现场，可重试，不影响用户数据。
5. **补写系统项**：开始菜单快捷方式（必写，不询问）、桌面快捷方式（默认写）、
   `HKCU\…\Uninstall\KevinLauncher`（`DisplayName / DisplayIcon / DisplayVersion / Publisher /
   InstallLocation / EstimatedSize / UninstallString`）。
6. **写 `install.json`**（新版本 + 新文件清单 + `installedAt`）。
7. **清理**暂存目录，**启动**新版本，安装程序退出。

> 中断安全：任何一步失败都只是"程序目录处于中间态"，用户数据完好；重新运行安装程序即可修复
> （方案里再提供一个「修复安装」入口 = 重新执行第 4~6 步）。

## 4. 安装程序如何交付（自绘 UI 的载体）

**一个 exe，两种模式**：在 `electron-builder.yml` 增加 `portable` 目标，产物
`KevinLauncher-Setup-<version>.exe`（约 78 MB，7z 自解压），它就是**带安装界面的应用本体**：

- 运行它时 electron-builder 会设置 `PORTABLE_EXECUTABLE_FILE`；
  应用检测到该变量 → 进入**安装模式**（`#installer=1` → `Installer.tsx`），
  永远不会以"便携运行"方式工作；
- 安装完成后从**安装目录**启动的 `KevinLauncher.exe` 没有该变量 → 正常运行启动器。

好处：UI 与主程序**同源**（复用 `main.css` 的全部毛玻璃令牌、`Ring`、`confirm`），
不额外携带第二份 Electron，也不需要 Rust/WebView2 工具链。

### 安装界面（三页，全部自绘）

1. **位置**：标题、路径输入框（预填检测结果）、浏览按钮（`dialog.showOpenDialog`）、
   所需空间 / 剩余空间；若检测到老安装，显示覆盖安装提示与"将保留用户数据"。
2. **确认**：只读信息（开始菜单项、桌面快捷方式、卸载入口）+ 版本变化 `0.0.2 → 0.1.0`。
   **没有需要用户勾选的必选项**。
3. **进度**：毛玻璃卡片 + 主题色 `Ring` + 当前文件小字 + 已写入 / 总大小；完成后「完成 / 立即启动」。

（可选第 4 页：安装完成后询问是否立即启动。）

## 5. 卸载

复用同一个 exe：`UninstallString = "<安装目录>\KevinLauncher.exe" --uninstall`。
以 `--uninstall` 启动时显示毛玻璃卸载界面：确认 → 删除安装目录文件、开始菜单/桌面快捷方式、
注册表项、计划任务；**单独询问**是否删除 `%APPDATA%\kevin-launcher`（默认不删）。

## 6. 与更新的关系（代码复用）

一个共享模块 `main/services/install.ts`：

```
detectInstallation()                      # 第 2 节的检测
applyPayload(payloadDir, targetDir, opts) # 第 3 节的第 3~6 步，带进度回调
writeShortcuts(dir) / writeUninstallEntry(dir, version) / removeInstallation()
```

- 更新流程 = `downloadPayload` + `extractPayload` + `applyPayload`（现有代码改成调它，行为不变）；
- 安装流程 = `extractPayload`(内置 zip) + 检查程序未运行 + `applyPayload` + 快捷方式/注册表。

## 7. 实施步骤

| # | 工作 | 说明 |
| --- | --- | --- |
| 1 | 抽出 `install.ts`（检测 / 应用载荷 / 快捷方式 / 注册表 / 卸载），更新流程改为调用它 | 先重构，保证升级行为不回退 |
| 2 | electron-builder 增加 `portable` 目标；发布脚本产出 `KevinLauncher-Setup-<ver>.exe` | 配置 + 脚本 |
| 3 | 安装模式入口 `#installer=1` + `Installer.tsx` 三页 UI（复用 CSS / `Ring`） | 界面 |
| 4 | 主进程 `installer:*` IPC：选目录、空间检查、进程检查、安装（含进度）、启动 | 逻辑 |
| 5 | `--uninstall` 卸载模式 | 逻辑 + 界面 |
| 6 | 测试：`install.json` 差异删除、路径检测、快捷方式/注册表字符串、载荷应用幂等性 | 单测 |
| 7 | 文档：README 安装一节 + 截图 | 收尾 |

## 8. 取舍与风险

- **体积**：安装程序 ≈ 应用本体（约 78 MB），不含第二份运行时；比 NSIS 的 78 MB 基本持平。
- **首次多一次解压**：便携包启动需自解压到临时目录（约 2–5 秒），装完从安装目录运行无此开销。
- **未签名**：与现状一样会有 SmartScreen 提示（要消除需代码签名证书）。
- **权限**：默认装到 `%LOCALAPPDATA%\Programs`（按用户级，安装不需 UAC）；
  若用户选 `Program Files` 等需管理员，安装程序此时才请求提权。安装后的应用仍以管理员运行
  （启动游戏/计划任务自启都依赖这一点）。
- **备选**：若以后接受引入 Rust，可把同一套 HTML/CSS 移到 WebView2 引导器上，安装包可缩到约 10 MB + 载荷。
