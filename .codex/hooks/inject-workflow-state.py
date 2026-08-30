#!/usr/bin/env python3
"""Trellis per-turn breadcrumb hook (UserPromptSubmit / BeforeAgent equivalent).

Runs on every user prompt. Resolves the active task through Trellis'
session-aware active task resolver and emits a short <workflow-state>
block reminding the main AI what task is active and its expected flow.

The emitted ``hookEventName`` field is platform-aware: most hosts expect
``UserPromptSubmit`` (Claude Code naming, also accepted by Cursor / Qoder /
CodeBuddy / Droid / Codex / Copilot wiring), but Gemini CLI 0.40.x renamed
its per-turn event to ``BeforeAgent`` and its schema validator rejects the
legacy name. ``_detect_platform`` picks the right value at runtime.
Breadcrumb text is pulled exclusively from workflow.md
[workflow-state:STATUS] tag blocks — workflow.md is the single source of
truth. There are no fallback dicts in this script: when workflow.md is
missing or a tag is absent, the breadcrumb degrades to a generic
"Refer to workflow.md for current step." line so users see (and fix)
the broken state instead of the hook silently masking it.

Which platforms register this hook is decided by SHARED_HOOKS_BY_PLATFORM
in templates/shared-hooks/index.ts — currently Claude, Codex, Gemini,
Qoder, Copilot, CodeBuddy, Droid, Kiro, Trae and ZCode. That table is the
source of truth; each listed platform's collect<Platform>Templates() pulls
this file into its template map through collectSharedHooks(), and a single
writer puts that map on disk at init time. Kiro wires this via the CLI
custom agent's ``hooks.userPromptSubmit`` and the IDE ``.kiro.hook``
``promptSubmit`` event; its output branch emits a plain-text breadcrumb
(Kiro adds hook stdout directly to the conversation context).

Silent exit 0 cases (no output):
  - No .trellis/ directory found (not a Trellis project)
  - task.json malformed or missing status
"""
from __future__ import annotations

import json
import os
import re
import sys
import queue
import threading
from pathlib import Path

# Force UTF-8 on stdin/stdout/stderr on Windows. Default codepage there is
# cp936 / cp1252 / etc. — non-ASCII content (Chinese task names, prd snippets)
# both in stdin (hook payload from host CLI) and stdout (our emitted blocks)
# raises UnicodeDecodeError / UnicodeEncodeError. Equivalent to `python -X utf8`
# but applied per-stream so we don't depend on host CLI's command wiring.
if sys.platform.startswith("win"):
    import io as _io
    for _stream_name in ("stdin", "stdout", "stderr"):
        _stream = getattr(sys, _stream_name, None)
        if _stream is None:
            continue
        if hasattr(_stream, "reconfigure"):
            try:
                _stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
            except Exception:
                pass  # Optional Windows stream setup; keep hook startup non-fatal.
        elif hasattr(_stream, "detach"):
            try:
                setattr(sys, _stream_name, _io.TextIOWrapper(_stream.detach(), encoding="utf-8", errors="replace"))
            except Exception:
                pass  # Optional Windows stream setup; keep hook startup non-fatal.
from typing import Optional


# Bootstrap notice for Codex while the session has no active task. Codex does not
# get the full SessionStart overview; this short reminder points the main session
# at the start skill once and leaves the per-turn state block compact.
CODEX_NO_TASK_BOOTSTRAP_NOTICE = """<trellis-bootstrap>
If you have not already loaded Trellis context this session, read the `trellis-start` skill once.
</trellis-bootstrap>"""


# ---------------------------------------------------------------------------
# CWD-robust Trellis root discovery (fixes hook-path-robustness for this hook)
# ---------------------------------------------------------------------------

def find_trellis_root(start: Path) -> Optional[Path]:
    """Walk up from start to find directory containing .trellis/.

    Handles CWD drift: subdirectory launches, monorepo packages, etc.
    Returns None if no .trellis/ found (silent no-op).
    """
    cur = start.resolve()
    while cur != cur.parent:
        if (cur / ".trellis").is_dir():
            return cur
        cur = cur.parent
    return None


# ---------------------------------------------------------------------------
# Active task discovery
# ---------------------------------------------------------------------------

def _detect_platform(input_data: dict) -> str | None:
    if isinstance(input_data.get("cursor_version"), str):
        return "cursor"
    # CLAUDE_PROJECT_DIR is a compatibility alias that several hosts set
    # alongside their own variable — CodeBuddy, ZCode and Trae all do. It must
    # therefore be checked LAST, or every one of them is detected as claude and
    # the context key becomes `claude_<their-session-id>`. That key does not
    # match the session file `task.py start` wrote under the host's real name,
    # so every turn reports no_task while the pointer exists on disk.
    # Observed on CodeBuddy IDE 4.10.4: session file `codebuddy_ae54840e….json`
    # alongside marker `update-check-claude_ae54840e….marker`, same id.
    env_map = {
        "ZCODE_PROJECT_DIR": "zcode",
        "CURSOR_PROJECT_DIR": "cursor",
        "CODEBUDDY_PROJECT_DIR": "codebuddy",
        "FACTORY_PROJECT_DIR": "droid",
        "GEMINI_PROJECT_DIR": "gemini",
        "QODER_PROJECT_DIR": "qoder",
        "KIRO_PROJECT_DIR": "kiro",
        "COPILOT_PROJECT_DIR": "copilot",
        "TRAE_PROJECT_DIR": "trae",
        # Last: the shared alias, only meaningful once no vendor key matched.
        "CLAUDE_PROJECT_DIR": "claude",
    }
    for env_name, platform in env_map.items():
        if os.environ.get(env_name):
            return platform
    script_parts = set(Path(sys.argv[0]).parts)
    if ".claude" in script_parts:
        return "claude"
    if ".cursor" in script_parts:
        return "cursor"
    if ".codex" in script_parts:
        return "codex"
    if ".gemini" in script_parts:
        return "gemini"
    if ".qoder" in script_parts:
        return "qoder"
    if ".codebuddy" in script_parts:
        return "codebuddy"
    if ".factory" in script_parts:
        return "droid"
    if ".kiro" in script_parts:
        return "kiro"
    if ".trae" in script_parts:
        return "trae"
    if ".zcode" in script_parts:
        return "zcode"
    return None


def _resolve_active_task(root: Path, input_data: dict):
    scripts_dir = root / ".trellis" / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    from common.active_task import resolve_active_task  # type: ignore[import-not-found]

    return resolve_active_task(root, input_data, platform=_detect_platform(input_data))


def get_active_task(root: Path, input_data: dict) -> Optional[tuple[str, str, str]]:
    """Return (task_id, status, source) from the current active task."""
    active = _resolve_active_task(root, input_data)
    if not active.task_path:
        return None

    task_dir = Path(active.task_path)
    if not task_dir.is_absolute():
        task_dir = root / task_dir
    if active.stale:
        return task_dir.name, f"stale_{active.source_type}", active.source

    task_json = task_dir / "task.json"
    if not task_json.is_file():
        return None
    try:
        data = json.loads(task_json.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None

    task_id = data.get("id") or task_dir.name
    status = data.get("status", "")
    if not isinstance(status, str) or not status:
        return None
    return task_id, status, active.source


# ---------------------------------------------------------------------------
# Breadcrumb loading: parse workflow.md, fall back to hardcoded defaults
# ---------------------------------------------------------------------------

# Supports STATUS values with letters, digits, underscores, hyphens
# (so "in-review" / "blocked-by-team" work alongside "in_progress").
_TAG_RE = re.compile(
    r"\[workflow-state:([A-Za-z0-9_-]+)\]\s*\n(.*?)\n\s*\[/workflow-state:\1\]",
    re.DOTALL,
)

def load_breadcrumbs(root: Path) -> dict[str, str]:
    """Parse workflow.md for [workflow-state:STATUS] blocks.

    Returns {status: body_text}. workflow.md is the single source of
    truth — there are no fallback dicts in this script. Missing tags
    (or a missing/unreadable workflow.md) fall back to a generic line
    in build_breadcrumb so users see the broken state and fix
    workflow.md, rather than the hook silently masking the issue.
    """
    workflow = root / ".trellis" / "workflow.md"
    if not workflow.is_file():
        return {}
    try:
        content = workflow.read_text(encoding="utf-8")
    except OSError:
        return {}

    result: dict[str, str] = {}
    for match in _TAG_RE.finditer(content):
        status = match.group(1)
        body = match.group(2).strip()
        if body:
            result[status] = body
    return result


def _read_trellis_config(root: Path) -> dict:
    """Load .trellis/config.yaml via the bundled trellis_config helper.

    The helper lives in .trellis/scripts/common; the hook lives outside the
    scripts tree, so we extend sys.path before importing.
    """
    scripts_dir = root / ".trellis" / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    try:
        from common.trellis_config import read_trellis_config  # type: ignore[import-not-found]
    except Exception:
        return {}
    try:
        return read_trellis_config(root)
    except Exception:
        return {}


DEFAULT_PROMPT_INJECTION_SKIP_KEYWORD = "no-trellis"


def _resolve_skip_keyword(config: dict) -> str:
    """Read `prompt_injection.skip_keyword` from parsed .trellis/config.yaml.

    Mirrors `common.config.get_prompt_injection_config()`. Defaults to
    "no-trellis"; "" disables the escape hatch entirely. A non-string value
    falls back to the default.
    """
    if isinstance(config, dict):
        section = config.get("prompt_injection")
        if isinstance(section, dict):
            raw = section.get("skip_keyword", DEFAULT_PROMPT_INJECTION_SKIP_KEYWORD)
            if isinstance(raw, str):
                return raw
    return DEFAULT_PROMPT_INJECTION_SKIP_KEYWORD


def prompt_has_skip_keyword(prompt: str, keyword: str) -> bool:
    """Case-insensitive, word-boundary match of `keyword` in `prompt`.

    Hyphen counts as a word char so "no-trellisx" / "xno-trellis" /
    "foo-no-trellis" don't match, but punctuation/whitespace boundaries do.
    Empty keyword never matches (disables the escape hatch).
    """
    if not keyword or not isinstance(prompt, str):
        return False
    pattern = r"(?<![\w-])" + re.escape(keyword) + r"(?![\w-])"
    return re.search(pattern, prompt, re.IGNORECASE) is not None


def _resolve_codex_dispatch_mode(config: dict) -> str:
    """Normalize `codex.dispatch_mode` from .trellis/config.yaml to "auto" or "inline".

    Defaults to `auto`. The legacy `sub-agent` value is an alias for `auto`.
    Any other explicit value (including invalid ones) falls back to `inline`
    without per-turn warnings. Shared by `_codex_mode_banner` (the per-turn
    banner) and `resolve_breadcrumb_key` (the breadcrumb tag key) so the two
    stay in lockstep.
    """
    mode = "auto"
    if isinstance(config, dict):
        codex_cfg = config.get("codex")
        if isinstance(codex_cfg, dict):
            cfg_mode = str(codex_cfg.get("dispatch_mode", mode)).strip().lower()
            if cfg_mode == "inline":
                mode = "inline"
            elif cfg_mode in ("auto", "sub-agent"):
                mode = "auto"
            else:
                mode = "inline"
    return mode


def _codex_mode_banner(config: dict) -> str:
    """Emit a `<codex-mode>` banner for the additionalContext payload.

    Reads `codex.dispatch_mode` from .trellis/config.yaml; defaults to
    `auto`, which dispatches Trellis sub-agents using native Codex context
    injection with a child-side fallback. This does not rely on inherited
    parent transcripts: `fork_turns` remains caller-controlled, and
    fresh-history sub-agents still receive their explicit delegated task and
    inherited session configuration. `inline` is an explicit opt-out; the
    legacy `sub-agent` value is an alias for `auto`. Invalid explicit values
    fall back to `inline` without per-turn warnings. The banner makes the
    active mode explicit to Codex AI per turn, complementing the workflow-state
    body which is per-status. Mode tells AI which dispatch protocol to follow;
    workflow-state tells AI what step it's at.
    """
    mode = _resolve_codex_dispatch_mode(config)
    if mode == "auto":
        meaning = (
            "auto: implement/check work defaults to Trellis sub-agents; native Codex "
            "context injection is preferred and child-side loading is the fallback. "
            "The main session still coordinates, clarifies, updates specs, commits, and finishes."
        )
    else:
        meaning = (
            "inline: the main session implements/checks directly; "
            "do not dispatch implement/check sub-agents."
        )
    return f"<codex-mode>{meaning}</codex-mode>"


def resolve_breadcrumb_key(
    status: str, platform: str | None, config: dict
) -> str:
    """Pick the breadcrumb tag key based on Codex dispatch_mode.

    Codex defaults to ``auto`` and therefore uses the ordinary ``<status>``
    breadcrumb for native SubagentStart dispatch with child-side fallback;
    it does not depend on an inherited parent transcript. ``inline`` selects
    the parallel ``<status>-inline`` tag; ``sub-agent`` remains an alias for
    ``auto``. Invalid explicit values fall back to inline without per-turn
    warnings.

    Non-codex platforms return the plain status unchanged.
    """
    if platform == "codex":
        mode = _resolve_codex_dispatch_mode(config)
        return f"{status}-inline" if mode == "inline" else status
    return status


def build_breadcrumb(
    task_id: Optional[str],
    status: str,
    templates: dict[str, str],
    source: str | None = None,
    breadcrumb_key: str | None = None,
) -> str:
    """Build the <workflow-state>...</workflow-state> block.

    - Known status (tag present in workflow.md) → detailed template body
    - Unknown status (no tag, or workflow.md missing) → generic
      "Refer to workflow.md for current step." line
    - `no_task` pseudo-status (task_id is None) → header omits task info
    """
    lookup_key = breadcrumb_key or status
    body = templates.get(lookup_key)
    if body is None and lookup_key != status:
        body = templates.get(status)
    if body is None:
        body = "Refer to workflow.md for current step."
    header = f"Status: {status}" if task_id is None else f"Task: {task_id} ({status})"
    return f"<workflow-state>\n{header}\n{body}\n</workflow-state>"


# ---------------------------------------------------------------------------
# Entry
# ---------------------------------------------------------------------------

def _load_hook_input() -> dict:
    """Read hook JSON without trusting host runners to close stdin.

    Kiro IDE `runCommand` and similar hook runners can leave stdin open while
    sending no payload. A plain `json.load(sys.stdin)` then blocks forever.
    Normal hook runners write the complete JSON payload and close stdin, so the
    short daemon read preserves that path while failing closed to `{}` for
    non-piping hosts.
    """
    result_queue: "queue.Queue[str | Exception]" = queue.Queue(maxsize=1)

    def _read() -> None:
        try:
            result_queue.put(sys.stdin.read())
        except Exception as exc:
            result_queue.put(exc)

    reader = threading.Thread(target=_read, daemon=True)
    reader.start()
    try:
        raw = result_queue.get(timeout=0.2)
    except queue.Empty:
        return {}

    if isinstance(raw, Exception):
        return {}
    try:
        data = json.loads(raw) if raw.strip() else {}
    except (json.JSONDecodeError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def main() -> int:
    if os.environ.get("TRELLIS_HOOKS") == "0" or os.environ.get("TRELLIS_DISABLE_HOOKS") == "1":
        return 0

    data = _load_hook_input()

    cwd_str = data.get("cwd") or os.getcwd()
    cwd = Path(cwd_str)

    root = find_trellis_root(cwd)
    if root is None:
        return 0  # not a Trellis project

    config = _read_trellis_config(root)
    if prompt_has_skip_keyword(data.get("prompt", ""), _resolve_skip_keyword(config)):
        return 0  # user opted out of the per-turn breadcrumb for this turn

    templates = load_breadcrumbs(root)
    platform = _detect_platform(data)
    task = get_active_task(root, data)
    if task is None:
        # No active task — still emit a breadcrumb nudging AI toward
        # trellis-brainstorm + task.py create when user describes real work.
        no_task_key = resolve_breadcrumb_key("no_task", platform, config)
        breadcrumb = build_breadcrumb(
            None, "no_task", templates, breadcrumb_key=no_task_key
        )
    else:
        task_id, status, source = task
        status_key = resolve_breadcrumb_key(status, platform, config)
        source_for_breadcrumb = None if platform == "codex" else source
        breadcrumb = build_breadcrumb(
            task_id, status, templates, source_for_breadcrumb, breadcrumb_key=status_key
        )
    if platform == "codex":
        parts: list[str] = []
        if task is None:
            parts.append(CODEX_NO_TASK_BOOTSTRAP_NOTICE)
        parts.append(_codex_mode_banner(config))
        parts.append(breadcrumb)
        breadcrumb = "\n\n".join(parts)

    # Kiro (CLI userPromptSubmit / IDE promptSubmit) adds a hook's stdout
    # directly to the conversation context — no JSON envelope. Emit the bare
    # breadcrumb text. Conditionally isolated: all other platforms keep the
    # hookSpecificOutput JSON path below unchanged.
    if platform == "kiro":
        print(breadcrumb)
        return 0

    # Gemini CLI 0.40.x rejects "UserPromptSubmit" — its per-turn event is
    # named "BeforeAgent". Other platforms (Claude/Cursor/Qoder/CodeBuddy/
    # Droid/Codex/Copilot) accept the original Claude-style name.
    hook_event_name = (
        "BeforeAgent" if platform == "gemini" else "UserPromptSubmit"
    )

    output = {
        "hookSpecificOutput": {
            "hookEventName": hook_event_name,
            "additionalContext": breadcrumb,
        }
    }
    print(json.dumps(output))
    return 0


if __name__ == "__main__":
    sys.exit(main())
