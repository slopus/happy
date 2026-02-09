---
name: expo-coder
description: 通过 code-server 端口转发启动 Expo 开发模式，无需 ngrok tunnel
---

# Expo Code-Server 开发启动器

通过 code-server 内置端口转发启动 happy-app，速度比 ngrok tunnel 快。

## 执行步骤

1. 先结束已有的 Expo/Metro 进程
2. 启动 Expo 并设置 `EXPO_PACKAGER_PROXY_URL` 为 code-server 代理地址
3. 返回连接信息给用户

## 操作流程

```bash
# 1. 清理旧进程
pkill -f "expo start" 2>/dev/null
pkill -f "metro" 2>/dev/null
sleep 1

# 2. 启动 Expo（通过 code-server 端口转发）
EXPO_PACKAGER_PROXY_URL=https://8081--main--dootask--kuaifan.coder.hitosea.com yarn workspace happy-app start
```

## 返回格式

向用户展示：

- **Code-Server URL**: `https://8081--main--dootask--kuaifan.coder.hitosea.com`
- **提示**: 在 Expo Go 中手动输入上面的 URL 连接
