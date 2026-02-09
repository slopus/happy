# happy-voice

Standalone Happy Voice gateway (built on LiveKit).
This service keeps voice agent complexity outside `happy-app`, so app integration can stay thin.

## What This Service Provides

- `POST /v1/voice/session/start`: create room, dispatch agent, return participant token.
- `POST /v1/voice/session/stop`: stop session and delete room.
- `GET /v1/voice/session/:gatewaySessionId/status`: inspect session status.
- `POST /v1/voice/session/text`: text injection endpoint (parity contract for app).
- `POST /v1/voice/session/context`: context injection endpoint (parity contract for app).
- `text/context` updates are published into the room data channel (`happy.voice.text`, `happy.voice.context`) and consumed by the worker.
  - `happy.voice.context` now requires structured JSON payload (`happy-app-context-v1`) instead of raw text.

## Tech Stack

- LiveKit Agents SDK (Node.js, official quickstart pattern)
- Fastify + Zod for the gateway API
- LiveKit Server SDK for token issuance and room management

## Local Setup

1. Copy env template:

```bash
cp packages/happy-voice/.env.example packages/happy-voice/.env.local
```

2. Install dependencies (from repo root):

```bash
yarn install
```

3. Run API and worker:

```bash
yarn workspace happy-voice dev:api
yarn workspace happy-voice dev:worker
```

Or run both in one process:

```bash
yarn workspace happy-voice dev:all
```

## Docker

Build image:

```bash
docker build -t happy-voice packages/happy-voice
```

Run API mode:

```bash
docker run --rm -p 3040:3040 \
  --env-file packages/happy-voice/.env.local \
  happy-voice
```

Run worker mode:

```bash
docker run --rm \
  --env-file packages/happy-voice/.env.local \
  happy-voice yarn start:worker
```

## Notes

- `VOICE_PUBLIC_KEY` is required for all non-health API calls.
- `AGENT_READY_PLAYOUT_MODE` controls how "Claude done working" auto-replies are played:
  - `best_effort` (default): can be interrupted by user speech.
  - `strict`: ready-event playout is configured as non-interruptible.
- Ready-event speech now runs a dedicated summarization step (instead of reading raw text), so spoken output is concise and conversational.
  - `AGENT_READY_SUMMARY_MODEL` (optional): model used only for ready summarization; defaults to `AGENT_LLM`.
  - `AGENT_READY_SUMMARY_TIMEOUT_MS`: timeout for summarization request.
  - `AGENT_READY_SUMMARY_INPUT_MAX_CHARS`: caps source text length sent to summarizer.
- Turn split sensitivity is configurable:
  - `AGENT_MIN_ENDPOINTING_DELAY_MS`: minimum silence before ending a user turn (increase this to reduce over-segmentation on short pauses).
  - `AGENT_MAX_ENDPOINTING_DELAY_MS`: upper bound for endpoint delay.
- LLM I/O debugging:
  - `AGENT_LOG_LLM_IO=true` (default) prints full LLM request/response payloads in worker logs.
  - Set `AGENT_LOG_LLM_IO=false` to disable payload logging.
- Prompt templates:
  - Default prompt files live in `packages/happy-voice/prompts/` and are copied into the Docker image under `/app/prompts/`.
  - Override by mounting your own files into `/app/prompts/` or by setting:
    - `PROMPT_VOICE_MAIN_FILE`
    - `PROMPT_VOICE_TOOL_FOLLOWUP_FILE`
    - `PROMPT_VOICE_READY_SUMMARY_FILE`
  - Templates support `{{variables}}` which are replaced at runtime with recent context and tool outputs.
- Tool execution (`messageClaudeCode`, `manageSession`, etc.) is wired through an optional bridge endpoint:
  - `TOOL_BRIDGE_BASE_URL`
  - `TOOL_BRIDGE_API_KEY`
- In this monorepo integration, point `TOOL_BRIDGE_BASE_URL` to `happy-server` and set `VOICE_TOOL_BRIDGE_KEY` on server to the same value as `TOOL_BRIDGE_API_KEY`.
