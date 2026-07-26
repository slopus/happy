<div align="center">
  <img src="/.github/paws-mascot.jpg" width="300" alt="Paws 吉祥物 —— 穿爪印卫衣的土拨鼠">

  <h1>Paws</h1>

  <h4>用手机远程操控电脑上正在运行的 AI 编程 Agent。</h4>

  <p>
    在电脑上运行 <code>paws claude</code> 或 <code>paws codex</code>，
    然后用手机或网页 App 查看进度、发送指令、处理权限请求。<br>
    全程端到端加密，可完全自托管。
  </p>

[![npm](https://img.shields.io/npm/v/%40wangjs-jacky%2Fpaws?label=%40wangjs-jacky%2Fpaws&color=f59e0b)](https://www.npmjs.com/package/@wangjs-jacky/paws)
[![Android APK](https://img.shields.io/github/v/release/wangjs-jacky/happy?label=Android%20APK&color=34d399)](https://github.com/wangjs-jacky/happy/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[🌐 **官网**](https://paws-landing-eo4.pages.dev) • [🖥️ **Web App**](https://47.115.228.20:8443/) • [🚀 **Web 自部署**](docs/selfhost-web-deploy.zh-CN.md) • [📱 **Android APK**](https://github.com/wangjs-jacky/happy/releases) • [📦 **npm CLI**](https://www.npmjs.com/package/@wangjs-jacky/paws) • [📚 **从零上手**](docs/getting-started.zh-CN.md) • [🇬🇧 **English**](README.md)

</div>

---

> **Paws** 是一个独立维护的产品与代码线，最初源自 [Happy](https://github.com/slopus/happy)。
> 它拥有自己的 App 构建、CLI 包、发布链路、Roadmap 和官网。GitHub 保留的 fork 关系用于历史署名，
> 不代表 Paws 需要持续同步上游。

## 🚀 快速开始

**1. 在电脑上安装 CLI**

```bash
npm install -g @wangjs-jacky/paws
```

安装后提供 `paws` 与 `happy` 两个命令（另有 `paws-mcp` / `happy-mcp` 用于 MCP 集成）。

**2. 打开 Web App 或安装手机 App**

在现代浏览器中打开已部署的 [**Paws Web App**](https://47.115.228.20:8443/)，
或者从 [GitHub Releases](https://github.com/wangjs-jacky/happy/releases) 下载最新
**Android APK**（arm64，直接 sideload 安装）。

**3. 包裹你的 Agent 并配对**

```bash
# 把 claude / codex 换成：
paws claude
# 或
paws codex
```

用 App 扫描终端里的二维码完成配对——之后该会话就会实时镜像到手机上。

**4.（可选）让手机能远程新建会话**

```bash
paws daemon start
```

daemon 常驻后，App 可以远程在这台电脑上直接拉起全新会话，无需人到电脑前。

源码安装、server 选项、App 构建与排障，请阅读
[从零上手指南](docs/getting-started.zh-CN.md)（[English](docs/getting-started.md)）。

## 🐾 为什么选 Paws？

- 📱 **随时随地遥控编程 Agent** —— 支持 Claude Code、Codex、Gemini、OpenCode 及其他 ACP 兼容 Agent
- 🔔 **可靠的推送通知** —— Android 由 FCM 承载、当前经 Expo Push 服务投递，App 在前台时也照常弹通知
- 🖼️ **完整的图片工作流** —— 新建会话即可附图、HEIC 自动转换、全屏图片查看器
- ⚡ **一键切换设备** —— 手机接管或键盘任意键收回，无缝衔接
- 🔐 **端到端加密** —— 同步服务器只中转密文，代码与对话内容全程私密
- 🏠 **可完全自托管** —— 同步服务器（Docker + 零配置 PGlite）和 OTA 更新通道都可以自己搭

## 🔧 工作原理

```text
手机 / 网页 App
    |
    |  HTTP + WebSocket，端到端加密载荷
    v
同步服务器（自托管或上游官方）
    |
    |  加密同步、机器在线状态、会话状态
    v
电脑上的 paws CLI / daemon
    |
    v
Claude Code / Codex / Gemini / OpenCode / ACP 兼容 Agent
```

CLI 包裹住 Agent 的终端会话：平时在电脑上照常使用；从手机接管时自动切到远程模式，
在键盘上按任意键即可收回控制权。

## ✨ Paws 增加了什么？

| 方向 | Paws 的做法 |
|------|------------|
| **品牌** | 土拨鼠吉祥物、`Paws` 应用名、专属启动页与吉祥物联动主题色 |
| **CLI 分发** | 以 [`@wangjs-jacky/paws`](https://www.npmjs.com/package/@wangjs-jacky/paws) 发布到 npm，CI 走 trusted publishing |
| **Android 推送** | Android 使用 FCM 承载，当前服务端经 Expo Push 服务投递；前台也弹通知，点击直达会话 |
| **图片能力** | 恢复图片上传、新建会话首屏附件、全屏查看器、HEIC 归一化（视觉模型可读） |
| **OTA 更新** | 自建 OTA 链路，`preview` / `production` 双频道、每个 PR 自动出预览包，配套[版本浏览站](https://wangjs-jacky.github.io/happy-ota-site/)扫码锁定任意历史版本 |
| **附加能力** | 基于个人 Markdown 笔记的健康打卡面板、桌面截图采集、会话 attach 命令，以及持续不断的体验修复 |

## 📦 项目组成

| 包 | 说明 |
|----|------|
| [`packages/happy-app`](packages/happy-app) | 移动端 + 网页客户端（Expo），即 **Paws** App |
| [`packages/happy-cli`](packages/happy-cli) | `paws` CLI —— 包裹 Claude Code / Codex，含 daemon 与 MCP 工具 |
| [`packages/happy-server`](packages/happy-server) | 可自托管的同步服务器，内置网页版 App |
| [`packages/happy-agent`](packages/happy-agent) | 远程操控 Agent 的 CLI（创建 / 发送 / 监控会话） |
| [`packages/happy-wire`](packages/happy-wire) | 共享消息类型与 Zod schema |

相关仓库：

- [`paws-landing`](https://github.com/wangjs-jacky/paws-landing) —— [产品官网](https://paws-landing-eo4.pages.dev)，用 AI 驱动的「设计 → 上线」流水线打造
- [`happy-ota-site`](https://github.com/wangjs-jacky/happy-ota-site) —— OTA 版本浏览站（扫码锁定任意版本）

## 🏠 自托管

同步服务器是单个 Docker 容器，内嵌零配置 PGlite（也可外接 PostgreSQL）。
把 CLI 和 App 指向它即可闭环，数据不出内网：

```bash
export HAPPY_SERVER_URL=http://your-server:3005
paws claude
```

完整步骤见[从零上手指南](docs/getting-started.zh-CN.md)、
[Web 自部署手册](docs/selfhost-web-deploy.zh-CN.md)与
[内网部署手册](docs/selfhost-intranet-deploy.md)。Web 手册同时覆盖域名证书、
Let’s Encrypt 公网 IP 证书、手工更新、自动部署脚本和回滚。

## 🙏 致谢

Paws 源自 [slopus](https://github.com/slopus) 团队的 [**Happy**](https://github.com/slopus/happy)
—— 一个非常出色、慷慨采用 MIT 协议的开源项目。npm 上的 `happy` 包以及 App Store / Play
商店中的 Happy 应用均属原项目；Paws 使用自己的 CLI（`@wangjs-jacky/paws`）与自己的 App 构建。

## 📄 许可证

MIT —— 详见 [LICENSE](LICENSE)。
