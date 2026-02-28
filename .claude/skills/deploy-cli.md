---
name: deploy-cli
description: 构建并全局安装 happy-cli，重启 daemon
---

# CLI 工具部署

构建 happy-cli 包，全局安装，并重启 daemon。

## 执行步骤

逐步执行 `deploy/build-cli.sh` 的内容，提供进度反馈：

### 步骤 1：清理旧构建产物

```bash
cd /home/coder/workspaces/happy/packages/happy-cli
rm -f happy-next-cli-*.tgz
```

### 步骤 2：构建 CLI

```bash
cd /home/coder/workspaces/happy/packages/happy-cli
npm run build
```

完成后反馈：CLI 构建成功

### 步骤 3：打包并全局安装

```bash
cd /home/coder/workspaces/happy/packages/happy-cli
TARBALL=$(npm pack)
npm install -g "./$TARBALL"
```

完成后反馈：已全局安装，展示安装的包名和版本

### 步骤 4：重启 daemon

```bash
happy daemon stop && happy daemon start
```

完成后反馈：daemon 已重启

## 返回格式

向用户展示：

- **构建结果**: 成功/失败
- **安装包**: 包名和版本
- **Daemon 状态**: 重启结果
