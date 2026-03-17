# Orchestrator

The orchestrator lets AI agents submit and manage multi-task runs. Tasks run in parallel across machines, support DAG dependencies, configurable retry, and per-task provider selection.

## Concepts

- **Run**: A batch of tasks submitted together. Has a title, status, and concurrency limit.
- **Task**: A single unit of work within a run. Each task specifies a provider (claude/codex/gemini), a prompt, and optional constraints.
- **Execution**: A single attempt to run a task. A task may have multiple executions if retry is configured.
- **DAG dependencies**: Tasks can declare `dependsOn` relationships, forming a directed acyclic graph. A task only starts after all its dependencies complete.

## MCP Tools

Agents interact with the orchestrator through 5 MCP tools:

| Tool | Purpose |
|------|---------|
| `orchestrator_submit` | Submit a run (blocking or async) |
| `orchestrator_pend` | Wait for run status changes |
| `orchestrator_list` | List runs with status filter |
| `orchestrator_cancel` | Cancel a running run |
| `orchestrator_get_context` | Get available machines and providers |

## Usage Scenarios

### 1. Parallel code review

Review multiple modules simultaneously — each task reviews one module with its own prompt.

```
orchestrator_submit({
  title: "Code review: auth + api + db",
  blocking: true,
  maxConcurrency: 3,
  tasks: [
    {
      taskKey: "review-auth",
      provider: "claude",
      prompt: "Review packages/server/auth/ for security issues. Focus on token handling, session management, and input validation."
    },
    {
      taskKey: "review-api",
      provider: "claude",
      prompt: "Review packages/server/api/routes/ for error handling, input validation, and response consistency."
    },
    {
      taskKey: "review-db",
      provider: "codex",
      prompt: "Review all Prisma queries for N+1 issues, missing indexes, and transaction safety."
    }
  ]
})
```

### 2. Multi-file refactoring with dependency ordering

Rename an internal API — update the library first, then update all consumers, then run tests.

```
orchestrator_submit({
  title: "Rename getUserById → findUserById",
  blocking: true,
  maxConcurrency: 2,
  tasks: [
    {
      taskKey: "rename-core",
      provider: "codex",
      prompt: "In packages/server/models/user.ts, rename the exported function getUserById to findUserById. Update the function name, all internal references, and the JSDoc.",
      workingDirectory: "/path/to/project"
    },
    {
      taskKey: "update-routes",
      provider: "codex",
      prompt: "In packages/server/api/routes/, find all imports and calls to getUserById and update them to findUserById.",
      workingDirectory: "/path/to/project",
      dependsOn: ["rename-core"]
    },
    {
      taskKey: "update-tests",
      provider: "codex",
      prompt: "In packages/server/__tests__/, update all references from getUserById to findUserById. Run the test suite and fix any failures.",
      workingDirectory: "/path/to/project",
      dependsOn: ["rename-core"]
    },
    {
      taskKey: "verify",
      provider: "claude",
      prompt: "Run the full test suite. Grep the codebase for any remaining references to getUserById. Report findings.",
      workingDirectory: "/path/to/project",
      dependsOn: ["update-routes", "update-tests"]
    }
  ]
})
```

`update-routes` and `update-tests` run in parallel after `rename-core` completes. `verify` waits for both.

### 3. Research and summarize

Investigate a topic from multiple angles, then synthesize.

```
orchestrator_submit({
  title: "Research: WebSocket vs SSE for real-time updates",
  blocking: true,
  maxConcurrency: 3,
  tasks: [
    {
      taskKey: "websocket-pros-cons",
      provider: "claude",
      prompt: "Analyze WebSocket for real-time browser updates: connection management, scalability, proxy/CDN compatibility, browser support, and failure modes."
    },
    {
      taskKey: "sse-pros-cons",
      provider: "claude",
      prompt: "Analyze Server-Sent Events for real-time browser updates: connection management, scalability, proxy/CDN compatibility, browser support, and failure modes."
    },
    {
      taskKey: "compare",
      provider: "claude",
      prompt: "Given the analysis of WebSocket and SSE from the previous tasks, produce a comparison table and a recommendation for a Node.js/React application that needs real-time updates for 100-1000 concurrent users.",
      dependsOn: ["websocket-pros-cons", "sse-pros-cons"]
    }
  ]
})
```

### 4. Multi-machine deployment

Dispatch tasks to specific machines — useful when different environments are needed.

```
// First, check available machines
orchestrator_get_context()
// Returns: { machines: [{ id: "m1", name: "dev-box", dispatchReady: true }, { id: "m2", name: "staging", dispatchReady: true }] }

orchestrator_submit({
  title: "Cross-environment smoke test",
  blocking: true,
  maxConcurrency: 2,
  tasks: [
    {
      taskKey: "test-dev",
      provider: "codex",
      prompt: "Run the integration test suite and report results.",
      workingDirectory: "/home/user/project",
      target: { machineId: "m1" }
    },
    {
      taskKey: "test-staging",
      provider: "codex",
      prompt: "Run the integration test suite and report results.",
      workingDirectory: "/home/user/project",
      target: { machineId: "m2" }
    }
  ]
})
```

### 5. Retry for flaky operations

Configure retry for tasks that may fail transiently (e.g., network calls, external APIs).

```
orchestrator_submit({
  title: "Fetch and process external data",
  blocking: true,
  tasks: [
    {
      taskKey: "fetch-data",
      provider: "codex",
      prompt: "Fetch the latest exchange rates from the ECB API, parse the XML response, and save as JSON to data/rates.json.",
      workingDirectory: "/path/to/project",
      timeoutMs: 30000,
      retry: { maxAttempts: 3, backoffMs: 5000 }
    },
    {
      taskKey: "process",
      provider: "claude",
      prompt: "Read data/rates.json and generate a markdown report comparing EUR/USD, EUR/GBP, and EUR/JPY trends.",
      workingDirectory: "/path/to/project",
      dependsOn: ["fetch-data"]
    }
  ]
})
```

If `fetch-data` times out or the agent crashes, it retries up to 3 times with a 5-second delay between attempts. `process` only starts after a successful fetch.

### 6. Build pipeline

Lint, test, and build in dependency order — like a mini CI.

```
orchestrator_submit({
  title: "Pre-commit checks",
  blocking: true,
  maxConcurrency: 2,
  tasks: [
    {
      taskKey: "lint",
      provider: "codex",
      prompt: "Run eslint on the entire project. Fix any auto-fixable issues. Report remaining issues.",
      workingDirectory: "/path/to/project"
    },
    {
      taskKey: "typecheck",
      provider: "codex",
      prompt: "Run tsc --noEmit. Report any type errors.",
      workingDirectory: "/path/to/project"
    },
    {
      taskKey: "test",
      provider: "codex",
      prompt: "Run the full test suite with vitest. Report failures.",
      workingDirectory: "/path/to/project",
      dependsOn: ["lint", "typecheck"]
    },
    {
      taskKey: "build",
      provider: "codex",
      prompt: "Run the production build. Report any errors.",
      workingDirectory: "/path/to/project",
      dependsOn: ["test"]
    }
  ]
})
```

`lint` and `typecheck` run in parallel. `test` waits for both. `build` waits for `test`.

### 7. Multi-provider comparison

Send the same task to different providers and compare outputs.

```
orchestrator_submit({
  title: "Compare provider outputs: API design",
  blocking: true,
  maxConcurrency: 3,
  tasks: [
    {
      taskKey: "claude-design",
      provider: "claude",
      prompt: "Design a REST API for a bookstore. Include endpoints, request/response schemas, and error handling. Output as OpenAPI YAML."
    },
    {
      taskKey: "codex-design",
      provider: "codex",
      prompt: "Design a REST API for a bookstore. Include endpoints, request/response schemas, and error handling. Output as OpenAPI YAML."
    }
  ]
})
```

### 8. Monitoring active runs

Check on running orchestrations and cancel if needed.

```
// List active runs
orchestrator_list({ status: "active" })

// Wait for a specific run to finish
orchestrator_pend({ runId: "run_abc123" })

// Cancel a run that's taking too long
orchestrator_cancel({ runId: "run_abc123" })
```

## Task Configuration Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `taskKey` | string | auto-generated | Unique key within the run, used for `dependsOn` references |
| `provider` | string | required | `claude`, `codex`, or `gemini` |
| `prompt` | string | required | The task prompt (max 65KB) |
| `title` | string | optional | Human-readable task title |
| `workingDirectory` | string | optional | Working directory for the agent process |
| `timeoutMs` | number | 900000 (15m) | Max execution time per attempt |
| `dependsOn` | string[] | [] | Task keys that must complete before this task starts |
| `retry.maxAttempts` | number | 1 | Total attempts (1 = no retry, max 10) |
| `retry.backoffMs` | number | 0 | Delay between retry attempts (max 86400000 / 24h) |
| `target.machineId` | string | current machine | Dispatch to a specific machine |

## Run Configuration Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `title` | string | required | Human-readable run title |
| `blocking` | boolean | false | If true, the submit call waits until all tasks finish |
| `maxConcurrency` | number | 2 | Max tasks running simultaneously (1-8) |
| `idempotencyKey` | string | optional | Prevents duplicate submissions |

## Status Lifecycle

### Run Status

```
queued → running → completed (all tasks succeeded)
                 → failed (any task failed after retries)
                 → canceling → cancelled (user-initiated)
```

### Task Status

```
queued → running → completed
                 → failed (after all retry attempts exhausted)
       → dependency_failed (upstream task failed, this task is skipped)
       → cancelled (run was cancelled)
```

## REST API

See the [API documentation](api.md) for general conventions. Orchestrator endpoints:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/orchestrator/context` | Available machines and providers |
| POST | `/v1/orchestrator/submit` | Submit a new run |
| GET | `/v1/orchestrator/runs` | List runs (filterable by status) |
| GET | `/v1/orchestrator/runs/:runId` | Get run details |
| GET | `/v1/orchestrator/runs/:runId/pend` | Long-poll for run changes |
| POST | `/v1/orchestrator/runs/:runId/cancel` | Cancel a run |
