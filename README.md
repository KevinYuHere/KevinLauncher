# KevinLauncher

一个面向 Windows 的多应用启动器，内置米哈游三款游戏（原神 / 崩坏：星穹铁道 / 绝区零）与明日方舟的扩展模块。

> 本项目为**非官方第三方工具**，与 miHoYo / HoYoverse / Hypergryph 无任何关联。
> 功能与接口流程参考了 [Starward](https://github.com/Scighost/Starward)，详见 [THIRD-PARTY-NOTICES](./THIRD-PARTY-NOTICES.md)。

仓库地址：https://github.com/KevinYuHere/KevinLauncher

---

## 功能

### 核心一：精致界面 + 高度自定义

- 全局毛玻璃质感，细节动效细腻，操作不被打断。
- **每个应用都可独立设置外观**：主题色、亮/暗玻璃、背景图，以及背景的模糊与暗化程度；
  文字颜色**跟随主题色自动适配黑/白**，亮色主题下同样清晰。
- **任意程序**都能作为启动项：`exe` / `bat` / `cmd` / `ps1` / `lnk`。
- 图标可选择图片，或直接从 `exe / bat / lnk` 中提取，并支持**框选 + 缩放**裁剪，更换后立即生效。
- 界面字体、启动器图标、应用的启动方式与关闭行为，都可自行配置。
- **数据目录**可迁移（自动搬运全部数据），全部设置支持**一键导出 / 导入还原**。
- 安装程序也是**完全自绘的整页界面**（主题色流光背景 + 线性进度条），与主程序共用同一套设计。

### 核心二：原 · 铁 · 绝 · 舟 专属适配

- 支持**原神 / 崩坏：星穹铁道 / 绝区零 / 明日方舟**，并针对各游戏做专门适配。
- **抽卡记录**：卡池分类、5★/4★ 统计、保底计数、记录分页。原 / 铁 / 绝 从游戏 web 缓存读取，
  明日方舟走账号登录授权；抓取过程**不阻塞界面**，结果在顶部通知栏提示。
- **游戏更新与预下载**：米哈游 Sophon 全量 / 文件级增量 / 差分补丁（HDiffPatch），明日方舟分包更新。
  支持**多线程分块下载**、**断点续传**（已完成文件按大小 + MD5 跳过）、**校验失败自动重试**，
  以及**预下载 → 正式更新复用**（只下载缺失部分）。
- 游戏下载界面：进度环 + 百分比，悬停显示速度 / 已下载与总大小 / 预计剩余时间；点击可暂停 / 继续。

### 其他

- 使用时长统计（总时长、每日时长、热力图）与截图图库（缩略图按需生成、独立查看器窗口）。
- 单实例运行、托盘常驻、开机自启（计划任务，登录时静默提权）。
- 需要时会自动检查并在应用内升级到新版本，静默完成。

---

## 第三方与致谢

- 直接使用的第三方库：[Electron](https://github.com/electron/electron)、[React](https://github.com/facebook/react)、
  [fzstd](https://github.com/101arrowz/fzstd)、[@electron-toolkit](https://github.com/alex8088/electron-toolkit)、
  [electron-vite](https://github.com/alex8088/electron-vite)、[electron-builder](https://github.com/electron-userland/electron-builder)、
  [Vitest](https://github.com/vitest-dev/vitest) 等（均见 [THIRD-PARTY-NOTICES](./THIRD-PARTY-NOTICES.md)）。
- 参考的开源项目：
  - [Starward](https://github.com/Scighost/Starward)（MIT）— 米家启动器功能布局与接口流程的重要参考；
  - [HDiffPatch](https://github.com/sisong/HDiffPatch)（MIT）— 增量更新思路与 `hpatchz` 可执行文件来源。

---

## 免责声明

本项目仅供学习与研究使用，为**非官方**工具，与任何游戏厂商及其关联公司无关联，
也未获得其授权或认可。所有游戏名称、图标、素材等归各自权利人所有。

使用本工具调用非公开接口、读取本地缓存等行为可能违反游戏用户协议，
由此产生的任何后果（包括但不限于账号风险、数据损坏）由使用者自行承担。
请自行判断并在合规范围内使用。
