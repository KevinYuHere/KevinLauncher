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

## 正式版本

1. 本地试用验证通过后，核对 `AGENTS.md` 的发版阻断项，将 `package.json`、锁文件根包和 `CHANGELOG.md` 首段更新到相同的正式版本号。运行 `npm run release:prepare` 检查当前提交与版本，它输出版本、提交和源码树。
2. 推送正式变更分支，关联到目标为 `main` 的 PR。仓库需要启用 Codex 自动代码审阅和安全审阅。同步最新 `main` 后等待普通 CI，以及 Codex 对当前 PR head 完成两项审阅并清理未解决项。发布流程核对 GitHub Bot 身份、所属 PR 与两项审阅记录中的完整提交 SHA。若最新 head 没有触发审阅，在同一 PR 上发起 `@codex review` 和 `@codex security review`。
3. 合并后在 `main` 上等待该最终提交的 push CI 成功，再把匹配版本的正式标签指向该提交并推送。发布门槛会重新校验正式标签、PR head、合并前 base、最终提交、相同源码树、Codex 的完成结果和两次 CI。
4. GitHub Actions 在一次性的 Windows 环境中打包，验证同一份安装程序的全新安装、应用启动、上一正式版覆盖升级及数据保留，并逐文件对照更新 ZIP 与安装目录。通过后冻结安装程序、更新 ZIP、manifest 和各自哈希。公开 Release 只上传验证过的三个产物。
5. 产物冻结前遇到暂时的失败，可重跑原始标签 push 的 workflow。已经冻结时，原工作流重跑与手动重试都复用原始批次。手动重试从同一标签触发，并提供原始标签 push 的 Actions 运行 ID。批次保留 30 天，重试逐个核对草稿资产并补传缺失项。已冻结批次到期或出现同版本哈希冲突时，准备新版本。

GitHub 仓库可启用 [Immutable releases](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository) 锁定已公开资产。自动审阅的配置与触发方式见 [GitHub PR 的 Codex 审阅](https://learn.chatgpt.com/docs/third-party/github)。

同仓库 `verify/*` 分支的 PR 会触发 Windows 安装验收。在一次性 Windows 环境中验证 Beta 自定义安装位置，以及正式版的全新安装、上一正式版覆盖升级、启动和保留数据卸载。

调整启动壳、安装协议或持久化格式时，同步更新 `scripts/release-compatibility.json` 相应协议号。热更新会核对 Electron、宿主文件、协议和数据格式，遇到变化时使用完整安装程序。热更新启动连续两次失败会使用上一健康代码，保留同格式的用户数据和更新前备份。

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
