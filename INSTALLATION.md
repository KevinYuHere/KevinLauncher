# 安装、试用与发布

## 安装正式版

在 GitHub Release 下载 `KevinLauncher-Installer-<版本>.exe` 并打开。安装界面可选择程序和数据位置。程序目录和数据目录必须分开。应用会在启动时检查正式更新，设置页也可以手动检查。[正式版本](https://github.com/KevinYuHere/KevinLauncher/releases/latest)

默认安装位置为 `%LOCALAPPDATA%\Programs\KevinLauncher`，用户数据默认保存在 `%APPDATA%\kevin-launcher`。迁移数据可从「设置 → 启动器设置」操作。卸载可从 Windows 已安装的应用列表进入，并选择是否保留用户数据。

## 本地构建与试用

使用 Windows x64、Node.js 24 和 npm。解压验证使用 Windows 系统附带的 `tar.exe`，原生归档工具使用系统 .NET Framework 64 位目录中的 C# 编译器。依赖版本由仓库的 `package-lock.json` 固定，Electron 安装脚本校验对应运行库。

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install.ps1
npm run typecheck
npm test
npm run package:test
```

`npm run test:core` 运行与操作系统无关的核心回归。Windows CI 额外执行原生归档、快捷方式/安装相关的 Windows 测试，正式发布再运行同一批成品的安装与覆盖演练。`npm run lint` 校验变更空白、构建脚本语法和 JSON，现有文件按改动渐进整理。

试用包与 SHA-256 校验记录位于本次命令打印的 `release-trial-*` 目录。加 `--keep-unpacked` 可保留独立的解包程序供诊断。在 Windows 资源管理器中双击试用安装包或已安装的 `KevinLauncherTrial.exe`，Windows 会请求管理员权限。取消 UAC 后本次启动结束。

试用程序安装在 Windows 的 `Program Files\KevinLauncherTrial\<账户 SID>`。数据和试用快捷方式继续使用 `%LOCALAPPDATA%\KevinLauncherTrial`。旧试用程序留在原目录，建议从安装完成页或更新后的试用快捷方式启动新版。试用版的真实应用启动、游戏更新、开机自启和远端启动器更新均已隔离。试用卸载可运行对应安装目录下的 `KevinLauncherTrial.exe --uninstall`，卸载旧版时选择保留数据可供新版继续使用。

需要复制一份现有设置时，先退出试用版，然后把源目录明确传给 `scripts/trial.ps1 -DataDir <目录>`。加 `-Reseed` 会替换已有试用数据。复制完成后才会切换试用数据目录。也可在 `npm run package:test -- --theme-policy <文件>` 中指定当前版本的试用策略；正式包的主题策略来自版本对应的已跟踪文件。

要检查启动器更新界面，在试用数据目录中准备 `simulate-app-update.json` 后手动检查更新。要检查游戏更新界面，添加 `simulate.json`，内容可为 `{"appId":"应用 ID","mode":"both"}`，然后启动试用版。覆盖安装使用正式身份验证，由隔离的 Windows CI 完成。

## 正式版本

1. 本地试用验证通过后，核对 `AGENTS.md` 的发版阻断项，将 `package.json`、锁文件根包和 `CHANGELOG.md` 首段更新到相同的正式版本号。运行 `npm run release:prepare` 检查当前提交与版本，它输出版本、提交和源码树。
2. 推送正式变更分支，关联到目标为 `main` 的 PR。仓库需要启用 Codex 自动代码审阅和安全审阅。同步最新 `main` 后等待普通 CI，以及 Codex 对当前 PR head 完成两项审阅并清理未解决项。发布流程核对 GitHub Bot 身份、所属 PR 与两项审阅记录中的完整提交 SHA。若最新 head 没有触发审阅，在同一 PR 上发起 `@codex review` 和 `@codex security review`。
3. 合并后在 `main` 上等待该最终提交的 push CI 成功，再把匹配版本的正式标签指向该提交并推送。发布门槛会重新校验正式标签、PR head、合并前 base、最终提交、相同源码树、Codex 的完成结果和两次 CI。
4. GitHub Actions 在一次性的 Windows 环境中打包，验证同一份安装程序的全新安装、应用启动、上一正式版覆盖升级及数据保留，并逐文件对照更新 ZIP 与安装目录。通过后冻结安装程序、更新 ZIP、manifest 和各自哈希。公开 Release 只上传验证过的三个产物。
5. 产物冻结前遇到暂时的失败，可重跑原始标签 push 的 workflow。已经冻结时，原工作流重跑与手动重试都复用原始批次。手动重试从同一标签触发，并提供原始标签 push 的 Actions 运行 ID。批次保留 30 天，重试逐个核对草稿资产并补传缺失项。已冻结批次到期或出现同版本哈希冲突时，准备新版本。

GitHub 仓库可启用 [Immutable releases](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository) 锁定已公开资产。自动审阅的配置与触发方式见 [GitHub PR 的 Codex 审阅](https://learn.chatgpt.com/docs/third-party/github)。

同仓库 `verify/*` 分支的 PR 会触发 Windows trial acceptance。试用任务启动独立包两次，确认旧策略下首次应用及重启后保留手动设置。安装任务验证一次性 Windows 中的全新安装、上一正式版覆盖升级、启动和保留数据卸载。结果记录在 Actions 摘要，供审阅人员核对所测提交及工件哈希。

调整启动壳、安装协议或持久化格式时，同步更新 `scripts/release-compatibility.json` 相应协议号。热更新会核对 Electron、宿主文件、协议和数据格式，遇到变化时使用完整安装程序。热更新启动连续两次失败会使用上一健康代码，保留同格式的用户数据和更新前备份。

正式版与试用版的安装器和启动入口均声明管理员权限。`KevinLauncher.exe` 和 `KevinLauncherTrial.exe` 是各自的小型入口，会等待同目录的 `KevinLauncherRuntime.exe` 或 `KevinLauncherTrialRuntime.exe` 并传递退出码。Electron 浏览器继承管理员令牌，GPU 和渲染子进程继续使用 Chromium 沙箱。构建时检查安装器、启动入口与内部运行库的 Windows 清单。

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
