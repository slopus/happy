# Codex MCP Experiments

## Running

```bash
# Default: "curl google home page" with read-only sandbox
npx tsx experiments/codex.ts

# Custom prompt
npx tsx experiments/codex.ts "list files in current directory"

# Custom working directory
CWD=/tmp npx tsx experiments/codex.ts "write hello.txt"
```

## Key Findings

### 1. MCP SDK strips Codex-specific params from elicitation requests

**Problem:** `ElicitRequestSchema` uses strict Zod objects for `params`. When
`setRequestHandler` validates incoming JSON-RPC via `parseWithCompat()`, all
Codex-specific fields (`codex_call_id`, `codex_command`, `codex_cwd`, etc.)
get stripped.

**Fix:** Rebuild the params union using `z4mini.looseObject()` (preserves unknown
keys). Reuse the original `method` literal from ElicitRequestSchema because
the Client override checks `def.value` but `z4mini.literal()` only has
`def.values` (array).

### 2. Client.setRequestHandler has a z4mini literal extraction bug

The Client class overrides `setRequestHandler` with its own method literal
extraction (line 176-180 in client/index.js):
```js
methodValue = v4Def?.value ?? v4Schema.value;
```
But `z4mini.literal('...')` stores the value in `def.values` (array), not
`def.value`. The base Protocol uses `getLiteralValue()` which handles both.
Workaround: reuse the original schema's method field.

### 3. Elicitation response must include BOTH `action` AND `decision`

**Problem:** The MCP spec uses `action: 'accept' | 'decline' | 'cancel'`.
Codex separately expects `decision: 'approved' | 'denied' | ...` in its
`exec_approval` module.

Returning only `action` → Codex error: "missing field `decision`"
Returning only `decision` → MCP SDK error: "Invalid option: expected accept|decline|cancel"

**Fix:** Return both fields. `ElicitResultSchema` has passthrough on the
result object, so `decision` survives MCP SDK validation.

```typescript
return { action: 'accept', decision: 'approved' };
```

### 4. Sandbox policy affects whether elicitation fires

- `danger-full-access`: commands run without elicitation (0 permission requests)
- `read-only` + `on-request`: first attempt runs in sandbox (fails for network),
  then Codex retries with `require_escalated` which triggers elicitation
- `workspace-write` + `on-request`: similar to read-only but file writes allowed

### 5. Approval policy mapping from Happy permission modes

| Happy Permission Mode | Codex approval-policy | Codex sandbox |
|---|---|---|
| `default` / `effective` | `on-request` | `read-only` |
| `approve-all` | `never` | `danger-full-access` |
| `auto-approve` | `on-failure` | `workspace-write` |

## TODO: ACP (Agent Communication Protocol) Experiment

Codex may support ACP as an alternative to MCP elicitation for permission
handling. Need to investigate:

1. Does `codex mcp-server` support ACP natively?
2. Would ACP bypass the Zod stripping issue entirely?
3. Performance comparison: ACP vs MCP elicitation roundtrip
4. Create `experiments/codex-acp.ts` if ACP is viable

Check: https://github.com/anthropics/agent-communication-protocol
Check: `codex --help` for ACP-related flags
