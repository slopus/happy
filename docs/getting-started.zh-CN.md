# Paws 从零上手

这篇文档面向想要使用 Paws、连接电脑、启动 daemon、或自托管同步服务器的读者。Paws 现在是独立维护的产品与代码线；GitHub 保留的 fork 关系不改变安装和开发路径。本文先给出最快跑通路径，再说明源码开发、server 选项、App 构建和常见排障。

本文只写可公开复用的通用路径，不写任何个人机器专属脚本、私有认证封装或私有基础设施细节。

## Paws 是什么

Paws 让你可以从另一台设备控制 AI 编程 agent。你在能访问代码的电脑上运行 `paws` CLI，再用手机或网页 App 查看进度、发送指令、处理权限请求，并在电脑在线时远程启动新会话。

```text
手机 / 网页 App
    |
    |  HTTP + WebSocket，端到端加密载荷
    v
Paws 兼容同步 Server
    |
    |  加密同步、机器在线状态、会话状态
    v
电脑上的 paws CLI / daemon
    |
    v
Claude Code / Codex / Gemini / OpenCode / ACP 兼容 agent
```

几个核心概念：

- **App**：手机、网页或桌面端的远程控制界面。
- **CLI**：在项目所在电脑上运行的 `paws` 命令；`happy` 只保留为兼容 alias。
- **daemon**：后台进程，让这台电脑可以被 App 远程创建会话。
- **server**：同步中继服务。它保存和转发加密记录，不需要看到你的会话明文。
- **Paws**：本文描述的产品与仓库。production 构建显示为 `Paws`，dev/preview 构建分别显示为 `Paws (dev)` 和 `Paws (preview)`。

## 我该走哪条路径

| 目标 | 路径 |
|------|------|
| 使用 Paws | 安装 Paws APK 和公开 npm 包 `@wangjs-jacky/paws`。 |
| 跑自己的同步中继 | 单机先用 `paws server`，团队共享再用 Docker。 |
| 参与开发 | 从 `main` 切 worktree，安装 pnpm 依赖，跑对应 package 的检查。 |

CLI 已发布为 `@wangjs-jacky/paws`。新文档与脚本默认使用 `paws`；安装包同时提供 `happy` 兼容 alias，以兼容已有脚本、配置和内部路径。

## 仓库结构

本仓库是 pnpm monorepo。

| 路径 | 包 | 作用 |
|------|----|------|
| `packages/happy-app` | `happy-app` | Expo / React Native App，覆盖 iOS、Android、Web 和桌面实验 |
| `packages/happy-cli` | `@wangjs-jacky/paws` | `paws` CLI、`happy` 兼容 alias、agent runner、daemon、本地状态、鉴权和同步 |
| `packages/happy-server` | `happy-server-self-host` | Fastify + Socket.IO 后端，负责加密同步和自托管 |
| `packages/paws-agent` | `@wangjs-jacky/paws-agent` | 浏览器安全的 SDK 与 CLI，用于机器、会话、消息、审批和实时事件 |
| `packages/happy-wire` | `@slopus/happy-wire` | 共享 wire schema 和协议类型 |
| `packages/happy-app-logs` | `happy-app-logs` | App 日志开发辅助工具 |
| `packages/codium` | `codium` | 桌面 / 实验性包 |
| `environments/` | - | 本地隔离环境和 fixture 项目 |
| `docs/` | - | 架构、协议、部署和计划文档 |

## 用户快速开始

如果你只想用手机或浏览器控制自己电脑上的 agent，从这里开始。

### 1. 下载 App

Paws Android APK 发布在 GitHub Releases：

- Releases 页面：<https://github.com/wangjs-jacky/happy/releases>
- GitHub 标记的 Latest：<https://github.com/wangjs-jacky/happy/releases/latest>

进入最新的非 prerelease Android release，下载 `.apk` 资产并在安卓手机上安装。系统提示未知来源时，允许浏览器或文件管理器安装即可。

注意：

- 普通用户优先下载 GitHub 标记为 `Latest` 的 release。某些专题包可能发布时间更晚，但可能依赖配套 server 或原生配置。
- App 和 CLI 必须使用一致的 `paws://` 配对 scheme。
- 如果你自托管，App 和 CLI 必须指向同一个 server URL。

### 2. 安装目标 agent CLI

Paws 包装已有的编程 agent CLI。先安装并登录你要使用的 agent。

```bash
# Claude Code
npm install -g @anthropic-ai/claude-code
claude --version
claude

# Codex
npm install -g @openai/codex
codex --version
codex

# Gemini
npm install -g @google/gemini-cli
gemini --version
```

如果底层 agent 自己跑不起来，Paws 也无法替它修复登录或安装问题。先确认 agent CLI 本身可用。

### 3. 安装 Paws CLI

安装公开 npm 包：

```bash
npm install -g @wangjs-jacky/paws
paws --version
```

新文档和脚本统一使用 `paws`。安装后提供的 `happy` 命令是兼容 alias。需要验证未发布源码改动的贡献者，可以使用下文的[从源码开发](#从源码开发)流程。

### 4. 让 CLI 和 App 指向同一个 server

如果你使用 App/CLI 内置默认 server，可以跳过这一步。自托管或团队 server 需要同时设置两个 CLI URL：

```bash
export HAPPY_SERVER_URL=http://your-server:3005
export HAPPY_WEBAPP_URL=http://your-server:3005
```

想持久化，可以把上面两行写入 shell profile，或写入 `~/.happy/settings.json`：

```json
{
  "serverUrl": "http://your-server:3005",
  "webappUrl": "http://your-server:3005"
}
```

手机 App 里也打开设置，把自定义 server URL 填成同一个 origin。URL 必须完全一致：`http://host:3005` 和 `https://host:8443` 对客户端来说是两台不同 server。

### 5. 配对电脑

配对会把这台电脑加入你的加密账号。

```bash
paws auth login --force
```

选择 mobile app 登录方式，用 App 扫终端二维码并批准。也可以直接启动一个会话来触发配对：

```bash
paws
paws claude
paws codex
```

fork 构建使用 `paws://terminal?...` 终端配对链接。如果 App 提示二维码无效，通常是 App 和 CLI 来自不同构建或不同 scheme。

### 6. 启动测试会话

先从电脑启动：

```bash
paws codex
# 或
paws
```

确认 App 能看到会话、能发送消息、能收到输出。然后再从 App 新建一次会话，验证远程 spawn 路径可用。

## Daemon

daemon 让 App 可以在电脑在线、但没有前台终端会话时远程创建 session。

```bash
paws daemon start
paws daemon status
paws daemon list
paws daemon logs
paws daemon stop
```

daemon 会继承启动它的 shell 环境。如果你改过 `HAPPY_SERVER_URL`、`HAPPY_WEBAPP_URL`、`PATH`、代理变量或 agent 凭据，必须从正确环境重启 daemon：

```bash
paws daemon stop
paws daemon start
paws daemon status
```

默认本地状态存放在 `~/.happy`：

| 路径 | 内容 |
|------|------|
| `~/.happy/settings.json` | server URL、web app URL、onboarding 和 profile 配置 |
| `~/.happy/access.key` | 本地密钥材料 |
| `~/.happy/daemon.state.json` | daemon PID、控制端口和版本 |
| `~/.happy/sessions.json` | 本地会话索引 |
| `~/.happy/logs/` | CLI 和 daemon 日志 |
| `~/.happy/attachments/` | 传给 agent 使用的原始附件暂存 |

如果想使用独立数据目录，可以设置 `HAPPY_HOME_DIR`：

```bash
HAPPY_HOME_DIR=~/.happy-dev paws codex
```

本地开发时 daemon/session 状态严重卡住，可以执行：

```bash
paws doctor clean
```

它会杀掉 Paws 相关 daemon/session 进程。还有正在使用的本地会话时不要运行。

## Server 选项

你可以使用已有的 Happy 兼容 server，也可以自托管。

CLI 按下面顺序解析 URL：

```text
HAPPY_SERVER_URL / HAPPY_WEBAPP_URL 环境变量
> ~/.happy/settings.json
> 内置默认值
```

App 按下面顺序解析 server URL：

```text
App 内自定义服务器设置
> window.__HAPPY_CONFIG__.serverUrl
> EXPO_PUBLIC_HAPPY_SERVER_URL
> 内置默认值
```

团队或生产使用建议走 HTTPS。HTTP 适合本地开发和私有局域网测试，但移动平台可能拦截明文 HTTP，除非 App 构建明确放行了对应网络策略。

## 自托管

当你想控制同步服务和存储位置时，可以自托管。

### 方案 A：单机 `paws server`

这是最快的本地 server 测试方式。它使用内嵌 PGlite，把数据放在 `~/.happy/server-data/`。

```bash
npm install -g happy-server-self-host
paws server
```

默认情况下，`paws server` 会询问是否把 `serverUrl` 和 `webappUrl` 写入 `~/.happy/settings.json`。如果只想临时启动、不改默认设置：

```bash
paws server --no-persist
```

如果要让同一局域网里的手机访问：

```bash
paws server --host 0.0.0.0
```

然后让 App 和 CLI 指向 `http://<你的电脑局域网 IP>:3005`。

### 方案 B：Docker Standalone

团队共享或可重复部署用 Docker。仓库根目录执行：

```bash
docker build -f Dockerfile -t happy-server:local .
```

生成 master secret：

```bash
openssl rand -hex 32
```

创建 `docker-compose.yml`：

```yaml
services:
  happy-server:
    image: happy-server:local
    container_name: happy-server
    restart: unless-stopped
    ports:
      - "3005:3005"
    volumes:
      - ./data:/data
    environment:
      NODE_ENV: production
      PORT: "3005"
      HOST: "0.0.0.0"
      HANDY_MASTER_SECRET: "replace-with-a-random-secret"
```

启动：

```bash
docker compose up -d
docker compose logs -f happy-server
```

验证：

```bash
curl -i http://localhost:3005/health
```

让 CLI 指向它：

```bash
export HAPPY_SERVER_URL=http://localhost:3005
export HAPPY_WEBAPP_URL=http://localhost:3005
paws auth login --force
```

局域网或团队使用时，把 `localhost` 换成手机和电脑都能访问的稳定域名或 IP。

### 方案 C：源码 Standalone

适合开发或本地实验：

```bash
pnpm install
pnpm --filter happy-server-self-host standalone:dev
```

它会在 `3005` 端口启动 server，并使用内嵌 PGlite 存储。

### Server 环境变量

standalone 最小配置：

| 变量 | 必填 | 说明 |
|------|------|------|
| `HANDY_MASTER_SECRET` | 是 | 用于服务端鉴权 token 和加密第三方服务 token 的 master secret |
| `PORT` | 否 | server 端口，默认 `3005` |
| `HOST` | 否 | 监听地址，默认 `0.0.0.0` |
| `DATA_DIR` | 否 | 基础数据目录 |
| `PGLITE_DIR` | 否 | 内嵌数据库目录 |
| `PUBLIC_URL` | 否 | 生成文件 URL 时使用的外部 base URL |

可选生产服务：

| 变量 | 用途 |
|------|------|
| `DATABASE_URL` | 使用外部 PostgreSQL 替代 PGlite |
| `REDIS_URL` | Redis 支持的多进程 Socket.IO 行为 |
| `S3_HOST`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_PUBLIC_URL` | S3 兼容对象存储 |
| `ELEVENLABS_API_KEY`, `REVENUECAT_API_KEY` | 语音和付费能力集成 |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` 等 | GitHub OAuth / 集成能力 |

上线后保持 `HANDY_MASTER_SECRET` 稳定。更换它会让已签发的服务端鉴权 token 和服务端加密的集成 token 失效。

## 从源码开发

### 前置条件

```bash
node --version   # Node.js 20+
corepack enable
pnpm --version
git --version
```

安装依赖：

```bash
git clone https://github.com/wangjs-jacky/happy.git
cd happy
git switch main
pnpm install
```

需要让全局命令指向当前源码时：

```bash
pnpm --filter @wangjs-jacky/paws build
cd packages/happy-cli
npm link
paws --version
```

### 静态检查

App：

```bash
pnpm --filter happy-app typecheck
pnpm --filter happy-app test
```

CLI：

```bash
pnpm --filter @wangjs-jacky/paws typecheck
pnpm --filter @wangjs-jacky/paws test
pnpm --filter @wangjs-jacky/paws build
```

Server：

```bash
pnpm --filter happy-server-self-host typecheck
pnpm --filter happy-server-self-host test
pnpm --filter happy-server-self-host build
```

Agent 和 wire 包：

```bash
pnpm --filter @wangjs-jacky/paws-agent typecheck
pnpm --filter @slopus/happy-wire typecheck
```

### 本地环境管理器

`environments/` 工具会创建隔离的本地环境，包括独立的 Happy 状态、server URL、web URL、端口和 fixture 项目：

```bash
pnpm env:new
pnpm env:use <name>
pnpm env:up
pnpm env:server
pnpm env:web
pnpm env:cli --help
pnpm env:cli codex
```

当你想测试功能但不想影响真实 `~/.happy` 状态时，它很有用。

## App 构建和 OTA 更新

当前 App 元数据定义在 `packages/happy-app/app.config.js`：

| 字段 | 值 |
|------|----|
| Slug | `paws` |
| App version | `1.7.1` |
| Production app name | `Paws` |
| Preview app name | `Paws (preview)` |
| Development app name | `Paws (dev)` |
| Production package / bundle ID | `build.paws` |
| Preview package / bundle ID | `build.paws.preview` |
| Development package / bundle ID | `build.paws.dev` |

Runtime 与 OTA 频道映射：

| `APP_ENV` | OTA channel | Runtime version |
|-----------|-------------|-----------------|
| `development` | `preview` | `22` |
| `preview` | `preview` | `22` |
| `production` | `production` | `23` |

只有 JS 兼容的改动适合通过 OTA 发布。自动 preview 和 production workflow 会跳过命中原生敏感配置的 diff；原生依赖、权限、Expo plugin、package ID、更新 URL 和 runtime version 变化都需要重新构建 App，安装匹配二进制后再手动发布对应 runtime。

## 故障排查

### App 看不到我的机器在线

先确认 App 和电脑使用同一套 server：

```bash
paws daemon status
cat ~/.happy/settings.json
echo "$HAPPY_SERVER_URL"
echo "$HAPPY_WEBAPP_URL"
```

再查看 daemon 日志：

```bash
LOG=$(ls -t ~/.happy/logs/*-daemon.log | head -1)
sed -n '1,80p' "$LOG"
```

常见原因：

- daemon 没有运行。
- 电脑和 App 指向了不同 server。
- 自托管 server 无法从手机访问。
- agent CLI 未安装或未登录。
- daemon 是在设置当前环境变量之前启动的。

### 二维码无效或扫码没反应

检查：

- App 和 CLI 是否来自匹配构建。
- 两端是否指向同一套 server。
- fork 构建的终端配对链接应是 `paws://terminal?...`。
- Paws 构建应使用 `paws://` app scheme。

### 鉴权打开了错误的 Web App

同时设置两个 URL：

```bash
export HAPPY_SERVER_URL=http://your-server:3005
export HAPPY_WEBAPP_URL=http://your-server:3005
```

如果只设置 `HAPPY_SERVER_URL`，CLI 可能连接你的自托管 API，但打开另一套 web app 做鉴权。

### 远程创建会话失败

查看 daemon spawn 错误：

```bash
LOG=$(ls -t ~/.happy/logs/*-daemon.log | head -1)
rg -n "spawn|Child PID|exited|timeout|Session started|Session reported" "$LOG"
```

常见原因：

- 请求的工作目录不存在。
- 目标 agent 命令不在 `PATH` 中。
- agent 未登录。
- daemon 进程继承的代理或网络设置与当前 shell 不一致。
- daemon 继承的是旧 `PATH` 或旧 Node 运行时。

### CLI 包版本太旧

```bash
npm view @wangjs-jacky/paws version
npm install -g @wangjs-jacky/paws@latest
paws --version
```

### 推送通知收不到

远程控制依赖 WebSocket 同步；推送通知只是便利层。推送失败时，前台 App 使用和手动刷新通常仍可工作。

检查：

- 手机通知权限。
- server 是否能访问推送服务。
- 当前安装的 App 构建是否包含推送配置。

### Agent 会话里附件失败

如果使用 S3 兼容存储，检查：

- `S3_HOST`
- `S3_BUCKET`
- `S3_PUBLIC_URL`
- `S3_PATH_STYLE`
- presigned 上传/下载 URL 是否能从 CLI 机器访问。

本地 standalone 存储会把 blob 写到配置的数据目录下。

## 推荐阅读

接下来可以看：

1. `README.md`：产品概览。
2. `docs/README.md`：文档索引。
3. `docs/cli-architecture.md`：CLI、daemon、本地状态和 agent runner。
4. `docs/backend-architecture.md`：server 内部结构。
5. `docs/api.md`：HTTP API 和鉴权。
6. `docs/encryption.md`：加密边界。
7. `docs/session-protocol.md`：加密聊天事件流。
8. `docs/selfhost-intranet-deploy.md`：更深入的自托管部署 walkthrough。

## 交接检查清单

把这套环境交给其他用户或团队成员前，确认：

- [ ] 对方安装了相互兼容的 Paws App 与 `@wangjs-jacky/paws` CLI。
- [ ] 对方知道应该使用哪套 server。
- [ ] 对方的手机或浏览器能访问该 server。
- [ ] 对方的 App 和 CLI pairing scheme 匹配。
- [ ] 对方已安装 `paws` CLI。
- [ ] 对方的目标 agent CLI 已安装并登录。
- [ ] `paws daemon status` 显示 daemon 健康。
- [ ] App 可以鉴权，并能看到机器在线。
- [ ] 可以从电脑启动一个测试会话。
- [ ] 可以从 App 启动一个测试会话。
- [ ] 自托管环境同时设置了 `HAPPY_SERVER_URL` 和 `HAPPY_WEBAPP_URL`。
- [ ] 团队或生产环境使用 HTTPS，或明确接受局域网 HTTP 策略。
