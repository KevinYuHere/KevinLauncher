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
- 参考范围为启动器的布局与交互、米哈游三款游戏更新和预下载的可观察行为。KevinLauncher 独立实现这些功能。抽卡链接解析、游戏缓存读取和分页使用本项目的代码，记录格式参考游戏官方接口及 UIGF 规范。

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

### Hi3Helper.Plugin.Hypergryph

- 仓库：https://github.com/misaka10843/Hi3Helper.Plugin.Hypergryph
- 许可证：MIT
- 参考内容：明日方舟增量更新（v2）的流程与包格式——`get_latest_game` 的 `patch`（`cd_key` / `v2_patch_info_url` / `patches`）、`patch.json` 的 `local_path` 与 HDiff 差分应用、`delete_files.txt` 清理以及 `config.ini` 的加密格式。本项目为独立的 TypeScript 实现（WinZip AES 解密 + 流式解压 + `hpatchz` 调用），未直接复制其源代码。

```
MIT License

Copyright (c) 2024 misaka10843

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

### GlacierGlimmer/zmd-charge-plus

- 仓库：https://github.com/GlacierGlimmer/zmd-charge-plus
- 许可证：MIT（SPDX: MIT）
- 参考版本：`main` 分支提交 [`6204862581a7fd9a5ed4d9671a58d2bb4bd7926d`](https://github.com/GlacierGlimmer/zmd-charge-plus/commit/6204862581a7fd9a5ed4d9671a58d2bb4bd7926d)（v0.2.0，2026-11-07）
- 参考内容：Kevin HUD 的视觉语言（终末地风格的深色胶囊、荧光黄强调、细线分栏与状态标记）、交互（短时播报与常驻监控、按应用独立配置、选项预览、快捷键）以及可调参数（位置与锚点、尺寸、圆角、边框、透明度、材质、文字/图标颜色、字体缩放与偏移、显示器选择、入场方向/回弹/波纹、采样与展示时长等）。这些仅用于确认本项目的独立设计方向；Kevin HUD 的组件、样式、动画和主进程逻辑均由 KevinLauncher 以 TypeScript / React / Electron 独立实现，**未采用该项目的源代码、图像、图标、字体、动效素材、测试数据或其他文件**，也未引入其运行时依赖。该项目基于 QinAnze/zmd-charge；本项目的独立实现同样不包含上游项目的代码或素材。

```
MIT License

Copyright (c) 2026 GlacierGlimmer冰川雪貓

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
