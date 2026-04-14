<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="/.github/logotype-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="/.github/logotype-light.png">
    <img src="/.github/logotype-dark.png" width="400" alt="Happy">
  </picture>
</div>

<h1 align="center">
  Claude Code 和 Codex 的移动端与网页端客户端
</h1>

<h4 align="center">
通过端到端加密，随时随地使用 Claude Code 或 Codex。
</h4>

<div align="center">
  
[📱 **iOS 应用**](https://apps.apple.com/us/app/happy-claude-code-client/id6748571505) • [🤖 **Android 应用**](https://play.google.com/store/apps/details?id=com.ex3ndr.happy) • [🌐 **网页应用**](https://app.happy.engineering) • [🎥 **查看演示**](https://youtu.be/GCS0OG9QMSE) • [📚 **文档**](https://happy.engineering/docs/) • [💬 **Discord**](https://discord.gg/fX9WBAhyfD) • [🌐 **English**](README.md)

</div>

<img width="5178" height="2364" alt="github" src="/.github/header.png" />


<h3 align="center">
步骤 1：下载应用
</h3>

<div align="center">
<a href="https://apps.apple.com/us/app/happy-claude-code-client/id6748571505"><img width="135" height="39" alt="appstore" src="https://github.com/user-attachments/assets/45e31a11-cf6b-40a2-a083-6dc8d1f01291" /></a>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<a href="https://play.google.com/store/apps/details?id=com.ex3ndr.happy"><img width="135" height="39" alt="googleplay" src="https://github.com/user-attachments/assets/acbba639-858f-4c74-85c7-92a4096efbf5" /></a>
</div>

<h3 align="center">
步骤 2：在电脑上安装 CLI
</h3>

```bash
npm install -g happy
```

> 从 `happy-coder` 包迁移而来。感谢 [@franciscop](https://github.com/franciscop) 捐赠 `happy` 包名称！

<h3 align="center">
步骤 3：开始使用 `happy` 替代 `claude` 或 `codex`
</h3>

```bash
# 代替 claude，使用：
happy claude
# 或者
happy codex
```

## 工作原理？

在电脑上，运行 `happy` 代替 `claude`，或运行 `happy codex` 代替 `codex`，通过我们的包装器启动 AI。当你想从手机控制编码代理时，它会在远程模式下重启会话。要切换回电脑，只需按键盘上的任意键。

## 🔥 为什么选择 Happy Coder？

- 📱 **移动端访问 Claude Code 和 Codex** - 离开办公桌时也能查看 AI 正在构建什么
- 🔔 **推送通知** - 当 Claude Code 和 Codex 需要权限或遇到错误时收到提醒
- ⚡ **瞬间切换设备** - 一键从手机或桌面接管控制
- 🔐 **端到端加密** - 你的代码在设备上始终加密传输
- 🛠️ **开源** - 自行审计代码。无遥测，无追踪

## 📦 项目组件

- **[Happy App](https://github.com/slopus/happy/tree/main/packages/happy-app)** - 网页 UI + 移动端客户端（Expo）
- **[Happy CLI](https://github.com/slopus/happy/tree/main/packages/happy-cli)** - Claude Code 和 Codex 的命令行界面
- **[Happy Agent](https://github.com/slopus/happy/tree/main/packages/happy-agent)** - 远程代理控制 CLI（创建、发送、监控会话）
- **[Happy Server](https://github.com/slopus/happy/tree/main/packages/happy-server)** - 加密同步的后端服务器

## 🏠 我们是谁

我们是散布在湾区咖啡店和黑客屋的工程师们，总是在午休时不断检查 AI 编码代理在个人项目上的进展。Happy Coder 诞生于一种挫败感——当我们离开键盘时，无法窥探 AI 编码工具正在如何构建我们的副业。我们相信最好的工具源于解决自身痛点并与社区分享。

## 📚 文档与贡献

- **[文档网站](https://happy.engineering/docs/)** - 学习如何有效使用 Happy Coder
- **[贡献指南](docs/CONTRIBUTING.md)** - 如何贡献、PR 指南和开发设置
- **[在 github.com/slopus/slopus.github.io 编辑文档](https://github.com/slopus/slopus.github.io)** - 帮助改进我们的文档和指南

## 许可证

MIT 许可证 - 详见 [LICENSE](LICENSE)。
