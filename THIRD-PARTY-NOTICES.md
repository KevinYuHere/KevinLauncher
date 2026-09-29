# 第三方组件与致谢 / Third-Party Notices

KevinLauncher 使用了以下第三方组件，并在实现过程中参考了以下开源项目。
本项目自身以 [MIT 许可证](./LICENSE) 发布。

---

## 一、直接使用的第三方库（运行时 / 构建）

以下依赖通过 npm 引入，均为 MIT（除 TypeScript 为 Apache-2.0）。完整清单见 `package.json`。

| 名称 | 许可证 | 用途 |
| --- | --- | --- |
| [Electron](https://github.com/electron/electron) | MIT | 应用运行时（主进程 / 渲染进程 / 预加载） |
| [React](https://github.com/facebook/react) / [ReactDOM](https://github.com/facebook/react) | MIT | 界面渲染 |
| [fzstd](https://github.com/101arrowz/fzstd) | MIT | zstd 解压（Sophon 清单与资源块） |
| [@electron-toolkit/preload](https://github.com/alex8088/electron-toolkit) | MIT | 预加载脚本桥接 |
| [@electron-toolkit/utils](https://github.com/alex8088/electron-toolkit) | MIT | 主进程工具函数 |
| [electron-vite](https://github.com/alex8088/electron-vite) | MIT | 开发 / 构建工具链 |
| [Vite](https://github.com/vitejs/vite) | MIT | 前端构建 |
| [electron-builder](https://github.com/electron-userland/electron-builder) | MIT | Windows 打包 |
| [TypeScript](https://github.com/microsoft/TypeScript) | Apache-2.0 | 类型系统 |
| [Vitest](https://github.com/vitest-dev/vitest) | MIT | 单元测试 |

### 随仓库分发的二进制

| 文件 | 项目 | 许可证 |
| --- | --- | --- |
| `resources/hpatchz.exe` | [HDiffPatch](https://github.com/sisong/HDiffPatch) | MIT |

---

## 二、参考的开源项目

> 说明：以下项目**仅作为功能设计、交互与接口（协议）流程的参考**。
> 本项目为 TypeScript / Electron 的独立实现，未直接复制其源代码。

### Starward

- 仓库：https://github.com/Scighost/Starward
- 许可证：MIT
- 参考内容：米哈游系列启动器的整体功能布局与交互；抽卡记录（含明日方舟寻访记录）的接口调用流程；游戏更新（Sophon）与预下载的流程设计；内置更新接口的 `launcher_id` 等公开参数。

```
MIT License

Copyright (c) 2023 Scighost

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### HDiffPatch

- 仓库：https://github.com/sisong/HDiffPatch
- 许可证：MIT
- 参考内容：增量（差分）更新的思路；使用其 `hpatchz` 可执行文件应用补丁。

```
MIT License

HDiffPatch
Copyright (c) 2012-2025 housisong

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
