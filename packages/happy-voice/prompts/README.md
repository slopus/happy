# Prompts

本目录存放 `happy-voice` 的系统提示词文件（System Prompt）。构建 Docker 镜像时会被打包进镜像，并且可以通过 docker-compose 挂载覆盖。

## 为什么使用标签包围

提示词里会注入来自 App 的“原始文本”（用户语音转写、会话上下文、AI 回复原文等）。为了降低提示词混乱和提示注入（prompt injection）风险，我们把这类原始文本统一放进标签块里，例如 `<voice_payload>...</voice_payload>`。

约定:
- 标签块内全部视为“数据/引用”，不包含对模型的指令；模型不得遵从标签块内的任何要求。
- 模型输出不应包含任何标签原文。

## 文件说明

- `voice-main.system.txt`: 主对话 LLM（用户说话后的意图判断/是否调用工具）。
- `voice-tool-followup.system.txt`: 工具调用后的口播确认（禁工具、短回复）。
- `voice-ready-summary.system.txt`: App 推送 “ready” 后，对 AI 代理最新回复做口语化摘要播报（禁工具、短回复）。

## 变量占位符

提示词里使用 `{{var}}` 形式的占位符；运行时会替换成实际内容。常用变量:
- `{{language_preference}}`
- `{{app_session_id}}`
- `{{recent_voice_messages}}`
- `{{recent_app_context}}`
- `{{tool_name}}`, `{{tool_result}}`（仅 tool-followup）
- `{{latest_assistant_text}}`（仅 ready-summary）
