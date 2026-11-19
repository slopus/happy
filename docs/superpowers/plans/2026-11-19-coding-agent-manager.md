# Agent 图标轮换与按机器配置

用户已明确：使用当前Agent自身图标，点击循环，无Agent下拉；配置页控制参与项，参考Magpie并支持版本更新。

1. 复用上一版独立Agent/model状态。同步设置保存每台机器显式启用ID；无配置默认仅Codex，配置空列表保持空，不擅自启用其他Agent。
2. 新增共享CodingAgentIcon，Codex/Claude Code/OpenCode使用Magpie固定源码所用品牌SVG，保留来源/许可。轮换图标旁提供独立管理入口，模型目录仍限当前Agent。
3. 新增设置页，选机器、启用开关、已安装/当前版本/最新版本与更新按钮。只支持Paws已有执行器，不因Magpie支持更多而虚构执行能力。
4. 复用已有processRunner与加密machine RPC实现只读inspect和白名单update。只认已验证npm全局安装路径与原生自更新路径；来源不明提供手动更新说明。一次用户操作触发一次检查，无周期查询。更新锁、预览token/版本/路径复核、防重放、输出脱敏，完成后读回实际版本。现有会话不重启。
5. 回归覆盖启用/空配置/机器隔离/同模型跨Agent；RPC拒绝注入和过期预览、更新失败/锁/安装来源错配。完成wire/CLI构建、App typecheck与定向测试，再交付定向preview。实际更新用户本机Agent、切换daemon或正式合并发布分别受现有授权与工程契约约束；不以mock替代真实更新验收。

参考：Magpie 289184a409c0e38a3a0a5282dbde93b56da309ca internal/gui/assets/agentsmanager.js 和 internal/agent/cliupdate.go。仅借鉴设计与品牌资产，不复制其轮询。
