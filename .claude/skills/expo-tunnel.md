---
name: expo-tunnel
description: 启动 Expo tunnel 开发模式，返回公网 URL 供手机连接
---

# Expo Tunnel 开发启动器

启动 happy-app 的 Expo tunnel 模式，获取公网 URL。

## 执行步骤

1. 先结束已有的 Expo/Metro 进程
2. 后台启动 `yarn workspace happy-app start --tunnel`
3. 等待 tunnel 连接成功（轮询 ngrok API）
4. 从 ngrok API 获取公网 URL
5. 保存 URL 到 `.expo-tunnel` 文件
6. 返回连接信息给用户

## 操作流程

```bash
# 1. 清理旧进程
pkill -f "expo start" 2>/dev/null
pkill -f "metro" 2>/dev/null
sleep 1

# 2. 后台启动 tunnel
yarn workspace happy-app start --tunnel &

# 3. 轮询等待 tunnel 就绪（最多 60 秒）
for i in {1..12}; do
  URL=$(curl -s http://localhost:4040/api/tunnels 2>/dev/null | jq -r '.tunnels[] | select(.proto=="https") | .public_url' 2>/dev/null)
  if [ -n "$URL" ] && [ "$URL" != "null" ]; then
    break
  fi
  sleep 5
done

# 4. 保存到文件
echo "$URL" > .expo-tunnel

# 5. 显示结果
cat .expo-tunnel
```

## 输出文件

URL 会保存到项目根目录的 `.expo-tunnel` 文件，方便随时查看：

```bash
cat .expo-tunnel
```

## 返回格式

向用户展示：

- **Tunnel URL**: `https://xxx.exp.direct`
- **Expo Go 连接**: `exp://xxx.exp.direct`
- **文件位置**: `.expo-tunnel`
- **提示**: tunnel 模式热更新稍慢，摇一摇手机打开开发者菜单
