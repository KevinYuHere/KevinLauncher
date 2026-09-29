# 上游映射表

记录 KevinLauncher 各模块对应的上游来源，便于上游更新时按图索骥手动跟进。

| KevinLauncher 模块 | 上游仓库 | 上游文件 | 最后同步 | 说明 |
|---|---|---|---|---|
| （M3）米哈游抽卡 API | Scighost/Starward | `src/Starward.Core/Gacha/*` | — | `getGachaLog` 分页、UIGF |
| （M3）抽卡 URL 捕获 | FufuLauncher/FufuLauncher.CaptureApp | — | — | 本地代理截图抽卡 URL |
| （M5）HoYoPlay 更新 | Scighost/Starward | `src/Starward.Core/HoYoPlay/*` | — | `getGameConfigs` / `getGamePackages` / Sophon |
| （M4）方舟抽卡 API | AceDroidX/arknights-gacha-export | `API.md`（仅文档） | — | 鹰角认证链 + `inquiry/gacha/*` |
| （M5）方舟更新 | misaka10843/Hi3Helper.Plugin.Arknights | — | — | 鹰角 CDN 版本/差分 |
| （M4/M5）方舟参考实现 | lTinchl/Xel-Launcher | `Helpers/*` | — | 多服、下载更新 |
| （M2）图库/截图 | Scighost/Starward | `src/Starward/Features/Screenshot/*` | — | 截图目录与浏览 |

## 约定

- 移植代码时在文件头注明：`// Derived from <repo>@<commit> — <path>`。
- 优先把易变项（endpoint、launcher_id、appCode、卡池规则）放入 `metadata/*.json`。
- 不拷贝无许可证项目（如 arknights-gacha-export）的代码，仅参考其接口文档。
