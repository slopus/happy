# Paws 公共 AI 服务基线

记录日期：2026-10-05。任务：T0。本文只记录现有系统。公共 AI 服务尚未实现。没有发布包、部署、切换账号或修改生产数据。

## Git 与工作区

| 项目 | 结果 |
| --- | --- |
| 开发目录 | `/Users/jacky/jacky-github/happy--shared-ai-services` |
| 开发分支 | `feat/shared-ai-services` |
| 起始提交 | `f1fec57f212cf9ce8b4bd2788a3a955a3f93ea46` |
| 根目录 | `/Users/jacky/jacky-github/happy` |
| 根目录检查 | `main`；工作树干净；HEAD 与本次检查的 `origin/main` 相同 |
| 已有文件 | 主控复制的已认可设计和计划原文；本任务将它们提交，不改写审批记录 |

两个开发目录均为已有 sibling worktree。没有创建额外 worktree。没有重置或搬运其他工作区。根目录未写入文件。

狗头军师基线及部署差异见另一个仓库的 `docs/verification/paws-services-baseline.md`。它的起始主线与线上代码不同。T0 已在独立工作区合入线上提交。

## 运行与协议

只读观察时间约为北京时间 20:18–20:23。

| 项目 | 观察结果 |
| --- | --- |
| 正式 Paws Web | `https://47.115.228.20:8443` |
| Web HTML 发布标识 | `f1fec57f212cf9ce8b4bd2788a3a955a3f93ea46`；HTTP 200 |
| `/health` | HTTP 200；`status=ok`；`service=happy-server` |
| 当前 CLI | `@wangjs-jacky/paws` 1.3.18 |
| CLI 实际入口 | `/Users/jacky/Deployments/paws-cli/releases/cross-account-f1fec57f-20261005/bin/happy.mjs` |
| daemon | PID 99027；本机状态为运行；版本 1.3.18 |
| 源码包版本 | Server 1.1.11；SDK 0.3.0；wire 0.1.0；App 1.0.0 |
| 服务端运行提交 | 健康 API 未提供此字段；不能用 Web 提交代替服务端运行提交 |
| 现有应用委托 | 数字协议 1/2/3；协议 2 支持明确的永久授权；协议 3 增加 `agent:chat` |
| 新协议 | `ai-services/1` 是已认可计划中的名称；本基线尚未实现 |

协议依据：`packages/happy-wire/src/appChat.ts`、`packages/paws-agent/src/delegation/browserDelegation.ts`、`packages/happy-server/sources/app/appDelegation/appDelegation.ts`。已有 `docs/app-delegation.md` 记录早期协议及历史验收。它的旧版本描述不能覆盖当前源码。

Android/iOS 的 OTA runtime 继续以 `packages/happy-app/scripts/ota-runtime-config.js` 及对应平台 runtime JSON 为准。本任务不生成原生或 OTA 产物。

## 账号与执行环境

账号清单来自只读 GET `/v1/codex-accounts`。公开文档使用稳定账号标签，只保留状态和凭据版本。真实账号引用保存在忽略的本机报告中，不保存账号名、邮箱或认证材料。

| 账号引用 | 状态 | 凭据版本 |
| --- | --- | --- |
| 账号 A | available | 7 |
| 账号 B | available | 6 |

设备清单来自只读 GET `/v1/machines`。本机 Mini 为 active。另一在线设备为 active。离线设备为 inactive。真实设备引用仅存于忽略的本机报告。此状态仅代表观察时刻，不能代替模型回合验收。

| 工具 | 结果 |
| --- | --- |
| Node | v24.20.0 |
| pnpm | 10.11.0 |
| Codex | 0.159.3；`codex login status` 显示已通过 ChatGPT 登录 |
| Codex 二进制 | `/Users/jacky/.local/share/codex/releases/0.159.3/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex` |
| Claude Code | 2.1.251；`claude auth status` 返回 `loggedIn=false`、`authMethod=none` |
| Claude 二进制 | `/Users/jacky/.nvm/versions/node/v24.20.0/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe` |

本任务未发起模型回合。两个 Codex 账号仍需在 T10 分别执行真实回合。Claude 当前没有登录身份，T10 A4 的真实 Claude 部分不能完成。没有登录、更新 token 或切换默认账号。

## 现有能力及证据

| 功能 | 基线证据与边界 |
| --- | --- |
| Paws 登录 | 原有账号认证与恢复入口保留；SDK 凭据测试通过；本任务未重新登录 |
| 应用授权 | 委托 API、加密 SDK、撤销、永久授权与范围测试通过；本任务未发起扫码 |
| 历史 | 服务端委托测试覆盖所属连接、分页和只读历史；SDK 测试覆盖恢复；不等于线上用户历史验收 |
| 图片 | 现有委托允许受限 data URL；SDK 测试覆盖图片边界；历史真实图片验收见 `docs/app-delegation.md` |
| 分享 | 原有公开分享与外部只读分享源码保留；历史公开分享证据见 `docs/pr-evidence/public-share-theme-cover/README.md`；本任务未创建分享 |
| 执行保护 | CLI 委托测试覆盖受限 Claude 与 worker 锁；账号测试覆盖凭据隔离和版本更新 |

## 安装与验证

Paws 独立安装：`pnpm install --frozen-lockfile`。安装成功，用时 1 分 3.3 秒。没有链接其他工作区的整个 `node_modules`。Prisma 客户端由既有 postinstall 生成。本任务未运行数据库迁移。

先运行 `pnpm --dir packages/happy-wire run build`。构建通过。服务端的 wire 别名依赖这个工作区自己的 dist。

| 命令 | 结果 |
| --- | --- |
| `pnpm --dir packages/happy-wire exec vitest run src/appChat.test.ts` | 1 文件，6 项通过 |
| `pnpm --dir packages/paws-agent exec vitest run src/delegation/browserDelegation.test.ts src/adapters/browserCredentials.test.ts src/credentials.test.ts` | 3 文件，37 项通过 |
| `pnpm --dir packages/happy-server exec vitest run sources/app/appDelegation sources/app/api/routes/appDelegationRoutes.spec.ts sources/app/api/routes/codexAccountRoutes.spec.ts sources/app/auth/appTokenBoundary.spec.ts` | 4 文件，54 项通过 |
| CLI 委托及账号生命周期指定测试 | 5 文件，41 项通过；命令与配置如下 |

CLI 默认 Vitest 配置会先构建完整 CLI。T0 使用独立的最小配置，仅运行现有测试，不触发该构建。配置位于忽略目录 `.superpowers/sdd/2026-10-05-paws-shared-ai-service/baseline-cli.vitest.mjs`。内容如下；换目录时更新 alias 的绝对路径。

```js
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'], exclude: ['src/**/*.integration.test.ts'] },
  resolve: { alias: { '@': '/Users/jacky/jacky-github/happy--shared-ai-services/packages/happy-cli/src' } },
});
```

```sh
pnpm --dir packages/happy-cli exec vitest run \
  --config /Users/jacky/jacky-github/happy--shared-ai-services/.superpowers/sdd/2026-10-05-paws-shared-ai-service/baseline-cli.vitest.mjs \
  src/daemon/appDelegation src/codex/codexAccountAuth.test.ts \
  src/daemon/codexAccountLaunch.test.ts src/api/codexAccounts.test.ts
```

日志保存在本机 `/tmp/paws-services-t0-*.log`。它们是临时诊断文件，不是永久归档。指定测试没有失败。不扩大到全 App 构建或真实模型集成测试。后续任务按已认可计划运行各自受影响检查。

## 发布入口与剩余验收

常规 Web 发布入口是 PR → main → `.github/workflows/web-production-deploy.yml` → `scripts/deploy-web.sh`。正式 origin 固定为上表地址。CLI/SDK 包按 `CLAUDE.md` 的 npm 发布规则执行；本任务未发布。服务端部署说明见 `docs/deployment.md`，具体自托管流程见项目既有运维记录。T11 必须另行核对实际部署提交和发布授权。

T10 A1–A12 均未执行。本任务的现有测试不是新服务验收。Claude 登录缺失是 A4 的外部条件。手机扫码及机主日常使用仍需真实环境。独立评审由主控安排。
