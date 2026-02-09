# happy-voice

基于 LiveKit 的独立语音网关服务。将语音 Agent 的复杂性隔离在 `happy-app` 之外，保持 App 端集成轻量。

## 服务接口

- `POST /v1/voice/session/start`: 创建房间、分发 Agent、返回参与者 Token
- `POST /v1/voice/session/stop`: 停止会话并删除房间
- `GET /v1/voice/session/:gatewaySessionId/status`: 查询会话状态
- `POST /v1/voice/session/text`: 文本注入端点
- `POST /v1/voice/session/context`: 上下文注入端点
- `text/context` 更新通过房间数据通道（`happy.voice.text`、`happy.voice.context`）发布，由 Worker 消费
  - `happy.voice.context` 需要结构化 JSON 载荷（`happy-app-context-v1`），不接受原始文本

## 技术栈

- LiveKit Agents SDK (Node.js)
- Fastify + Zod (网关 API)
- LiveKit Server SDK (Token 签发和房间管理)

## 语音管线配置

语音管线（STT、LLM、TTS）通过环境变量配置，格式为 `provider/model:param`。

### STT (`AGENT_STT`)

| 值 | 行为 |
|----|------|
| `openai/gpt-4o-mini-transcribe:zh`（默认） | 直连 OpenAI，非流式，AgentSession 自动通过 VAD+StreamAdapter 处理 |
| `openai/gpt-4o-transcribe:zh` | 直连 OpenAI，更高精度，费用更高 |
| `assemblyai/universal-streaming:en` | 走 LiveKit Inference 代理 |
| `deepgram/nova-3:en` | 走 LiveKit Inference 代理 |

`openai/` 前缀使用 OpenAI 直连插件（`@livekit/agents-plugin-openai`），其他前缀作为 LiveKit Inference 字符串透传。

### LLM (`AGENT_LLM`)

| 值 | 行为 |
|----|------|
| `openai/gpt-4.1-mini`（默认） | 直连 OpenAI 插件 |
| `openai/gpt-5.2` | 直连 OpenAI 插件 + 自动注入 `reasoning_effort: low` |

始终通过 OpenAI 插件创建实例（去掉前缀后传入模型名）。推理模型（gpt-5.x、o 系列）会自动包装 `ReasoningLLM`。

### TTS (`AGENT_TTS`)

| 值 | 行为 |
|----|------|
| `cartesia/sonic-3:voice-id`（默认） | 直连 Cartesia 插件，语言 `zh` |
| `openai/tts-1:alloy` | 直连 OpenAI 插件，可选声音：alloy, ash, ballad, coral, echo 等 |
| `elevenlabs/eleven_multilingual_v2:voice-id` | 直连 ElevenLabs 插件，支持多语言 |
| 其他 | 走 LiveKit Inference 代理 |

`cartesia/`、`openai/`、`elevenlabs/` 前缀使用对应的直连插件，其他前缀作为 LiveKit Inference 字符串透传。

### Provider Keys

只需配置你选择的厂商对应的 Key：

```
OPENAI_API_KEY=       # STT (openai/) 和 LLM (openai/) 需要
CARTESIA_API_KEY=     # TTS (cartesia/) 需要
ELEVEN_API_KEY=       # TTS (elevenlabs/) 需要
```

## 本地开发

1. 复制环境变量模板：

```bash
cp packages/happy-voice/.env.example packages/happy-voice/.env.local
```

2. 安装依赖（在仓库根目录）：

```bash
yarn install
```

3. 启动 API 和 Worker：

```bash
yarn workspace happy-voice dev:api
yarn workspace happy-voice dev:worker
```

或在同一进程中同时运行：

```bash
yarn workspace happy-voice dev:all
```

## Docker

构建镜像：

```bash
docker build -t happy-voice packages/happy-voice
```

运行 API 模式：

```bash
docker run --rm -p 3040:3040 \
  --env-file packages/happy-voice/.env.local \
  happy-voice
```

运行 Worker 模式：

```bash
docker run --rm \
  --env-file packages/happy-voice/.env.local \
  happy-voice yarn start:worker
```

## 其他说明

- `VOICE_PUBLIC_KEY` 是所有非健康检查 API 调用的必需项。
- `AGENT_READY_PLAYOUT_MODE` 控制"Claude 完成工作"自动回复的播放方式：
  - `best_effort`（默认）：可被用户语音打断。
  - `strict`：ready 事件播放配置为不可打断。
- Ready 事件语音会先经过摘要步骤（而非直接朗读原始文本），使语音输出简洁、自然。
  - `AGENT_READY_SUMMARY_MODEL`（可选）：仅用于 ready 摘要的模型，默认使用 `AGENT_LLM`。
  - `AGENT_READY_SUMMARY_TIMEOUT_MS`：摘要请求超时时间。
  - `AGENT_READY_SUMMARY_INPUT_MAX_CHARS`：发送给摘要器的源文本最大字符数。
- 语句分割灵敏度可配置：
  - `AGENT_MIN_ENDPOINTING_DELAY_MS`：结束用户语句前的最小静默时间（增大此值可减少短暂停顿被误判为语句结束）。
  - `AGENT_MAX_ENDPOINTING_DELAY_MS`：端点延迟上限。
- LLM I/O 调试：
  - `AGENT_LOG_LLM_IO=true`（默认）在 Worker 日志中打印完整的 LLM 请求/响应。
  - 设置 `AGENT_LOG_LLM_IO=false` 禁用。
- Prompt 模板：
  - 默认模板文件位于 `packages/happy-voice/prompts/`，Docker 镜像中复制到 `/app/prompts/`。
  - 可通过挂载文件到 `/app/prompts/` 或设置以下变量来覆盖：
    - `PROMPT_VOICE_MAIN_FILE`
    - `PROMPT_VOICE_TOOL_FOLLOWUP_FILE`
    - `PROMPT_VOICE_READY_SUMMARY_FILE`
  - 模板支持 `{{variables}}`，运行时会替换为最近上下文和工具输出。
- 工具执行（`messageClaudeCode`、`manageSession` 等）通过可选的 Bridge 端点连接：
  - `TOOL_BRIDGE_BASE_URL`
  - `TOOL_BRIDGE_API_KEY`
- 在本 monorepo 中，将 `TOOL_BRIDGE_BASE_URL` 指向 `happy-server`，并在 server 端将 `VOICE_TOOL_BRIDGE_KEY` 设为与 `TOOL_BRIDGE_API_KEY` 相同的值。
