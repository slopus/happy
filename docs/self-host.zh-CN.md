# 自托管（Docker Compose）

[🇬🇧 English](self-host.md)

本仓库支持两种模式：

- **托管（默认）：** 客户端开箱即用 `https://api.happy.hitosea.com/`。
- **自托管：** 使用根目录的 `docker-compose.yml` 运行你自己的 `happy-server`（API + WebSocket）和 `happy-voice`（语音网关）。

本指南文档化了**自托管**路径。

## 前提条件

- Docker + Docker Compose
- LiveKit 部署（不包含在 `docker-compose.yml` 中）
  - 在 `.env` 中设置 `LIVEKIT_URL`、`LIVEKIT_WS_URL`、`LIVEKIT_API_KEY`、`LIVEKIT_API_SECRET`
- 语音网关的 API 密钥（用于本仓库的默认供应商）
  - `OPENAI_API_KEY`、`CARTESIA_API_KEY`

## 快速开始

1. 创建环境文件：

```bash
cp .env.example .env
```

2. 编辑 `.env` 并填写必需的值。

本地自托管最少需要：
- `HANDY_MASTER_SECRET`
- `POSTGRES_*`
- `S3_*`（或使用 MinIO 默认值）
- LiveKit + 语音密钥（`LIVEKIT_*`、`OPENAI_API_KEY`、`CARTESIA_API_KEY`）

3. 启动 stack：

```bash
docker-compose up -d
```

4. 执行数据库迁移（仅首次运行）：

```bash
docker-compose exec happy-server yarn --cwd packages/happy-server prisma migrate deploy
```

5. 打开 Web 应用：

- `http://localhost:3030`

自托管使用独立源（无路径反向代理）。配置：
- `EXPO_PUBLIC_HAPPY_SERVER_URL=http://localhost:3031`
- `EXPO_PUBLIC_VOICE_BASE_URL=http://localhost:3040`

## CLI：指向你的自托管服务器

CLI 默认使用托管 API。自托管时，运行时设置环境变量：

```bash
HAPPY_SERVER_URL=http://localhost:3031 HAPPY_WEBAPP_URL=http://localhost:3030 happy
```

## 移动应用：指向你的自托管服务器

- **开发构建：** 启动 Expo 时设置 `EXPO_PUBLIC_HAPPY_SERVER_URL`，或使用应用内服务器设置页面（如果可用）。
- **生产构建：** 使用应用内服务器设置页面设置自定义服务器 URL。

## S3 / MinIO 注意事项（重要）

`S3_PUBLIC_URL` 必须能被客户端（浏览器/移动端）访问，而不仅仅是容器。

- 本地 Docker Compose 中，MinIO 暴露在 `http://localhost:3050`，所以 `S3_PUBLIC_URL=http://localhost:3050` 可以正常工作。
- 远程自托管时，你通常需要一个真正的 S3 兼容端点和一个与你的 TLS/主机配置匹配的公共 URL。

## 远程访问

如果你从其他设备（局域网或互联网）访问 Web 应用，避免硬编码 `localhost` URL。

推荐做法：
- 将 Web 应用、API 和语音网关放在域名后面（TLS）。
- 将 `EXPO_PUBLIC_HAPPY_SERVER_URL` 和 `EXPO_PUBLIC_VOICE_BASE_URL` 设置为这些公共源。
- 将 `APP_URL` 设置为你的 Web 源（用于某些连接流程）。

## 故障排查

- 检查容器：`docker-compose ps`
- 查看日志：
  - `docker-compose logs -f happy-server`
  - `docker-compose logs -f happy-voice`
- 验证主机端口：
  - Web：`3030`
  - API：`3031`
  - Voice：`3040`
  - MinIO：`3050`
