# 批注发送后的聊天展示

## 目标与范围

针对用户提供的多条批注截图，移除聊天正文中的提示词模板标签。保留现有聊天布局、消息气泡、复制/编辑入口；只调整 PC Web 批注消息正文。原生端继续使用原有的可读 displayText，不新增原生 UI。

参考 T3 Code `2fe7febc8d73dda7dcc912e8cca3cd65660a0c9d` 的 [AssistantCitationChip / ResponseCard](https://github.com/pingdotgg/t3code/blob/2fe7febc8d73dda7dcc912e8cca3cd65660a0c9d/apps/web/src/components/chat/AssistantCitationChip.tsx#L60) 与 [provider expansion](https://github.com/pingdotgg/t3code/blob/2fe7febc8d73dda7dcc912e8cca3cd65660a0c9d/packages/shared/src/assistantCitations.ts#L148)。本次按 Paws 的主题和 React Native Web 消息结构独立实现。

## 展示与数据

- 每条引用默认显示两行，点击或键盘操作原生 details/summary 展开/收起；完整原文保留在同一个文本节点中。
- 评论紧随对应引用，采用现有系统正文字体与 16px 字号；补充说明放在最后。文件引用只显示路径标签，不显示基线哈希和 JSON。
- normal/hover/open/focus 使用当前主题的 surface/surfacePressed/surfaceSelected/textLink；不另建色板。
- 新消息的 annotationReview 保存在加密消息 meta 中，经暂存、恢复、发送与消息归一化保留。原来的 text、displayText 和模型上下文不变，旧客户端可回退。
- 旧消息仅在完整匹配历史模板时转换，覆盖目前 10 种语言；普通 Markdown、缺项、错号、含原始文件版本 JSON 的消息回退原渲染。旧文本没有 source ID，不能据此跳回原消息。
- steer 沿现有 RPC 发送文本，不扩大 CLI 协议；通过历史模板读取器回退。历史模板未转义分隔符，评论中完整相同的模板在字节上无法区分，不能声称恢复了原始结构身份。
- 复制保留完整可读文本，编辑、分叉沿现有行为。没有把两行预览作为模型输入或复制内容。

## 验证与边界

14 个相关测试文件、234 项测试通过（含 OTA runtime 契约）。覆盖结构化 meta 的加密保存与归一化、暂存恢复、引用混合发送、历史模板、quote/comment 配对、展开 CSS 优先级、完整复制、普通消息回退、转义 HTML、ginghamDark 主题语义变量。全量 App TypeScript 检查通过。

独立评审通过。评审发现行内 line-clamp 阻止展开，已移入样式规则并增加 computed-style 回归；summary 的 accessible name 来自真实引文，title 仅作辅助说明。混合 @引用时的补充文字经现有解析器转换为可读名称，不暴露内部草稿协议。

截图需求已询问，尚未收到回复，未采集前后截图；没有真实浏览器、手机加载或用户设备的视觉验收证据。当前文件记录代码与自动化检查，不代表已经合并或上线。
