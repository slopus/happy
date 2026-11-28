# 同会话跨执行器验收与修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 验证当前 Codex↔Antigravity/Gemini 共同会话，并修复权限配置误报与目标尚未就绪时首条业务可能已提交的缺口。

**Architecture:** 保留现有稳定 root、执行段、portable 原文归档和失败回执；新增目标执行器准备确认，复用配置锁及原生模型配置确认。AGY 暂采用 fresh native＋portable 历史，不声称原生恢复；不扩大权限或复制审批身份。

**Tech Stack:** TypeScript、React、Vitest、Paws daemon/ACP/Codex runtime、Ego Browser。

**Spec:** `docs/validation/in-chat-agent-switch.md`；本轮验收结果归 `docs/validation/shared-conversation-acceptance-20261128.md`。

## Global Constraints

- root 工作区保持干净 main；只在本 sibling worktree 及独立权限 worktree 修改。
- 选择目标仍只暂存，普通发送才提交；不新增输入框常驻控件，不改变独立新建路径。
- 不新增状态轮询，不盲重发投递未知消息；失败不扩大权限或清除原业务资料。
- 真实 E2E 使用既定正式 Web、专属测试会话及测试目录；不另建后端。
- 用户已授权验收并直接修复；现有同范围发布与精确测试清理授权继续适用。

## Review Focus

- 服务器用户消息入库与原生执行器就绪/接受输入是不同证据。
- 配置等待时不能发送旧权限元数据覆盖目标的新权限。
- 候选 worker 换代、root reservation 变化或账号切换应使迟到确认失效。
- 部分成功/未知投递不得自动回退重放；原会话恢复不撤销已执行副作用。
- 不为 AGY/Codex 的新准备门槛静默退役已有其他执行器或冒充旧 CLI 具备新能力。

## Task 1：权限配置确认

**Files:** `packages/happy-app/sources/hooks/useSessionTaskPermission.ts` 及定向 hook tests。

- [x] 在独立权限 worktree 补 deferred ACK、false/reject、worker 换代及配置期间发送锁的失败测试。
- [x] Codex 等待真实 RPC 确认后再保存已应用模式，失败保留原值；复用已有 session config 锁。
- [x] 复跑 hook、AGY 配置、权限确认、message metadata 与发送边界测试及 App typecheck。
- [x] 将独立分支的明确文件集成到本工作树并复核。

## Task 2：目标准备后才投递首条业务

**Files:** `packages/happy-app/sources/hooks/useSpawnSession.ts`、必要 `sync/ops`/prepare helper、`packages/happy-cli/src/agent/acp/runAcp.ts`、`codex/runCodex.ts` 及原生准备 helper/tests。

- [x] 复现 webhook 已返回而 backend/config 准备失败时仍会投递/提交的测试。
- [x] 为本轮目标提供独立 conversation prepare RPC，绑定 root/source/request/worker 并等待 native readiness 与配置确认。
- [x] 首条业务前等待有效回执；未知、失败或迟到确认保留可恢复状态，不无声跳过老 CLI 能力缺失。
- [x] 复跑 launch、continuation delivery、准备协议和取消/边界相关测试与两端 typecheck。

## Task 3：真实验收、发布和复验

- [ ] 从正式页面的本轮专属 Codex 源执行准备测试，再同 root 切 Gemini 讨论、切回 Codex 修改测试文件。
- [ ] 分别验证预算外历史读取、历史图片原件、允许/禁止权限、刷新/clear 及失败恢复，逐项标记真实/模拟/未测证据。
- [ ] 必要评审与当前 head CI 通过后，按正常 PR/main CI 发布并核验目标版本；CLI 按项目稳定启动入口作最小激活，不停原 worker。
- [ ] 从同一正式入口复验修复，交付可播放验证录像和报告；按清单只清理本轮测试对象。

## Verification Commands

按实际修改文件选择定向 `pnpm --filter happy-app exec vitest run ...` 与 `pnpm --filter @wangjs-jacky/paws exec vitest run --project unit ...`；运行 App/CLI `typecheck`、`git diff --check` 和相关 OTA/runtime 契约。具体命令、计数和失败结果写入验收报告，不把计划视为已运行。
