# Paws Plugin Host v2 设计

状态：第一阶段已实现；本文保留为历史设计记录，当前总览见 [`../plugin-system-overview.md`](../plugin-system-overview.md)
日期：2026-08-28

## 决策

Paws Plugin Host v2 组合两套成熟模式：

- 使用 VS Code 风格的 Manifest、Contribution Points、受控 UI 表面和按需解析；
- 使用 DeepSeek Harness/Cordis 风格的 Service seam、依赖声明和可逆生命周期；
- 保留 Paws privileged Kernel，不允许插件替换认证、密钥、权限、审计、导航骨架或更新契约。

第一阶段是“动态声明 + 受信任 Adapter”，不是任意代码下载器。插件仓库可独立发布清单和纯业务逻辑，但 UI/Server 可执行 Adapter 仍随经过审核的 Paws 版本构建。后续只有在签名、撤销、授权、隔离运行时和供应链审计完成后，才评估第三方 Web/Tauri bundle。

## 稳定接口

### Manifest

`PluginManifestV2` 是发现和安装前可读取的静态声明：

- `schemaVersion: 2`：Wire 结构版本；
- `hostApiVersion: 1`：Plugin Host API 主版本；
- `permissions`：插件可能调用的宿主能力；
- `contributes.views`：页面、左栏、右栏、弹窗贡献，View ID 必须以 `<pluginId>.` 为命名空间；
- `entrypoint`：`view` 引用 `page`；`configuration` 引用 `modal`，从而支持没有独立页面的纯配置插件；
- `configuration`：由 Host 渲染和加密保存的声明式字段。

Manifest 不得包含路径、URL、JavaScript、组件名或动态 import 目标。

### UI Slot

第一批 surface：

| Surface | 宿主位置 | 当前样例 |
|---|---|---|
| `page` | Expo Router 页面入口 | 军师对话、生成图片画廊 |
| `left-sidebar` | 账号级左栏列表 | 军师历史 |
| `right-panel` | 会话级能力面板 | 会话图片 |
| `modal` | 用户动作触发的对话框 | 军师配置声明 |

Host 解析贡献时必须同时满足：安装存在、版本精确匹配、账号授权集合与 Manifest 声明一致、View 已声明、surface 匹配、存在本地受信任 Adapter。Adapter 通过 `register()` 挂载并获得幂等 `dispose()`；停用 Adapter、卸载、版本过期或授权不完整都会让解析结果立刻变为空，这就是第一阶段的 reversible effect。

### Capability Broker

第一批权限：

- `paws.ai.provider.invoke`：由 Paws Server 代表插件调用 AI Provider；
- `paws.secrets.use`：只允许服务端能力使用已加密 Secret，不向 App 返回明文；
- `paws.conversations.images.read`：读取会话生成图片投影；
- `paws.storage.images.write`：写入或删除插件自有图片对象。

业务 Runtime 必须通过一次 `openRuntime(accountId, pluginId, requiredPermissions)` 读取安装记录，在同一门禁内检查安装、版本、Manifest 声明和账号授权，再使用经过插件归一化的短生命周期配置。Manifest 隐藏、UI `when` 条件和安装按钮都不能替代服务端权限检查。

## 生命周期

```text
catalogued -> installed/current/granted -> contributions active
                               | update/version or grant stale
                               v
                         contributions retracted
                               | uninstall
                               v
                   encrypted installation deleted
```

第一阶段不单独持久化 activation 状态。客户端从账号 Catalog 派生 UI contribution；服务端从同一 Installation Store 派生 capability authorization。后续加入可执行 runtime 时，再扩展 `PENDING / ACTIVE / FAILED / DISPOSED` 与统一 `Disposable`，不改变现有 Manifest/Slot seam。

## 当前两个插件的迁移

- Relationship Advisor 贡献 `page + left-sidebar + modal`，并声明 AI、Secret、会话图片权限；专用 Provider Runtime 必须经过 Broker 门禁。
- Generated Images Gallery 贡献 `page + right-panel`，并声明会话图片读取权限；右侧图片能力仅在贡献激活时出现。

## 暂不实现

- 从 Git/npm 下载后直接执行插件代码；
- React Native 远程 bundle；
- 插件自定义任意路由、HTML/WebView 或网络 URL；
- 插件覆盖核心 Service；
- 仅靠 Extension Host 进程假装获得安全沙箱。

完整调研和一手资料见 [`../research/plugin-host-reference.md`](../research/plugin-host-reference.md)。开发者规范见 [`../plugin-development.md`](../plugin-development.md)。
