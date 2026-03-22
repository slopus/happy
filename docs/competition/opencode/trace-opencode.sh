#!/usr/bin/env bash
#
# trace-opencode.sh — reusable harness for tracing OpenCode's protocol
#
# Sets up an isolated OpenCode server, runs scripted flows against it,
# and captures raw request/response/SSE logs.
#
# Usage:
#   ./scripts/trace-opencode.sh [flow ...]
#
#   flows: permission, media, subtask, question, todo, all (default: all)
#
# Prerequisites:
#   - OpenCode source checkout at ../happy-adjacent/research/opencode
#   - bun installed
#   - Auth file at ~/.local/share/opencode/auth.json (with at least one provider key)
#
# Output:
#   docs/competition/opencode/traces/<timestamp>/
#     setup.json          — runtime config used
#     flow-<name>.json    — per-flow request/response/events log
#     sse-raw.log         — raw SSE stream dump
#
set -euo pipefail

# ── Config ──────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OPENCODE_SRC="${OPENCODE_SRC:-$REPO_ROOT/../happy-adjacent/research/opencode}"
AUTH_SOURCE="${AUTH_SOURCE:-$HOME/.local/share/opencode/auth.json}"
LAB_RAT_DIR="$REPO_ROOT/environments/lab-rat-todo-project"
PORT="${OPENCODE_TRACE_PORT:-0}"
PROVIDER="${OPENCODE_TRACE_PROVIDER:-openai}"
MODEL="${OPENCODE_TRACE_MODEL:-gpt-4.1-mini}"

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
TRACE_DIR="$REPO_ROOT/docs/competition/opencode/traces/$TIMESTAMP"
TMPROOT=""
SERVER_PID=""
SSE_PID=""

# ── Helpers ─────────────────────────────────────────────────

cleanup() {
  echo ""
  echo "=== cleanup ==="
  [ -n "$SSE_PID" ] && kill "$SSE_PID" 2>/dev/null || true
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  [ -n "$TMPROOT" ] && rm -rf "$TMPROOT"
  echo "traces saved to: $TRACE_DIR"
}
trap cleanup EXIT

die() { echo "ERROR: $*" >&2; exit 1; }

check_prereqs() {
  [ -d "$OPENCODE_SRC/packages/opencode/src" ] || die "OpenCode source not found at $OPENCODE_SRC"
  command -v bun >/dev/null || die "bun not installed"
  [ -f "$AUTH_SOURCE" ] || die "auth file not found at $AUTH_SOURCE"
  [ -d "$LAB_RAT_DIR" ] || die "lab-rat project not found at $LAB_RAT_DIR"
  command -v jq >/dev/null || die "jq not installed"
  command -v curl >/dev/null || die "curl not installed"
}

# POST/GET with logging
api() {
  local method="$1" path="$2" flow="$3"
  shift 3
  local url="http://127.0.0.1:$PORT$path"
  local log_file="$TRACE_DIR/flow-${flow}.jsonl"

  local response
  if [ "$method" = "GET" ]; then
    response=$(curl -sS -w '\n{"_http_code":%{http_code}}' \
      -H "x-opencode-directory: $LAB_RAT_DIR" \
      "$url" "$@" 2>&1)
  else
    response=$(curl -sS -w '\n{"_http_code":%{http_code}}' \
      -X "$method" \
      -H "Content-Type: application/json" \
      -H "x-opencode-directory: $LAB_RAT_DIR" \
      "$url" "$@" 2>&1)
  fi

  # Log the raw exchange
  local entry
  entry=$(jq -cn \
    --arg method "$method" \
    --arg path "$path" \
    --arg time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg response "$response" \
    '{method: $method, path: $path, time: $time, response: $response}')
  echo "$entry" >> "$log_file"

  # Return just the response body (strip the http_code line)
  echo "$response" | head -n -1
}

wait_for_server() {
  echo "waiting for server on port $PORT..."
  local tries=0
  while ! curl -s "http://127.0.0.1:$PORT/path" \
    -H "x-opencode-directory: $LAB_RAT_DIR" >/dev/null 2>&1; do
    tries=$((tries + 1))
    [ "$tries" -gt 30 ] && die "server did not start within 30s"
    sleep 1
  done
  echo "server ready"
}

wait_for_idle() {
  local session_id="$1"
  local timeout="${2:-60}"
  local start=$SECONDS
  echo "  waiting for session $session_id to go idle..."
  while true; do
    local elapsed=$(( SECONDS - start ))
    [ "$elapsed" -gt "$timeout" ] && die "session did not go idle within ${timeout}s"

    # Check the SSE log for idle status
    if grep -q "\"session.status\"" "$TRACE_DIR/sse-raw.log" 2>/dev/null; then
      local last_status
      last_status=$(grep "\"session.status\"" "$TRACE_DIR/sse-raw.log" | tail -1 | \
        sed 's/^data: //' | jq -r '.properties.status.type // empty' 2>/dev/null || true)
      if [ "$last_status" = "idle" ]; then
        echo "  session idle"
        return 0
      fi
    fi
    sleep 0.5
  done
}

reply_permission() {
  local flow="$1" reply="${2:-once}"
  echo "  checking for pending permissions..."
  sleep 1  # give it a moment
  local perms
  perms=$(api GET "/permission" "$flow")
  local perm_id
  perm_id=$(echo "$perms" | jq -r '.[0].id // empty' 2>/dev/null || true)
  if [ -n "$perm_id" ]; then
    echo "  replying '$reply' to permission $perm_id"
    api POST "/permission/$perm_id/reply" "$flow" \
      -d "{\"reply\":\"$reply\"}"
  else
    echo "  no pending permissions"
  fi
}

reply_question() {
  local flow="$1"
  echo "  checking for pending questions..."
  sleep 1
  local questions
  questions=$(api GET "/question" "$flow" 2>/dev/null || echo "[]")
  local q_id
  q_id=$(echo "$questions" | jq -r '.[0].id // empty' 2>/dev/null || true)
  if [ -n "$q_id" ]; then
    # auto-answer with the first option for each question
    local answers
    answers=$(echo "$questions" | jq -c '[.[0].questions[] | [.options[0].label]]')
    echo "  replying to question $q_id with: $answers"
    api POST "/question/$q_id/reply" "$flow" \
      -d "{\"answers\":$answers}"
  else
    echo "  no pending questions"
  fi
}

# ── Setup ───────────────────────────────────────────────────

check_prereqs

# Create isolated temp root
TMPROOT=$(mktemp -d /tmp/opencode-trace.XXXXXX)
mkdir -p "$TMPROOT"/{share/opencode,cache,config,state,profile}
cp "$AUTH_SOURCE" "$TMPROOT/share/opencode/auth.json"

# Create output dir
mkdir -p "$TRACE_DIR"

echo "=== OpenCode Protocol Tracing ==="
echo "  source:    $OPENCODE_SRC"
echo "  lab-rat:   $LAB_RAT_DIR"
echo "  tmproot:   $TMPROOT"
echo "  output:    $TRACE_DIR"
echo ""

# Find a free port if PORT=0
if [ "$PORT" = "0" ]; then
  PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("",0)); print(s.getsockname()[1]); s.close()')
fi

# Save setup info
jq -n \
  --arg opencode_src "$OPENCODE_SRC" \
  --arg lab_rat "$LAB_RAT_DIR" \
  --arg tmproot "$TMPROOT" \
  --arg port "$PORT" \
  --arg provider "$PROVIDER" \
  --arg model "$MODEL" \
  --arg timestamp "$TIMESTAMP" \
  '{opencode_src: $opencode_src, lab_rat: $lab_rat, tmproot: $tmproot,
    port: ($port | tonumber), provider: $provider, model: $model,
    timestamp: $timestamp}' \
  > "$TRACE_DIR/setup.json"

# ── Start server ────────────────────────────────────────────

echo "=== starting opencode server on port $PORT ==="

XDG_DATA_HOME="$TMPROOT/share" \
XDG_CACHE_HOME="$TMPROOT/cache" \
XDG_CONFIG_HOME="$TMPROOT/config" \
XDG_STATE_HOME="$TMPROOT/state" \
OPENCODE_CONFIG_DIR="$TMPROOT/profile" \
OPENCODE_DB="$TMPROOT/share/opencode/opencode.db" \
bun run --cwd "$OPENCODE_SRC/packages/opencode" --conditions=browser src/index.ts \
  serve --hostname 127.0.0.1 --port "$PORT" --print-logs --log-level DEBUG \
  > "$TRACE_DIR/server.log" 2>&1 &
SERVER_PID=$!

wait_for_server

# Start SSE listener
echo "=== starting SSE listener ==="
curl -sS -N "http://127.0.0.1:$PORT/event" \
  -H "x-opencode-directory: $LAB_RAT_DIR" \
  > "$TRACE_DIR/sse-raw.log" 2>&1 &
SSE_PID=$!
sleep 0.5

# ── Parse flow arguments ────────────────────────────────────

FLOWS=("$@")
[ ${#FLOWS[@]} -eq 0 ] && FLOWS=(all)

run_flow() {
  local name="$1"
  case "$name" in
    all)
      run_flow permission
      run_flow media
      run_flow subtask
      run_flow todo
      ;;

    permission)
      echo ""
      echo "=== Flow: permission ==="
      echo "  creating session with edit ask rule..."
      local session
      session=$(api POST "/session" permission \
        -d "{\"title\":\"trace-permission\",\"permission\":[{\"permission\":\"edit\",\"pattern\":\"*\",\"action\":\"ask\"}]}")
      local sid
      sid=$(echo "$session" | jq -r '.id')
      echo "  session: $sid"

      echo "  sending prompt..."
      api POST "/session/$sid/prompt_async" permission \
        -d "{\"agent\":\"build\",\"model\":{\"providerID\":\"$PROVIDER\",\"modelID\":\"$MODEL\"},\"parts\":[{\"type\":\"text\",\"text\":\"Create a file named TRACE_PERM.md with exactly one line: permission trace. Then reply with one short sentence.\"}]}"

      sleep 2
      reply_permission permission once
      wait_for_idle "$sid" 60

      echo "  fetching messages..."
      api GET "/session/$sid/message" permission

      echo "  fetching children..."
      api GET "/session/$sid/children" permission

      echo "  flow: permission done"
      ;;

    media)
      echo ""
      echo "=== Flow: media ==="
      local session
      session=$(api POST "/session" media \
        -d '{"title":"trace-media"}')
      local sid
      sid=$(echo "$session" | jq -r '.id')
      echo "  session: $sid"

      # Test with a tiny inline PNG (1x1 red pixel)
      local tiny_png="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=="

      echo "  sending prompt with inline image..."
      api POST "/session/$sid/prompt_async" media \
        -d "{\"agent\":\"build\",\"model\":{\"providerID\":\"$PROVIDER\",\"modelID\":\"$MODEL\"},\"parts\":[{\"type\":\"text\",\"text\":\"Describe the attached image in one short sentence. Do not use any tools.\"},{\"type\":\"file\",\"mime\":\"image/png\",\"filename\":\"tiny.png\",\"url\":\"data:image/png;base64,$tiny_png\"}]}"

      wait_for_idle "$sid" 60

      echo "  fetching messages..."
      api GET "/session/$sid/message" media

      echo "  flow: media done"
      ;;

    subtask)
      echo ""
      echo "=== Flow: subtask ==="
      local session
      session=$(api POST "/session" subtask \
        -d '{"title":"trace-subtask"}')
      local sid
      sid=$(echo "$session" | jq -r '.id')
      echo "  session: $sid"

      echo "  sending prompt with @explore agent..."
      api POST "/session/$sid/prompt_async" subtask \
        -d "{\"agent\":\"build\",\"model\":{\"providerID\":\"$PROVIDER\",\"modelID\":\"$MODEL\"},\"parts\":[{\"type\":\"text\",\"text\":\"Find the main files in this tiny project and report back briefly.\"},{\"type\":\"agent\",\"name\":\"explore\"}]}"

      wait_for_idle "$sid" 90

      echo "  fetching messages..."
      api GET "/session/$sid/message" subtask

      echo "  fetching children..."
      api GET "/session/$sid/children" subtask

      echo "  flow: subtask done"
      ;;

    todo)
      echo ""
      echo "=== Flow: todo ==="
      local session
      session=$(api POST "/session" todo \
        -d '{"title":"trace-todo"}')
      local sid
      sid=$(echo "$session" | jq -r '.id')
      echo "  session: $sid"

      echo "  sending prompt asking to create todos..."
      api POST "/session/$sid/prompt_async" todo \
        -d "{\"agent\":\"build\",\"model\":{\"providerID\":\"$PROVIDER\",\"modelID\":\"$MODEL\"},\"parts\":[{\"type\":\"text\",\"text\":\"Look at this project and create a todo list with 3 items about improvements. Use the todowrite tool.\"}]}"

      # todowrite might need permission
      sleep 3
      reply_permission todo once
      wait_for_idle "$sid" 60

      echo "  fetching messages..."
      api GET "/session/$sid/message" todo

      echo "  fetching todos..."
      api GET "/session/$sid/todo" todo

      echo "  flow: todo done"
      ;;

    question)
      echo ""
      echo "=== Flow: question ==="
      local session
      session=$(api POST "/session" question \
        -d '{"title":"trace-question"}')
      local sid
      sid=$(echo "$session" | jq -r '.id')
      echo "  session: $sid"

      echo "  sending prompt that should trigger question tool..."
      api POST "/session/$sid/prompt_async" question \
        -d "{\"agent\":\"build\",\"model\":{\"providerID\":\"$PROVIDER\",\"modelID\":\"$MODEL\"},\"parts\":[{\"type\":\"text\",\"text\":\"I want to set up a database for this project. Ask me which database I prefer before proceeding. Use the question tool.\"}]}"

      sleep 3
      reply_question question
      # might also need permission for the question tool
      reply_permission question once
      wait_for_idle "$sid" 60

      echo "  fetching messages..."
      api GET "/session/$sid/message" question

      echo "  flow: question done"
      ;;

    *)
      die "unknown flow: $name (available: permission, media, subtask, todo, question, all)"
      ;;
  esac
}

# ── Run flows ───────────────────────────────────────────────

for flow in "${FLOWS[@]}"; do
  run_flow "$flow"
done

echo ""
echo "=== all flows complete ==="
echo ""
echo "Output:"
echo "  $TRACE_DIR/setup.json        — runtime config"
echo "  $TRACE_DIR/flow-*.jsonl      — per-flow request/response logs"
echo "  $TRACE_DIR/sse-raw.log       — raw SSE event stream"
echo "  $TRACE_DIR/server.log        — server stdout/stderr"
echo ""
echo "Quick inspection:"
echo "  jq -s '.' $TRACE_DIR/flow-permission.jsonl | less"
echo "  grep 'data:' $TRACE_DIR/sse-raw.log | jq -r '.type' | sort | uniq -c | sort -rn"
