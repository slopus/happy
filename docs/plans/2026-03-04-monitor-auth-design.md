# Monitor Auth — Password Protection

## Problem

The standalone monitor (`/monitor/`) and all preview proxy endpoints (`/v1/preview/*`) are completely open — no authentication required. Anyone with the URL can:
- View the monitor and proxied sites
- Send events via SSE broadcast
- Access the main Happy Codex app through proxy fallback redirects

## Solution

Simple shared password authentication for the monitor and preview endpoints.

## Design

### 1. Password Configuration

- Environment variable `MONITOR_PASSWORD` in docker-compose
- If not set, monitor auth is disabled (backward-compatible)

### 2. Auth Flow

1. User opens `/monitor/?url=...` → server checks `monitor_token` cookie
2. No valid cookie → monitor page shows a password form instead of the preview
3. User enters password → `POST /v1/preview/auth` → server compares with `MONITOR_PASSWORD`
4. Match → server returns `Set-Cookie: monitor_token=<JWT>` (httpOnly, secure, 30 days)
5. Subsequent requests include cookie automatically → access granted

### 3. Endpoint: POST /v1/preview/auth

```
Request:  { password: string }
Response: { success: true } + Set-Cookie header
Error:    401 { error: "Invalid password" }
```

### 4. Middleware on /v1/preview/*

All `/v1/preview/*` endpoints get a preHandler that:
1. Checks for `monitor_token` cookie → validates JWT
2. Checks for `Authorization: Bearer <token>` header → validates via existing Happy auth (sidebar requests)
3. Neither valid → returns 401

This means:
- Sidebar preview works without monitor password (uses Happy Bearer token)
- External monitor requires the monitor password cookie

### 5. Self-Origin Protection

The preview proxy rejects requests that would load the Happy app itself:
- Block target URLs matching `app.304.systems` or the server's own origin
- Return a clear error message instead of proxying

### 6. Error Fallback Fix

Currently nginx `error_page 502` → `302 /` which redirects to the main Happy app inside the monitor iframe. Fix: the proxy should return a proper error page ("Dev-server unavailable") instead of redirecting.

## Files to Change

| File | Change |
|------|--------|
| `docker-compose.yml` | Add `MONITOR_PASSWORD` env var |
| `previewProxyRoutes.ts` | Add `POST /v1/preview/auth`, add auth middleware, add self-origin block |
| `monitor/index.html` | Add login screen (password form), handle 401 responses |

## JWT Structure

```json
{
  "type": "monitor",
  "iat": <timestamp>,
  "exp": <timestamp + 30 days>
}
```

Signed with `MONITOR_PASSWORD` as secret (simple, no extra env vars needed).
