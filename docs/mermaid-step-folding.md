# Mermaid 长步骤折返接入记录

## 用户确认与范围

2026-10-17，用户确认 Step 1–8 三列四行的蛇形方向，要求迁入 Paws 并沉淀。保留 Mermaid + 官方 ELK 与此前认可的圆角节点、判断虚框、胶囊边标签、16px文字；不改已认可的 Marmot Runtime 图，不使用被拒绝的全局紧凑参数。

本轮仅实现布局，不实现内联上下拖动、不改变点击打开全屏的行为，不增加 Mermaid 非标准语法。复杂分组／分支／回路继续使用官方 ELK。

## 实现与复跑

- 共享实现：`packages/happy-app/sources/components/markdown/mermaidRuntime.ts`。
- 单测：相邻 `mermaidRuntime.test.ts`，覆盖拓扑顺序、保留尺寸／标签／marker、分组／分支／回路／短图／横图／特殊形状回退、minified factory 跨 realm 执行。
- 固定输入：`packages/happy-app/e2e/fixtures/mermaid/steps.mmd`，Web 与 Native 验收复用，不依赖会话历史或固定 A…K 节点 ID。
- 启动实际组件验收：`node packages/happy-app/e2e/fixtures/mermaid/serve.mjs`。默认／`shape=steps` 验证折返，`shape=approved` 验证 Marmot 不变，`shape=tall` 保留不折返特殊形状的裁切场景，`/native?theme=dark&shape=steps` 验证生产 Native HTML 与真实 CDN。
- 浏览器只使用 Ego。隔离夹具使用生产组件和主题，仅隔离无关原生模块；它不等于线上会话或真机。

## 实测结果

| Case | 通过标准 | 本轮结果 |
| --- | --- | --- |
| STEP-FOLD | 原步骤顺序、节点宽高与16px不变，分行折返，所有节点／边标签完整 | Web 深浅均927.75×528.6；11节点、3判断、10边；100%全屏阅读；无节点重叠 |
| MARMOT-UNCHANGED | 已认可的带组／回路图不变 | 深浅均1349.125×1035.8；11节点、13边、1分组，与接入前一致 |
| ELK-FALLBACK | 不符合折返条件的图保持原布局 | 单测覆盖7类；实际特殊形状长图仍高1374px，标准箭头夹具仍为横向 |
| WEBVIEW-SHARED | 无外部闭包、minify后序列化函数可执行 | minified跨realm单测通过；生产Native HTML＋真实CDN同样927.75×528.6、11节点／10边／16px（非真机） |

纵向基线约283.84×1291.2；折返没有缩小字号或节点宽高。实际组件前后截图已通过会话绑定截图助手上报。旧图适配比例与新图100%不同，只能用于阅读布局对照，不能据截图像素反推原始字号变化。

## 验收补充

最终全量单测：456个文件、3885项通过；runtime专项28项通过。TypeScript、脚本语法检查与diff空白检查通过。独立代码评审与PC静态截图评审均通过；review提出的双端marker／横向宽标签测试缺口已补齐并独立复核。没有Critical／Important问题。

实际浏览器发现并修正两项适配细节，均补入回归：形状helper会原地更改别名；边标签返回内容组而非定位外层。仅看节点已移动会漏掉旧标签坐标撑高viewBox，必须验证完整最终尺寸。

前图为2497×879图像、54%适配，后图为1440×900、100%适配；不作同尺度像素对比。Native HTML截图也已上报；这些证据不代表真机或完整生产会话。

最终已核验画面随源码保存，避免临时截图路径失效：[Web 全屏](assets/mermaid-step-folding/web-fullscreen.png)、[Native HTML（非真机）](assets/mermaid-step-folding/native-html.png)。PR复用这两张已确认范围的结果图，不新增未经要求的全站截图或同尺度前后对比。

本轮是静态图形几何变化，没有改变用户操作路径或手势契约；不扩展全站交互E2E或录像。真机、完整聊天会话以及新手势不在已验证范围。

## 发布边界

当前接入位于功能工作树，未合并、未部署Web、未发OTA。该分支此前的样式接入包含 `happy-app/package.json` 与 `pnpm-lock.yaml` 变化，按仓库 OTA 兼容门禁属于 native-sensitive；不能跳过兼容核对直接覆盖 preview。分类器保守命中不代表已证明新增原生能力或必须更换APK。后续发布应按仓库既有发布契约处理，不能将本地可运行表述为线上已生效。
