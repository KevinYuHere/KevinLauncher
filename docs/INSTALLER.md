# 安装与升级的实现方案

> 状态：**升级流程已实装**（左侧导航环形进度条）；**自绘安装界面已实装**
> （`KevinLauncher-Installer-<版本>.exe`：portable 自解压包 + 安装模式，见下）。

## 0. 两条路径，两种 UI

| 场景 | 进度 UI | 是否需要用户操作 |
| --- | --- | --- |
| **A. 老应用升级** | 左侧导航「设置」上方的**主题色环形进度条**（有更新时先是图标） | 只需点一下开始 / 可暂停下载 |
| **B. 全新安装 或 手动下载安装包** | 自绘安装界面里的**主题色普通进度条** | 选安装路径 |

### A 的交互细节（已实现）

- 该位置平时不显示；**检测到新版本显示图标**（带小圆点），**点击即开始下载**；
- 下载中显示**主题色环形进度条**，**点击暂停 / 继续**；悬停**在右侧打开悬浮层**：
  第一行是进度百分比，**第二行小字模仿游戏下载界面**——左边「当前下载 / 总下载大小」，
  右边「预计剩余时间」；
- 下载完成自动进入**安装阶段**，同一个环显示**安装进度**（**不可暂停**，悬停小字改为
  「当前安装 / 总安装大小 · 请勿关闭」）；
- 全程**不阻塞界面**、**不打开安装程序、不需要任何选择**。

## 1. 关键前提：用户数据不在安装目录里

"覆盖安装不丢数据"是**结构性保证**，不靠小心：

```
<安装目录>                                  %APPDATA%\kevin-launcher\
├─ KevinLauncher.exe、*.dll、locales\ …        ├─ config.json        应用列表 / 界面 / 全局设置
└─ resources\ （见第 3 节）                     ├─ playtime.json      使用时长
                                              ├─ gacha\*.json       抽卡记录
                                              ├─ icons\ brand\ bg\  图标 / 背景
                                              ├─ predownload\       预下载暂存
                                              └─ launcher.log
```

安装/升级只写**左边**；右边只有卸载时**单独询问**才删（默认不删）。

## 2. 为什么"升级全程有 UI"需要改安装布局

Windows 上**正在运行的 exe 与已加载的 DLL 不能被覆盖**（也不能删除）。现在的做法是
"解包到暂存 → 退出应用 → 小助手换文件 → 重启"，退出到重启之间那段**没有 UI**。

要让升级**全程都能在老应用窗口里看到进度**，就不能去覆盖正在使用的文件，而应该
**把新版本写到一个新目录**，最后只改一个"指向"——这一步可以在应用运行时完成，
然后正常重启即可，**不存在无 UI 的阶段**。

## 3. 新的安装布局：运行时 + 版本化应用目录

```
<安装目录>\
├─ KevinLauncher.exe                       ┐
├─ *.dll、locales\、*.pak                  │ 运行时（Electron）：只在 Electron 升级时变
├─ resources\                              ┘
│  ├─ app\package.json      { "main": "loader.js" }   ← 固定入口，极小、几乎不变
│  ├─ app\loader.js                                   ← 读 version.txt，加载对应版本目录
│  ├─ app\version.txt                                 ← 当前版本（极小文件，运行时也能原子改写）
│  └─ app-0.0.3\ main.js / preload / renderer …       ← 真正的应用代码（每版都换）
└─ （旧版本目录在下次启动时清理）
```

- Electron 会自动把 `resources\app\package.json` 当作应用入口，`loader.js` 里
  `require('../app-' + version + '/main.js')` —— 入口稳定，应用代码可以整目录换。
- `resources\` 目录本身不被占用，**新建 `app-<新版本>\` 与改写 `version.txt` 都能在运行时完成**。

## 4. 升级流程（A，全程有 UI）

1. **检测**：右侧导航出现图标 → 点击开始；
2. **下载**：只下载**应用载荷**（`KevinLauncher-<ver>-app.zip`，只有应用代码，通常几 MB；
   多连接、可暂停/续传、SHA-256 校验）——环形进度条 + 悬停浮层；
3. **安装**：解包到 `resources\app-<新版本>\`，**不触碰任何被占用的文件**；
   环形显示安装进度（不可暂停）；
4. **切换**：原子写入 `resources\app\version.txt` → `app.relaunch()` + `app.exit()`
   → 窗口关闭并**立即以新版本打开**；
5. **清理**：下次启动时删除旧版本目录。

> 全过程只有第 4 步"重启"本身——这正是用户预期看到的动作，**没有任何隐藏的安装阶段**。
> 因为每次只写几 MB 的应用代码，升级比现在（110 MB 整包）快得多。

### 运行时变化时（Electron 升级，少数情况）

清单里记 `electron`；若与本机 `process.versions.electron` 不一致，则本次是**运行库更新**：
界面照常显示下载进度（这次下载的是**完整安装程序**，清单里带 `installerName/Size/Sha256`），
校验通过后**自动打开安装程序**并退出当前实例——安装程序会关闭本实例、覆盖安装并写入新版运行库。
这是 Windows 文件锁定的硬限制（运行中的 exe/DLL 无法就地替换），因此交给安装程序完成，
用户侧依然是"点一下更新 → 自动完成"。

## 5. 全新安装 / 手动安装（B，自绘界面）

### 载体：一个 exe，两种模式

`electron-builder` 增加 `portable` 目标，产物 `KevinLauncher-Installer-<version>.exe`（≈78 MB，
7z 自解压，内含运行时 + 应用）。运行时 electron-builder 会设置 `PORTABLE_EXECUTABLE_FILE`，
应用检测到即进入**安装模式**（`#installer=1` → `Installer.tsx`），**永不作为便携版运行**；
装完后从安装目录启动则无该变量、正常运行。

UI 与主程序**同源**（复用 `main.css` 的毛玻璃令牌、按钮、弹窗），不额外携带第二份 Electron。

### 界面（三页，进度用**主题色普通进度条**）

1. **位置**：路径输入框（默认 `%LOCALAPPDATA%\Programs\KevinLauncher`）+ 浏览按钮 +
   所需/剩余空间；检测到已有安装时**自动填入老路径**并提示
   「检测到已安装 **0.0.2**，将**覆盖安装**，**保留全部用户数据**」；
2. **确认**：只读信息（开始菜单项、桌面快捷方式、卸载入口、版本变化 `0.0.2 → 0.1.0`），
   **没有需要勾选的必选项**；
3. **进度**：卡片 + **主题色线性进度条** + 当前文件小字 + 已写入/总大小；
   完成后「完成 / 立即启动」。

（不用环形——环形只用于老应用升级。）

### 检测本机已有安装

按优先级：`HKCU\...\Uninstall\KevinLauncher` 的 `InstallLocation` →
`HKLM\...\Uninstall\KevinLauncher` → 默认路径下存在 `KevinLauncher.exe`。
命中即**预填老路径**；若老版本更新则提示这是**降级**安装。覆盖前校验目标目录确实含
`KevinLauncher.exe`（或注册表指向它），否则拒绝覆盖，避免误删用户自己的文件夹。

### 覆盖安装算法（可中断、可重试）

1. 确认 `KevinLauncher.exe` 未运行（否则提示关闭）；
2. 把内置 zip 解到**同卷暂存**（先解压完再动目标目录，失败则老版本毫发无损）；
3. 读目标目录的 `install.json`（上次安装写入的版本 + 文件清单），删除**新版已不存在**的旧文件；
4. 逐文件覆盖并上报**进度条**进度；
5. 写开始菜单（必写、不询问）/ 桌面快捷方式、`HKCU\…\Uninstall\KevinLauncher`
   （`DisplayName / DisplayIcon / DisplayVersion / Publisher / InstallLocation / EstimatedSize /
   UninstallString`）；
6. 写新的 `install.json` → 清理暂存 → 启动 → 安装程序退出。

任何一步失败只造成"程序目录中间态"，**用户数据完好**，重跑安装即可修复（另提供「修复安装」）。

## 6. 卸载

复用同一个 exe：`UninstallString = "<安装目录>\KevinLauncher.exe" --uninstall`。
毛玻璃卸载界面：删除安装目录、快捷方式、注册表项、计划任务；**单独询问**是否删除
`%APPDATA%\kevin-launcher`（默认不删）。

## 7. 代码组织与实施步骤

共享模块 `main/services/install.ts`：

```
detectInstallation()                        # 已有安装检测
applyPayload(payloadDir, targetDir, opts)   # 写文件 + 差异删除 + 进度回调
writeRuntime / writeAppVersion              # 运行时（安装式）与应用版本目录（升级式）
writeShortcuts(dir) / writeUninstallEntry(dir, version) / removeInstallation()
```

| # | 工作 |
| --- | --- |
| 1 | 打包改造：`afterPack` 把应用代码放到 `resources\app-<ver>\`，`resources\app\` 放 loader + version.txt |
| 2 | 升级流程改为"下载应用载荷 → 写新版本目录 → 改 version.txt → relaunch"，保留运行时变化的兜底路径 |
| 3 | `install.ts`：检测 / 应用载荷 / 快捷方式 / 注册表 / 卸载 |
| 4 | `portable` 目标 + `Installer.tsx` 三页 UI（**进度条**）+ `installer:*` IPC |
| 5 | `--uninstall` |
| 6 | 测试：版本目录切换、`install.json` 差异删除、路径检测、注册表/快捷方式字符串 |
| 7 | 文档：README 安装一节 |

## 8. 取舍与风险

- **体积**：安装程序 ≈ 应用本体（约 78 MB），无第二份运行时；升级载荷只有几 MB。
- **首次多一次解压**：便携包自解压到临时目录（约 2–5 秒），装完无此开销。
- **未签名**：与现状一样会有 SmartScreen 提示（需代码签名证书消除）。
- **权限**：默认装到 `%LOCALAPPDATA%\Programs`（按用户级，安装不需 UAC）；选 `Program Files`
  等才请求提权。安装后的应用仍以管理员运行（启动游戏 / 计划任务自启依赖它）。
- **运行时升级**：无法做到 100% 无 UI（Windows 文件锁），会有明确的"重启以完成"提示。
