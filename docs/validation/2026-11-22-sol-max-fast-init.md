# Sol Max 与初始化 Fast 修复

## 复现与原因

- 正式新建页选择 GPT-6.1 Sol / Max，消息标签显示 max，执行端却记录 `Ignoring invalid effort from user message: max`。原生回合的 effort/reasoning_effort 为空。CLI 的旧六档白名单缺少 max/ultra。
- 初始化选择 Fast 时，旧活动 CLI 在首轮前切换服务档位并重启原生进程，随后恢复尚无 rollout 的空线程而失败。主线 PR816 已保护可替换空线程，本机旧运行包尚未继承；本次以另一会话刚激活的空线程修复包为基线完整继承。
- 首轮候选实测另发现：新会话已基础 hydrated，但模型目录尚未到达时，messageMeta 把已明确选中的 Fast 当作不支持而省略。界面仍显示 Fast，实际原生档位为 standard。此轮只算 Max 成功，不能算 Fast 成功。

## 实现

- CLI 统一远端强度校验，接收并原样下发 max/ultra；仍拒绝未知值，null/undefined 重置语义保持。
- Fast 的已选状态在新会话目录缺失/为空时保留；目录加载后仍拦截不支持 priority 的模型，不为未选用户或其他 Agent 自动启用 Fast。
- 空线程 Fast 的既有回归扩为 Max 组合，并保留连接失败/创建失败重试及有历史线程保护。

## 自动验证

- 红：旧六档校验 max/ultra 两项失败；新会话模型目录未到达时 Fast 两项失败。
- 绿：CLI 定向 113 项；App messageMeta / useSpawnSession / SessionConfigPanel / spawnSettings 75 项。
- CLI 全量初次未正确限制并发，9 项失败；限制 2 workers 后仅 Goal Board fs.watch 的嵌套资源创建用例超时。该文件独立复跑 30 通过、1 跳过。后续全量结果与 App 全量/typecheck 见最终补验。
- 候选以当时活动运行包完整复制，543 份非目标源码摘要一致；已保留原生恢复超时与导入标题等本机补丁。激活时 96 个既有 worker 身份保持、启动配置不变，旧会话不热升级。

## 真实验收与交付边界

- Ego 正式入口、Mac mini、新建页真实点击 Max/Fast，有限文本且不使用工具。第一轮原生 effort=max、reasoning_effort=max，回复 SOL_MAX_FAST_OK 且已完成；当轮 serviceTier=standard 暴露额外目录竞态，已如实记录并继续修复。
- 最终 Fast 与独立 Standard/Max 对照、上线版本、CI 与原生回合参数待补验；此文不是未完成步骤的通过声明。
- 无原生依赖或 runtime 变更；共享 JS 按既有 CI 发布 OTA。手机加载与其他执行机不在本次真实浏览器验收范围。
