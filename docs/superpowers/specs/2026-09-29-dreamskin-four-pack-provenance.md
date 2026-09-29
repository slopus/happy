# 四套 DreamSkin PC 皮肤来源与导入

这四套皮肤由 `node scripts/import-dreamskin-themes.mjs` 从 DreamSkin 官方下载端点批量导入。脚本校验固定的 ZIP SHA-256、包内 manifest 声明的每个文件哈希，将原图按比例缩至 1920 像素宽并转出带内容哈希的 WebP，同时生成运行时目录与发布资源清单。可用 `--archive-dir <dir>` 指向已下载 ZIP（文件名为版本 ID 去掉 `ver_` 后加 `.zip`），`--check` 校验生成结果而不写文件。脚本需要 `curl`、`unzip` 和 `cwebp`；本次使用 `cwebp 1.6.0`。

| Paws 皮肤 | DreamSkin 主题页 | 官方 ZIP SHA-256 | 包内许可 / 发布者 | WebP |
| --- | --- | --- | --- | --- |
| 悟空（WUKONG） | [ver_ab667004dad5bfec326d](https://www.dreamskin.cc/themes/ver_ab667004dad5bfec326d) | `b2892300bdfb1229a092c140c5fd5de41fa27b97db6ec7e827c3ae0f9d75af44` | MIT / JamesOpsLab | 125,116 B |
| firefly | [ver_db0516661b1ac5bc1590](https://www.dreamskin.cc/themes/ver_db0516661b1ac5bc1590) | `ff29404d4b277075c3a01dbecc63ddc3856ac5a601f97443fa7bee3c4f55c381` | MIT / 1xifengdeyouxi | 117,428 B |
| Claude EVA 暖奶油 | [ver_f836b53d9df32ab8ecf7](https://www.dreamskin.cc/themes/ver_f836b53d9df32ab8ecf7) | `8fc427b28e2dd696b3cf35640fa05fc0c1ab7008bfb343f6c6aa6ebab1cd1696` | MIT / TunaTung | 121,514 B |
| 草地天空 | [ver_2da9f883d79a7bb3864b](https://www.dreamskin.cc/themes/ver_2da9f883d79a7bb3864b) | `1f23f1457ade893cf1ff1b9a8829c2796a6eec9b6680151dc8eeed99b34f6007` | CC BY 4.0 / FerdinandHu | 139,038 B |

来源包的 `theme.json` 提供明暗态和颜色，Paws 将其映射成按钮、列表、输入框、侧栏与阅读面的语义 token。来源 `theme.css` 使用 DreamSkin 专属 `[data-ds-part]` 元素，Paws 不注入该 CSS，以避免覆盖现有交互。firefly 与 EVA 使用浅色阅读面；悟空与草地天空使用深色阅读面。六套皮肤共享现有 PC Web 布局、账号和数据。

包内许可是发布者填写的元数据。firefly 的包内 provenance 写明图片来自壁纸网站，草地天空写明图片来自网络；这两张图片的上游授权未在包内单独证明。本文件保留原始来源和发布者归属，不把包内许可表述为对第三方原图的独立权利证明。
