#!/usr/bin/env python3
"""
Happy Antigravity Python SDK Bridge Server

Maintains a persistent live Agent session with localharness / WebSocket connection.
Communicates with Happy CLI over stdin/stdout using NDJSON.
"""

import asyncio
import json
import os
import sys
import traceback
from typing import Any, Optional

try:
    from google.antigravity import Agent, LocalAgentConfig, CapabilitiesConfig, types
    from google.antigravity.types import CapabilitiesConfig
except ImportError as e:
    sys.stderr.write(f"google-antigravity SDK not found: {e}\n")
    sys.exit(1)


def emit(event: dict[str, Any]) -> None:
    """Emit an NDJSON event to stdout."""
    line = json.dumps(event)
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def log_debug(msg: str) -> None:
    sys.stderr.write(f"[agy-sdk-bridge] {msg}\n")
    sys.stderr.flush()


class SdkBridgeRunner:
    def __init__(self):
        self.agent: Optional[Agent] = None
        self.cwd: str = os.getcwd()
        self.model: Optional[str] = None
        self.conversation_id: Optional[str] = None
        self.api_key: Optional[str] = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")

    async def run(self):
        # Read the initial configuration line
        init_line = await asyncio.get_event_loop().run_in_executor(None, sys.stdin.readline)
        if not init_line:
            return

        try:
            init_req = json.loads(init_line.strip())
            self.cwd = init_req.get("cwd", self.cwd)
            self.model = init_req.get("model")
            self.conversation_id = init_req.get("conversation_id")
            if init_req.get("api_key"):
                self.api_key = init_req["api_key"]
        except Exception as e:
            emit({"event": "error", "message": f"Failed to parse init payload: {e}"})
            return

        config_kwargs: dict[str, Any] = {
            "workspaces": [self.cwd],
            "capabilities": CapabilitiesConfig(),
        }
        if self.conversation_id:
            config_kwargs["conversation_id"] = self.conversation_id
        if self.model:
            config_kwargs["model"] = self.model
        if self.api_key:
            config_kwargs["api_key"] = self.api_key

        config = LocalAgentConfig(**config_kwargs)

        try:
            async with Agent(config) as agent:
                self.agent = agent
                active_cid = getattr(agent, "conversation_id", None) or self.conversation_id or ""
                emit({"event": "ready", "conversation_id": active_cid})

                # Command processing loop
                while True:
                    line = await asyncio.get_event_loop().run_in_executor(None, sys.stdin.readline)
                    if not line:
                        break

                    line_str = line.strip()
                    if not line_str:
                        continue

                    try:
                        req = json.loads(line_str)
                    except json.JSONDecodeError as e:
                        emit({"event": "error", "message": f"JSON decode error: {e}"})
                        continue

                    action = req.get("action")
                    if action == "chat":
                        await self.handle_chat(req)
                    elif action == "cancel":
                        # Note: SDK cancellation
                        log_debug("Received cancel action")
                    elif action == "dispose" or action == "exit":
                        break
                    else:
                        emit({"event": "error", "message": f"Unknown action: {action}"})

        except Exception as e:
            emit({"event": "error", "message": f"Agent session error: {e}\n{traceback.format_exc()}"})

    async def handle_chat(self, req: dict[str, Any]):
        prompt = req.get("prompt", "")
        if not self.agent:
            emit({"event": "turn_complete", "status": "ERROR", "error": "Agent not initialized"})
            return

        try:
            response = await self.agent.chat(prompt)
            active_cid = getattr(self.agent, "conversation_id", None) or ""

            # Stream tokens
            async for token in response:
                if token:
                    emit({"event": "text_delta", "delta": token})

            # Check for usage metadata
            usage_dict = {}
            if hasattr(response, "usage") and response.usage:
                u = response.usage
                usage_dict = {
                    "input_tokens": getattr(u, "input_tokens", 0) or 0,
                    "output_tokens": getattr(u, "output_tokens", 0) or 0,
                    "thinking_tokens": getattr(u, "thinking_tokens", 0) or 0,
                }
                emit({"event": "token_count", **usage_dict})

            emit({
                "event": "turn_complete",
                "status": "SUCCESS",
                "conversation_id": active_cid,
            })

        except Exception as e:
            emit({
                "event": "turn_complete",
                "status": "ERROR",
                "error": str(e),
            })


def main():
    asyncio.run(SdkBridgeRunner().run())


if __name__ == "__main__":
    main()
