---
name: deploy-server
description: 部署主服务（server + webapp + voice），包含前置检查和构建进度反馈
---

# 主服务部署

构建并部署 happy-server、happy-app（webapp）、happy-voice 三个 Docker 镜像，然后用 docker compose 拉起所有服务。

## 前置检查

部署前必须执行以下检查，任一不通过则**暂停并提示用户**：

1. **未提交更改检查**：运行 `git status --porcelain`，如果有未提交的更改，警告用户 `git reset --hard origin/dev` 会丢失这些更改，询问是否继续
2. **分支状态检查**：运行 `git fetch origin && git log HEAD..origin/dev --oneline`，展示即将拉取的新提交，让用户确认
3. **Docker 可用性检查**：运行 `docker info`，确认 Docker daemon 正在运行

## 执行步骤

通过逐步执行 `deploy/build-server-web-voice-up.sh` 的内容来提供进度反馈，而不是直接运行整个脚本：

### 步骤 1：同步代码

```bash
cd /home/coder/workspaces/happy
git fetch origin
git reset --hard origin/dev
```

完成后反馈：代码已同步到 origin/dev 最新提交 `<commit hash>`

### 步骤 2：构建 happy-server 镜像

```bash
cd /home/coder/workspaces/happy
docker build -f Dockerfile.server -t happy-server:latest .
```

完成后反馈：happy-server 镜像构建成功

### 步骤 3：构建 happy-app（webapp）镜像

```bash
cd /home/coder/workspaces/happy
docker build -f Dockerfile.webapp -t happy-app:latest .
```

完成后反馈：happy-app 镜像构建成功

### 步骤 4：构建 happy-voice 镜像

```bash
cd /home/coder/workspaces/happy/packages/happy-voice
docker build -f Dockerfile -t happy-voice:latest .
```

完成后反馈：happy-voice 镜像构建成功

### 步骤 5：启动服务

```bash
cd /home/coder/workspaces/happy/deploy
docker compose up -d
```

完成后反馈：所有服务已启动，运行 `docker compose ps` 展示服务状态

## 返回格式

向用户展示部署摘要：

- **同步提交**: `<commit hash> <message>`
- **镜像构建**: server / webapp / voice 各自的构建结果
- **服务状态**: docker compose ps 输出
- **耗时**: 总部署时间
