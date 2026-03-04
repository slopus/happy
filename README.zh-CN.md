<div align="center"><img src="/.github/logotype-dark.png" width="400" title="Happy Next" alt="Happy Next"/></div>

<h1 align="center">
  Claude Code、Codex 和 Gemini 的移动端和 Web 客户端
</h1>

<h4 align="center">
随时随地使用 Claude Code、Codex 或 Gemini，端到端加密。
</h4>

<div align="center">

[🌐 **GitHub**](https://github.com/hitosea/happy) • [🖥️ **Web 应用**](https://happy.hitosea.com/) • [📚 **文档**](docs/README.md) • [🇬🇧 **English**](README.md)

</div>

<img width="5178" height="2364" alt="github" src="/.github/header.png" />


<h3 align="center">
第一步：在你的电脑上安装 CLI
</h3>

```bash
npm install -g happy-next-cli
```

<h3 align="center">
第二步：用 `happy` 代替 `claude`、`codex` 或 `gemini`
</h3>

```bash

# 原来用: claude
# 现在用: happy

happy

# 原来用: codex
# 现在用: happy codex

happy codex

# 原来用: gemini
# 现在用: happy gemini

happy gemini

```

运行 `happy` 会打印一个二维码用于设备配对。

- 打开 `https://happy.hitosea.com/` 扫描二维码（或点击终端中显示的链接）。
- 前提：安装你想要控制的供应商 CLI（`claude`、`codex` 和/或 `gemini`）。

<div align="center"><img src="/.github/mascot.png" width="200" title="Happy Next" alt="Happy Next"/></div>

## 自托管（Docker Compose）

Happy Next 默认使用托管服务器（`https://api.happy.hitosea.com`）和托管 Web 应用（`https://happy.hitosea.com/`）。

如果你想自托管：

```bash
cp .env.example .env
# 编辑 .env

docker-compose up -d
```

注意：默认的 stack 也会启动 `happy-voice`。你必须在 `.env` 中配置 LiveKit + 供应商密钥（OpenAI/Cartesia 等）。详见 [docs/self-host.zh-CN.md](docs/self-host.zh-CN.md)。

首次运行（执行数据库迁移）：

```bash
docker-compose exec happy-server yarn --cwd packages/happy-server prisma migrate deploy
```

打开 Web 应用：`http://localhost:3030`。

完整指南：[docs/self-host.zh-CN.md](docs/self-host.zh-CN.md)

将 CLI 指向你自托管的 API：

```bash
HAPPY_SERVER_URL=http://localhost:3031 HAPPY_WEBAPP_URL=http://localhost:3030 happy
```

## 兼容性说明

Happy Next 在品牌重塑中有意更改了客户端 KDF 标签。请将其视为**全新一代**：不要期望旧客户端创建的加密数据能被 Happy Next 读取（反之亦然）。

## Happy Next 新特性

Happy Next 是原版 Happy 的重大演进，以下是亮点：

### 多 Agent 支持（Claude Code + Codex + Gemini）
- 三个 Agent 均为一等公民，支持会话恢复、复制/分叉和历史记录
- 多 Agent 历史页面，按供应商分标签页
- 按 Agent 选择模型、费用追踪和上下文窗口显示
- Codex 支持 ACP 和 App-Server（JSON-RPC）两种后端
- AI 后端配置文件，内置 DeepSeek、Z.AI、OpenAI、Azure 和 Google AI 预设

### 语音助手（Happy Voice）
- 基于 LiveKit 的语音网关，支持可插拔的 STT/LLM/TTS 供应商
- 麦克风静音、语音消息发送确认、"思考中"指示器
- 上下文感知语音：应用状态自动注入到语音 LLM
- 按前缀自动切换供应商（如 `openai/gpt-4.1-mini`、`cartesia/sonic-3`）

### 多仓库工作树工作区
- 从应用中创建、切换和归档多仓库工作区
- 按仓库选择分支、设置和脚本
- 跨仓库聚合 git 状态
- 自动生成工作区 `CLAUDE.md` / `AGENTS.md`（含 `@import` 引用）
- 工作树合并和 PR 创建，支持目标分支选择
- AI 驱动的 PR 代码审查，结果发布为 GitHub 评论

### 代码浏览器和 Git 管理
- 完整的文件浏览器，支持搜索、Monaco 编辑器查看/编辑
- 提交历史，支持分支选择器（本地 + 远程）
- Git 变更页面：暂存、取消暂存、提交、丢弃
- 按文件差异统计（+N/-N），支持 Claude、Codex 和 Gemini

### 会话共享
- 直接邀请好友或通过公开链接分享会话
- 端到端加密：直接分享使用 NaCl Box，公开链接使用 token 派生密钥
- 实时同步消息、git 状态和语音聊天
- 按访问级别（查看/编辑/管理）控制权限
- 会话列表"全部/共享给我"过滤标签和共享指示器
- 公开分享网页查看器，无需安装应用即可访问

### OpenClaw 网关
- 通过中继隧道或直连 WebSocket 连接外部 AI 机器
- Ed25519 密钥交换进行机器配对
- 聊天界面，支持实时流式传输和会话管理

### DooTask 集成
- 任务列表，支持过滤、搜索、分页和状态工作流
- 任务详情，支持 HTML 渲染、负责人、文件、子任务
- 实时 WebSocket 聊天（Slack 风格布局、表情回应、语音回放、图片/视频）
- 从任一任务一键启动 AI 会话（MCP 服务透传）
- 在应用内直接创建任务和项目，跨平台日期选择器

### 自托管
- 一条命令 `docker-compose up`（Web + API + Voice + Postgres + Redis + MinIO）
- 独立源架构（无路径反向代理）
- `.env.example` 包含完整配置参考
- Docker 构建的运行时环境变量注入

### 同步和可靠性
- v3 消息 API，基于 seq 的同步、批量写入和游标分页
- WebSocket 不可用时的 HTTP 发件箱可靠投递
- 服务端确认消息发送，支持重试
- 修复游标跳过、发件箱竞争、消息重复/丢失

### 聊天和会话体验
- 图片附件和剪贴板粘贴（Web）
- `/duplicate` 命令从任意消息分叉会话
- 消息分页、未读蓝点指示器、紧凑列表视图
- 会话重命名并锁定（防止 AI 自动更新）、历史搜索
- 选项点击发送 / 长按填充、滚动到底部按钮
- 下拉刷新、内嵌分隔线、Agent tool 展示（机器人图标）
- 工具输入/输出格式化为 key-value 对（替代原始 JSON）
- 内存 SWR 缓存和 Agent 会话历史搜索
- CLI：`happy update` 自更新、`happy --version` 显示所有 Agent 版本

### Bug 修复和稳定性
- 200+ Bug 修复：消息发送可靠性、会话生命周期、Markdown 渲染、导航、语音、DooTask、共享
- 安全：Shell 命令注入修复、计划模式权限处理
- 性能：移动端载荷精简、延迟加载 diff、渲染优化

### UI 和打磨
- 全应用暗色模式修复
- i18n 改进（简体中文/繁体中文、CJK 输入处理）
- Markdown 渲染：表格、内联代码、嵌套代码块、可点击文件路径
- 键盘处理、加载状态、导航稳定性

完整变更日志：[docs/changes-from-happy.zh-CN.md](docs/changes-from-happy.zh-CN.md)

## 工作原理

在电脑上运行 `happy` 代替 `claude`，`happy codex` 代替 `codex`，或 `happy gemini` 代替 `gemini`，通过我们的包装器启动你的 AI。当你想从手机上控制编码 Agent 时，它会以远程模式重启会话。要切换回电脑，只需按键盘上的任意键。

## 为什么选择 Happy Next？

- 🎛️ **Claude、Codex 和 Gemini 的远程控制** — 三个 Agent 均为一等公民
- ⚡ **即时设备切换** — 一键夺回控制权
- 🔔 **推送通知** — 随时知道你的 Agent 需要关注
- 🔐 **端到端加密 + 可自托管** — 默认加密，一条命令 Docker 部署
- 🎙️ **语音助手** — 基于 LiveKit 的语音网关，可插拔 STT/LLM/TTS 供应商
- 🧰 **多仓库工作区** — 基于工作树的多仓库工作流，支持分支选择和 PR 创建
- 📁 **代码浏览器和 Git 管理** — 从手机浏览文件、查看 diff、暂存/提交/丢弃
- 📋 **DooTask 集成** — 任务管理，实时聊天，一键 AI 会话

## 项目组件

- **[Happy App](packages/happy-app)** — Web UI + 移动客户端（Expo）
- **[Happy CLI](packages/happy-cli)** — Claude Code、Codex 和 Gemini 的命令行界面
- **[Happy Server](packages/happy-server)** — 加密同步后端服务器
- **[Happy Voice](packages/happy-voice)** — 语音网关（基于 LiveKit）
- **[Happy Wire](packages/happy-wire)** — 共享线路类型和 Schema

## 关于我们

我们开发 Happy Next，是因为我们想在任何地方（Web/移动端）监控编码 Agent，同时不放弃控制权、隐私或自托管的选择。

## 文档和贡献

- **[文档](docs/README.md)** — 了解 Happy Next 的工作原理（协议、部署、自托管、架构）
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — 开发环境搭建和贡献指南
- **[SECURITY.md](SECURITY.md)** — 安全漏洞报告政策
- **[SUPPORT.md](SUPPORT.md)** — 支持与故障排查

## 许可证

MIT 许可证 — 详见 [LICENSE](LICENSE)。
