# 自行绘制安装程序的方案（未实装）

> 现状：全新安装仍使用 electron-builder 的 **NSIS 向导**（可自选目录、自动写开始菜单/桌面快捷方式，
> 带深色品牌图）。本文是"整个安装界面完全自行绘制"的实现方案，**尚未实装**。

## 为什么不用 NSIS / Inno 自绘

NSIS、Inno Setup 的界面都是 Win32 控件 + 位图，只能换图标/背景图/文字颜色，
做不出启动器那种毛玻璃、圆角、主题色跟随的效果。Tauri/WebView2 引导器可以，但要多引入
Rust 工具链与第二套构建体系（本机也未安装 Rust）。

**本项目已经有一套完整的 Electron + React + 毛玻璃设计令牌**，让它自己当安装程序，UI 可以 100% 一致、
体积不增加第二份运行时，也不需要新工具链。

## 方案：便携包 + 安装模式（应用自己安装自己）

### 1. 打包

`electron-builder.yml` 增加 `portable` 目标（与现有 `nsis` 并存，验证后再决定是否移除 NSIS）：

```yaml
win:
  target:
    - nsis        # 保留，作为回退
    - portable    # 新增：自解压单文件，作为"安装程序"
```

产出的 `KevinLauncher-<version>-portable.exe` 约 78 MB（7z 自解压），运行时会：
解压到临时目录 → 以该目录为根启动应用，并设置环境变量
`PORTABLE_EXECUTABLE_FILE` / `PORTABLE_EXECUTABLE_DIR`。

### 2. 判断"安装模式"

应用启动时（主进程 `index.ts`）：

- 存在 `PORTABLE_EXECUTABLE_FILE`（便携运行）；
- 且安装标记不存在（注册表 `HKCU\...\Uninstall\KevinLauncher` 没有，或 `--install` 参数）；

则窗口加载渲染层并附加 `#installer=1`，由 `Installer.tsx` 取代 `App.tsx`
（与现有 `#viewer=<path>` 图像查看器同一套入口机制）。

### 3. 安装界面（复用现有 CSS，三页）

| 页 | 内容 |
| --- | --- |
| 1 位置 | 标题 + 「安装到」路径输入框（默认 `%LOCALAPPDATA%\Programs\KevinLauncher`）+ 浏览按钮（`dialog.showOpenDialog`）+ 需要空间/可用空间提示 |
| 2 确认 | 只读信息：将创建开始菜单项、桌面快捷方式、卸载入口；可选「开机自启（计划任务）」。**没有需要用户勾选的必选项** |
| 3 进度 | 毛玻璃卡片 + 主题色 `Ring` 环形进度 + 当前文件路径小字 + 已完成/总大小；完成后显示「完成」与「立即启动」 |

视觉：直接复用 `main.css` 的 `--glass` / `--brand` / `--on-brand` 等令牌，
错误/取消用现有的 `confirm` / 毛玻璃弹窗风格。

### 4. 安装动作（主进程，IPC `installer:*`）

1. **复制文件**：把便携解压目录（`path.dirname(process.execPath)`）整棵树复制到目标目录，
   边复制边按字节数上报进度（`transferred / total`）。
2. **快捷方式**：用 Electron 原生 `shell.writeShortcutLink` 写
   `%APPDATA%\Microsoft\Windows\Start Menu\Programs\KevinLauncher.lnk`（必写，不询问）
   与桌面 `.lnk`（可选）。
3. **卸载入口**：写 `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\KevinLauncher`
   （`DisplayName` / `DisplayIcon` / `DisplayVersion` / `Publisher` / `InstallLocation` /
   `EstimatedSize` / `UninstallString`），让它出现在「设置 → 应用」里。
4. **启动并退出**：`spawn(<dir>\KevinLauncher.exe)` 后关闭安装程序。

因为是自己复制文件，**没有 NSIS 静默安装的锁定文件问题**，进度也完全可控。

### 5. 卸载

不再单独分发卸载程序，而是复用同一个 exe：

```
UninstallString = "C:\...\KevinLauncher.exe" --uninstall
```

应用以 `--uninstall` 启动时显示毛玻璃卸载界面（确认 → 删除安装目录内文件、
开始菜单/桌面快捷方式、注册表项、计划任务；询问是否同时删除 `%APPDATA%\kevin-launcher` 数据）。

### 6. 与自动更新的关系

两者共用同一个 **zip 载荷**：
- 旧客户端升级 = 下载 zip → 解包到暂存 → 退出后换文件（现有流程，界面是左侧导航的进度环）；
- 全新安装 = 便携包内已经包含同一份文件树，只是多了"选目录 + 写快捷方式/注册表"这一步。

## 实施步骤与工作量

| # | 工作 | 说明 |
| --- | --- | --- |
| 1 | electron-builder 增加 `portable` 目标 | 配置改动，小 |
| 2 | 安装模式入口（`#installer=1`）+ `Installer.tsx` 三页 UI | 复用 CSS，中等 |
| 3 | 主进程 `installer:*`：选目录、复制（含进度）、快捷方式、注册表 | 中等，可单测复制/进度逻辑 |
| 4 | `--uninstall` 卸载模式 | 中等 |
| 5 | 发布脚本产出便携安装包并上传 | 小 |
| 6 | 测试：复制进度、快捷方式/注册表字符串、载荷校验 | 小 |

## 风险与取舍

- **首次运行多一次解压**：便携包启动需解压到临时目录（约 2–5 秒），安装完成后从安装目录运行则无此开销。
- **体积**：安装程序 ≈ 应用本体（约 78 MB），不额外携带第二份 Electron。
- **未签名**：与现状一样会有 SmartScreen 提示（需要代码签名证书才能消除）。
- **管理员权限**：安装本身是按用户级、不需要 UAC；安装后的应用仍以管理员运行（计划任务自启同样是静默提权）。
- **备选**：若以后接受引入 Rust，可把同一套 HTML/CSS 搬到 WebView2 引导器上，体积更小（约 10 MB + 载荷），
  UI 设计可以 1:1 复用。
