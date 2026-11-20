# Google Antigravity coding agent

用户要求新增 Google coding agent 并支持切换，缺少时安装和登录。正式 CLI 名称为 agy，Paws 内部身份为 antigravity，显示 Antigravity。

## 实现

沿用通用 ACP：paws acp antigravity 启动官方 agy acp。daemon 常规及 tmux 路径、SDK、机器安装检测、wire schema、会话身份、草稿持久化、按机器启用、切换选择器、图标与各语言品牌名同步接入。后台 PATH 缺少用户 bin 时解析 ~/.local/bin/agy。

模型使用此连接实际报告的 ACP catalog；发现前仅使用 default，不猜固定模型。权限沿用现有通用 ACP UI 边界，仅默认权限；不声明已支持界面切换 accept-edits/auto/plan，也不复制其他 agent 的风险档。原生 CLI 的版本探针走 agy --version，不查询猜测的 npm 包，更新由用户执行 agy update。

## 本机验证

- 官方安装脚本 SHA512 校验通过，安装 agy 1.5.13；Google 官方 OAuth 完成，CLI 确认已登录。授权材料不进入仓库。
- agy models 成功返回连接目录。无代理查询曾超时，沿用本机代理后成功；未改变全局代理。
- 真实 ACP initialize 和 session/new 成功，返回动态模型、权限和配置。
- 实际 Paws AcpBackend 启动 agy acp 并创建会话，发送仅回复 AGY_READY 的无工具请求，准确收到 AGY_READY 文本。
- CLI 39项、App 133项、OTA runtime 契约7项，共179项定向回归通过；App/CLI 完整 typecheck、wire/SDK/CLI 构建通过。SDK 重建中并行构建曾短暂缺失 dist；依赖完成后顺序重建及回归成功。
- i18n 独立审查：默认及全部10种语言品牌名一致，AST/独立翻译类型检查通过。

## CI 补修与全量复验

远端 workspace suite 暴露两个既有 MMKV 测试替身未实现 getBoolean，composeDraft 读取 discussing 时抛错。两个测试在本地复现后，仅补齐真实 API 类型行为，没有跳过断言；草稿往返新增 Antigravity 覆盖。独立复核确认未掩盖产品缺陷。App 完整566文件、5038项测试通过，完整 typecheck 通过。

首轮 SDK integration 在写入测试会话 agentState 时遇到 version-mismatch，失败用例为既有 Claude approval RPC fixture，不在新增 Antigravity 选择路径；已针对原 job 重跑，不以其余9项通过代替整套通过。

内置运行候选在实际活动包基础上只叠加21个目标文件，658份非目标源码摘要保持；保留活动补丁与历史能力差异，构建及38项目标回归通过。候选准备不等于已经激活。

## 交付边界

当前源码验证完成；合并、上线、执行端激活与 OTA 结果见后续交付记录；原生依赖和 runtime 不变。真实 Paws UI 切换、手机加载、重启恢复、附件和授权工具执行未验。跨 agent 的原生上下文转交沿原产品能力，不声明无损迁移到 Antigravity。浏览器经验已保存到 ego-ops/references/sites/antigravity/operations/authenticate-cli.md；全库知识校验被其他站点6个既有错误阻塞。

## 官方来源

- https://antigravity.google/docs/getting-started?tab=cli
- https://antigravity.google/docs/cli/acp/
- https://antigravity.google/cli/install.sh
- 品牌图标：https://antigravity.google/assets/image/antigravity-logo.png ，仅作品牌标识。
