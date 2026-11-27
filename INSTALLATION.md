# 安装、试用与发布

## 安装正式版

在 GitHub Release 下载 `KevinLauncher-Installer-<版本>.exe` 并打开。安装界面可选择程序和数据位置。程序目录和数据目录必须分开。应用会在启动时检查正式更新，设置页也可以手动检查。[正式版本](https://github.com/KevinYuHere/KevinLauncher/releases/latest)

默认安装位置为 `%LOCALAPPDATA%\Programs\KevinLauncher`，用户数据默认保存在 `%APPDATA%\kevin-launcher`。迁移数据可从「设置 → 启动器设置」操作。卸载可从 Windows 已安装的应用列表进入，并选择是否保留用户数据。

## 本地 Beta

使用 Windows x64、Node.js 24 和 npm。解压验证使用 Windows 系统附带的 `tar.exe`，原生归档工具使用系统 .NET Framework 64 位目录中的 C# 编译器。依赖版本由仓库的 `package-lock.json` 固定，Electron 安装脚本校验对应运行库。

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install.ps1
npm run typecheck
npm test
npm run package:test
```

`npm run test:core` 运行与操作系统无关的核心回归。Windows CI 额外执行原生归档、快捷方式/安装相关的 Windows 测试，正式发布再运行同一批成品的安装与覆盖演练。`npm run lint` 校验变更空白、构建脚本语法和 JSON，现有文件按改动渐进整理。

本地命令通过正式版打包流程生成 `KevinLauncher-Installer-<版本>-beta.N.exe`。安装包和 SHA-256 校验记录位于本次命令打印的 `release-beta-*` 目录。加 `--keep-unpacked` 可保留解包程序供诊断。

以源码版本 `2.0.5` 为例，默认构建 `2.0.6-beta.1`，指定后续编号可用 `npm run package:test -- --version 2.0.6-beta.2`。Beta 版本写入本次构建的源码副本。安装包保存在本机。

Beta 使用安装器检测到的 KevinLauncher 程序和数据目录作为默认值。两处都可以在安装界面选择。覆盖安装沿用正式版的数据备份机制，并更新同一组快捷方式和卸载入口。Beta 继续检查正式更新，并在 `2.0.6` 等更高的正式版本发布后提供更新。

## KEVIN HUD

KEVIN HUD 是按应用独立配置的只读游戏浮层，入口在「模块管理 → 应用 → KEVIN HUD」。每个应用的 HUD 默认启用，启动游戏后在主显示器顶部居中短暂显示约 6 秒；「常驻」默认关闭。可以关闭 HUD、改为常驻、调整位置/材质/指标，或预览尚未保存的配置。指标不可用时显示 `--`。

浮层是独立的透明置顶窗口，不注入游戏、不挂接图形 API、不读取游戏内存，也不绕过反作弊。FPS 来自系统 ETW 的 Present 事件，GPU/CPU/内存/网络来自系统公开接口与计数器。权限不足、受保护进程、独占全屏或部分驱动/硬件下可能不显示或缺少指标，这是设计边界。

Windows 本地命令行冒烟（合成帧和隔离临时配置，不启动游戏，不读取用户数据）：

```powershell
node scripts/build-native-tools.mjs
npm run build
node scripts/verify-kevin-hud.cjs
"quit" | & .\out\native\KevinHud.exe
```

`predev` / `prebuild` / `pretest` 在 Windows 上调用 `scripts/build-native-tools.mjs`，复用原有归档工具构建并生成 `out/native/KevinHud.exe`；非 Windows 自动跳过，不调用仅限 Windows 的编译器。HUD 页面、预加载和两个原生工具都位于版本化 `out/` 内，随 `resources/app-<版本>/` 进入安装包和热更新载荷；Windows 打包的 `afterPack` 会校验这些文件在正确路径，正式版与 Beta 使用同一流程。

## 正式版本

1. 本地完成代码审阅和试用验证后，核对 `AGENTS.md` 的发版阻断项，将 `package.json`、锁文件根包和 `CHANGELOG.md` 首段更新到相同的正式版本号。运行 `npm run release:prepare` 检查当前提交、版本、本地阻断项和尚未使用的标签，它输出版本、提交和源码树。该检查只在本机存在 `AGENTS.md` 时读取阻断项；干净检出不要求这个被忽略的文件存在。
2. 将正式提交推送到 `main`，等待该准确提交的普通 push CI 成功。发布流程不依赖 PR、自动审阅或额外分支；代码审阅和发版阻断核对在本地完成。
3. 把匹配版本的正式标签指向该 `main` 提交并推送。发布门槛会重新校验正式标签指向、标签提交属于 `main`、同一提交的 `main` push CI，以及版本、锁文件、`CHANGELOG.md` 和随包文件的版本一致性。
4. GitHub Actions 在一次性的 Windows 环境中打包，验证同一份安装程序的全新安装、应用启动、上一正式版覆盖升级及数据保留，并逐文件对照更新 ZIP 与安装目录。通过后冻结安装程序、更新 ZIP、manifest 和各自哈希。公开 Release 只上传验证过的三个产物。
5. 产物冻结前遇到暂时的失败，可重跑原始标签 push 的 workflow。已经冻结时，原工作流重跑与手动重试都复用原始批次。手动重试从同一标签触发，并提供原始标签 push 的 Actions 运行 ID。批次保留 30 天，重试逐个核对草稿资产并补传缺失项。已冻结批次到期或出现同版本哈希冲突时，准备新版本。

GitHub 仓库可启用 [Immutable releases](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository) 锁定已公开资产。代码审阅在本地完成；正式发布门槛只核对 `main` 源码、版本和已验证产物。

在 Actions 中手动触发 `Windows Beta acceptance` 工作流可运行 Windows 安装验收，该工作流只接受 `main`。一次性 Windows 环境会验证 Beta 的自定义安装位置、全新安装、覆盖升级、启动、数据保留和卸载，并核对已发布正式版的旧实例升级路径。

调整启动壳、安装协议或持久化格式时，同步更新 `scripts/release-compatibility.json` 相应协议号。热更新会核对 Electron、宿主文件、协议和数据格式，遇到变化时使用完整安装程序。热更新启动连续两次失败会使用上一健康代码，保留同格式的用户数据和更新前备份。

随包版本载荷 `theme-policy.json` 放在 `app-<版本>/`，仅当顶层 `version` 与当前安装版本完全一致（SemVer）时生效。可选的 `intro` 对象含 `title`、`body`、`features`、`buttonLabel`，用于安装后显示一次的介绍；同文件还可带顶层主题字段 `themeId`、`areas`（`all` 或区域数组）、`mode`、`material`、`launchEffect`。主题与介绍分别按精确版本各应用一次，已应用版本保留在配置的 `themePolicyApplied` / `featureIntroApplied` 历史字段中（旧版单值 `themePolicyVersion` 会并入历史），介绍只在渲染进程确认显示后记录。`<userData>\theme-policy.json` 仅作本地/试用覆盖；版本不符的旧文件原样保留并跳过，不会挡住同版本的随包文件。

正式版与 Beta 的安装器和启动入口均会请求管理员权限。`KevinLauncher.exe` 会等待同目录的 `KevinLauncherRuntime.exe` 并传递退出码。Electron 浏览器继承管理员令牌，GPU 和渲染子进程继续使用 Chromium 沙箱。构建时检查安装器、启动入口与内部运行库的 Windows 清单。

## 可选网络验证

HTTP/2 与 HTTP/3 验证使用合成资产和本机端口。HTTP/3 需要 Python 3.14 环境，依赖版本见 `scripts/verify-hoyo-requirements.txt`。

```powershell
py -3.14 -m venv .venv-hoyo
.\.venv-hoyo\Scripts\python.exe -m pip install -r scripts/verify-hoyo-requirements.txt
npm run build
node scripts/verify-hoyo-http2.cjs
node scripts/verify-hoyo-http3.cjs
```

## 依赖检查

`npm audit --omit=dev` 检查 npm 运行依赖和被生产依赖引用的 peer，`npm audit` 另计开发和测试工具。2026-11-25 对锁文件的运行依赖告警为 0，Electron 下载器可选依赖 `undici` 已更新到 7.30.2。全量告警还包含 Vite/esbuild 开发服务、Vitest 测试服务及 electron-builder 的归档和发布工具。

Electron 内的 Chromium 与 Node.js 修复按 Electron 官方版本核对。验证脚本可用 `node_modules\.bin\electron.cmd scripts\verify-ui-trial.cjs` 运行离屏合成界面测试，正式 Windows 验收还要启动同一批安装过的程序。[Electron 44.11.6](https://releases.electronjs.org/release/v44.11.6)
