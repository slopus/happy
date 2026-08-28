# Paws Plugin Host 参考架构调研

> 调研日期：2026-08-28
>
> 调研范围：VS Code 官方 Extension API / Extension Host、DeepSeek 官方 DeepSeek Harness，以及 Paws 当前 App + Server 实现。
>
> 本文记录 Manifest v2 实现前的调研基线与架构输入；现行机器可读契约仍以 [`happy-wire/src/plugins.ts`](../../packages/happy-wire/src/plugins.ts) 为准。

## 1. 结论先行

Paws 当前实现是一个**清单驱动、按账号安装、构建时集成可信代码**的功能注册表。它已经具备市场、安装/更新/卸载、服务端加密配置和版本门禁，但还没有一个能让插件独立贡献 UI 与宿主能力的 Plugin Host。

目标系统不应直接复制 VS Code 或 DeepSeek Harness，而应组合两者的长处：

1. 借鉴 VS Code 的 **Manifest + Contribution Points + 稳定 Host API + 按需激活 + 多运行时入口**；插件只能通过宿主声明的插槽和能力进入产品，不能修改 Paws 内部组件树。
2. 借鉴 DeepSeek Harness/Cordis 的 **Service Definition / Provider / Consumer、依赖注入、typed events 和可逆 effect**；插件安装、禁用、更新、卸载时，其注册项和资源必须沿同一生命周期清理。
3. 借鉴 DeepSeek Harness Web Client 的 **typed slots**，但不要照搬其仅面向 Web React 的完整实现；Paws 的 Slot Contract 应独立于 React Native renderer，并由 Web/Tauri/iOS/Android 各宿主表面投影。
4. Paws 必须保留一个**不可插件化的安全内核**：身份认证、授权、密钥保险库、插件验签/撤销、能力代理、审计、数据库迁移和客户端更新契约不能被市场插件替换。
5. 第一阶段继续采用**受信任代码 + 动态贡献注册**。跨端第三方插件优先使用声明式 UI；任意远程 JavaScript/React 只适合以后在 Web/Tauri 的隔离运行时试验，不能成为移动端共同基线。

因此，下一版不应只给现有 Manifest 增加几个 route 字段，而应定义新的 `Plugin SDK / Plugin Host / Capability Broker / UI Slot Registry / Plugin Runtime` 边界。

## 2. “DeepSeek Harness” 身份核实

用户所说的项目几乎可以确定是 DeepSeek 官方的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，而不是泛指 DeepSeek API 的某个封装：

- [DeepSeek 官方发布页](https://www.deepseek.com/harness/)直接以 “Everything is a plugin” 介绍该项目，并列出模型、工具、技能、会话、沙箱、存储、循环、调度和 UI 等插件能力。
- [官方仓库 README](https://github.com/deepseek-ai/deepseek-harness)明确说明它由 DeepSeek AI 开发、基于 Cordis，当前仍为 Developer Preview，并可能发生破坏兼容的变化。
- [官方架构文档（固定 revision）](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/architecture.md)与发布页的插件化描述一致。

容易混淆的 [Cordis](https://github.com/cordiverse/cordis) 是 DSH 使用的底层插件元框架，不是另一个 DeepSeek 产品；社区 `dsh-plugin` 仓库也只是第三方生态。名称本身已没有实质歧义，尚需产品层决定的是：Paws 要借鉴 Cordis 内核、Profile/Bundle 组合，还是连 UI Slot 一并吸收。本文分别评估这三层。

## 3. Paws 调研基线状态（Manifest v2 实现前）

### 3.1 已经具备

- [`PluginManifestSchema`](../../packages/happy-wire/src/plugins.ts) 定义了插件身份、SemVer、展示文案、安装后动作、受信任 route ID 和动态配置字段。
- [`pluginDefinitions.ts`](../../packages/happy-server/sources/modules/plugins/pluginDefinitions.ts) 从固定 Git SHA 的 `@paws/plugins` 读取第一方定义，并再次通过 Wire schema 校验。
- [`pluginRegistry.ts`](../../packages/happy-server/sources/modules/plugins/pluginRegistry.ts) 负责目录、安装、更新、卸载、配置归一化和精确版本门禁。
- [`pluginInstallationStore.ts`](../../packages/happy-server/sources/modules/plugins/pluginInstallationStore.ts) 以账号和插件 ID 隔离安装记录，并在服务端加密整个 `{ version, configuration }` 文档。
- [`pluginClientAdapters.ts`](../../packages/happy-app/sources/components/plugins/pluginClientAdapters.ts) 只把白名单 `(pluginId, routeId)` 解析到已编译的 Expo Router 页面，拒绝服务端下发任意 URL 或代码。
- [`PluginMarketplaceModal.tsx`](../../packages/happy-app/sources/components/plugins/PluginMarketplaceModal.tsx) 已实现市场和动态配置 UI。

这部分应继续保留，并成为新 Host 的安装目录、配置与安全存储基础。

### 3.2 还没有

- Manifest 没有 Host API 兼容范围、目标运行时、权限、激活事件、依赖或 contribution 列表。
- App 只有固定 route adapter；左侧面板、右侧面板、页面、弹窗、命令和聊天区域都不是可注册插槽。
- Server 没有通用的 AI、Session、Image、File、Network 等 capability interface；狗头军师仍通过专用 Runtime Adapter 接入。
- 插件没有统一的 `activate / deactivate` 生命周期、Disposable 归属、失败隔离、资源限额和运行状态。
- “安装”没有下载或加载代码；卸载删除安装记录并关闭功能，但不会物理移除已编译代码。

所以当前文档中的“动态插件”应理解为动态目录与生命周期状态，而非通用动态代码宿主。

## 4. VS Code：值得借鉴的稳定模式

### 4.1 Manifest 是静态能力声明，不是可执行入口目录

VS Code 扩展通过 `package.json` 声明 `engines.vscode`、`main`/`browser`、`extensionKind`、`activationEvents`、`capabilities` 和 `contributes`。[Extension Manifest](https://code.visualstudio.com/api/references/extension-manifest) 负责兼容性和发现，[Contribution Points](https://code.visualstudio.com/api/references/contribution-points) 负责命令、配置、视图、菜单等静态贡献。

适用于 Paws：

- `manifest.apiVersion` / `engines.paws`：先判断 Host API 是否兼容，再允许安装或激活。
- `targets` + 分离 entrypoint：明确 `server`、`web`、`tauri`、`ios`、`android`、`declarative`，而不是让代码自行猜运行环境。
- `contributes`：只接受宿主定义的类型和值；未知 contribution 或未知字段默认拒绝。
- 目录解析与运行时代码加载分开。市场可以在不执行插件代码时展示、搜索、审查权限和兼容性。

### 4.2 Contribution Points 控制 UI 边界

VS Code 允许插件向 Activity Bar、Primary Sidebar、Panel、命令、菜单和设置等**预定义位置**贡献内容，而不是直接操作 Workbench DOM。[Views/Views Containers](https://code.visualstudio.com/api/references/contribution-points#contributes.views) 由 Manifest 声明，宿主决定位置和渲染；[Workbench Extension](https://code.visualstudio.com/api/extension-capabilities/extending-workbench) 展示了这些受控表面。

值得特别注意：

- Primary/Secondary Sidebar 都由 View Container 和 View 构成；官方 UX 指南建议限制容器和 View 数量，Secondary Sidebar 通常由用户移动 View，而不是任意插件强占。[Sidebars](https://code.visualstudio.com/api/ux-guidelines/sidebars)
- View 可以是 Tree、Welcome 或 Webview，但官方仍建议减少自定义 Webview。[Views](https://code.visualstudio.com/api/ux-guidelines/views)
- Webview 是兜底能力，不是默认组件体系；官方要求最小权限、CSP、限制本地资源和清理用户输入。[Webview security](https://code.visualstudio.com/api/extension-guides/webview#security)

适用于 Paws：

- 暴露 `navigation.left`、`panel.right`、`page`、`settings.section`、`chat.action` 等受控 slot，而不是暴露 `SidebarView`、`SessionView` 等内部 React 组件。
- `modal` 不应表示“插件可随时弹窗”。插件应贡献 `command/action + dialog descriptor`，只有用户操作或宿主策略才能打开弹窗。
- Host 决定排序、密度、移动端降级、主题、无障碍和同时可见数量，插件只声明内容意图。

### 4.3 按需激活与可逆生命周期

VS Code 的 [Activation Events](https://code.visualstudio.com/api/references/activation-events) 让扩展只在命令、View、语言或其他上下文真正需要时激活；`activate` 和 `deactivate` 是扩展入口生命周期。[Extension Host](https://code.visualstudio.com/api/advanced-topics/extension-host) 还把扩展代码放在 UI 之外的 host，并区分 local Node、browser WebWorker 和 remote Node 运行位置。官方源码也把 [Extension Host 管理](https://github.com/microsoft/vscode/blob/71408502d3be76bc573e4c676f1e4a6de5f14297/src/vs/workbench/services/extensions/common/extensionHostManager.ts) 与 [Ext Host 内的扩展服务](https://github.com/microsoft/vscode/blob/71408502d3be76bc573e4c676f1e4a6de5f14297/src/vs/workbench/api/common/extHostExtensionService.ts) 分成独立 Module。

适用于 Paws：

- 市场可见不等于运行时已激活。
- `onCommand`、`onView`、`onSession`、`onMessageKind`、`onServerRequest` 可作为有限的激活事件；禁止默认使用等价于 `*` 的全局启动。
- 每个注册项、订阅、timer、请求和缓存必须归属于一次 activation，禁用/更新/卸载时统一 dispose。
- UI 线程、Paws Server 与宿主机 Agent Runtime 应分开；插件 Manifest 声明首选运行位置，Host 最终决策。

### 4.4 Context/when 条件决定“何时出现”，权限决定“能做什么”

VS Code 用 [when clause contexts](https://code.visualstudio.com/api/references/when-clause-contexts) 根据当前资源、焦点、平台或自定义 context key 控制命令和 View 是否出现。Workspace Trust 则是另一条安全线：扩展声明在不受信任 Workspace 中是完整、有限还是不支持，并且运行时仍需阻断敏感代码路径。[Workspace Trust Extension Guide](https://code.visualstudio.com/api/extension-guides/workspace-trust)

Paws 应分开三类概念：

- `when`：纯展示/激活条件，例如 `platform == web && session.active`。
- `capabilities`：环境是否能满足，例如 `host.machine.available`。
- `permissions`：用户是否允许插件调用，例如 `session.read`、`network.fetch`。

不能只隐藏按钮来实现权限；VS Code 官方也提醒命令即使不显示仍可能被调用，因此运行时必须再次校验。

### 4.5 多运行时使用抽象资源，而不是本地路径假设

VS Code 的 [Web Extensions](https://code.visualstudio.com/api/extension-guides/web-extensions) 使用 Browser WebWorker，不能依赖 Node API、child process 或本地文件路径；[Virtual Workspaces](https://code.visualstudio.com/api/extension-guides/virtual-workspaces) 要求通过 URI 与 `workspace.fs` 抽象访问资源，不假设资源属于 `file:`。

适用于 Paws：

- Plugin SDK 只传 `ResourceUri`、opaque ID 和 capability handle，不传宿主绝对路径。
- `files.read` 可以由 Web 调 Server、Tauri 调本地受控命令、移动端调 Expo API，各端实现同一 Interface。
- 插件必须声明不支持、有限支持或完整支持哪些目标；Host 提供明确的 unavailable 状态，而不是运行时崩溃。

### 4.6 Extension Host 不是细粒度安全沙箱

VS Code 官方明确说明 extension host 拥有与 VS Code 本身相同的系统权限，可读写文件、联网和启动进程；Marketplace 通过发布者信任、恶意软件扫描、动态检测、签名和 blocklist 降低供应链风险。[Extension runtime security](https://code.visualstudio.com/docs/configure/extensions/extension-runtime-security)

这对 Paws 有两个直接结论：

1. “另起 Extension Host 进程”可以保护 UI 稳定性，但本身不是权限隔离。
2. 若 Paws 要支持陌生第三方代码，必须另建 Capability Broker、进程/Worker/容器边界、包签名、允许列表和撤销机制，不能把 VS Code Extension Host 当成现成 sandbox。

## 5. DeepSeek Harness：值得借鉴的组合模式

以下链接固定到调研时 revision `cd5ef8148158c3a752a658978873241fdf8e2bbc`，避免 Developer Preview 的后续变化改写证据。

### 5.1 Service / Provider / Consumer 是能力主干

[DSH Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/architecture.md) 把 capability seam 分为 Service Definition、Provider 和 Consumer。模型、工具、会话、文件系统、Shell、Sandbox 和 UI 等能力通过稳定 `ctx` 服务或 typed event 协作，而不是直接 import 某个实现。

适用于 Paws：

- `paws.ai` 只定义对话/流式事件；HTTP Provider、Codex Provider、Claude Code Provider 分别实现它。
- `paws.storage`、`paws.secrets`、`paws.images`、`paws.sessions`、`paws.files` 同样把 Interface 与平台 Adapter 分开。
- 狗头军师消费 `ai.http + secrets.use + storage.kv`，不感知 Paws 数据表或 Claude Code 会话实现。
- 生成图片插件消费 `images.query/read + ui.page/modal`，不直接扫描 App 私有存储。

### 5.2 注入式依赖与可逆 Effect

[Cordis Primer](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/cordis-primer.md) 使用稳定 service key、`inject` 依赖、typed events 和 reversible effects；[Plugin lifecycle](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/user/develop/framework/index.md) 定义 `PENDING → LOADING → ACTIVE/FAILED → UNLOADING → DISPOSED`，依赖消失时自动卸载，注册项在 dispose 时清理。

适用于 Paws：

- Manifest 声明 `requires`，激活器只在依赖、权限和目标运行时全部满足时运行。
- Host 返回 `Disposable`，统一回收 slot、command、event listener、timer 和后台任务。
- 更新采用“准备新版 → 激活成功 → 原子切换 → dispose 旧版”；新版失败保留旧版并记录诊断。
- 插件失败只改变自身 runtime state，不得让市场、聊天或其他插件不可用。

### 5.3 Typed Slots 很贴近 Paws 的 UI 目标

[DSH Web Client Slots](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/subsystems/slots.md) 把 Slot 定义成 typed React composition system：slot 有 owner、scope、cardinality 和 props；只有拥有渲染位置的组件能声明子 slot；插件通过注册贡献内容，生命周期结束会递归移除贡献。插件 UI 不接收整个 `ctx`，只接收 owner props、受控 callbacks 和 observable projections。

适用于 Paws 的核心原则：

- “声明 slot 的 Module”与“向 slot 注册内容的插件”分离。
- Slot 有明确作用域：`global`、`account`、`session`、`workspace`，不能靠读取全局状态猜上下文。
- 插件组件不拿完整 Host/Store，只拿最小 props 和经过权限代理的 callback。
- UI 注册与插件 lifecycle 绑定；卸载后不会遗留入口、监听或状态。
- 业务数据属于服务端或领域 store，slot store 只保存视图交互状态。

不应直接照搬的部分：DSH 该实现是 Web Client 的 React 类型系统，使用 TypeScript declaration merging 和 Web bundle；Paws 的 renderer 是 React Native + Web + Tauri，Slot Contract 应放在平台无关 SDK，React/React Native 只是宿主实现。

### 5.4 Profile/Bundle 的分层组合适合内部预设，不适合直接开放全部覆盖权

[DSH publish guide](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/user/develop/basic/publish.md) 区分 Bundle（贡献配置层）与 Profile（按顺序组合 Bundle），后层可以覆盖前层；插件可以由 pnpm 或 Git 安装。官方同时提醒 Git 依赖的 `prepare` 会在宿主机、Agent sandbox 之外执行，应只信任来源并固定完整 commit SHA。

适用于 Paws：

- “插件包”与“启用组合/账号安装状态”分离。
- 开发环境可以使用 Profile 组合一组第一方插件或企业插件。
- 继续使用不可变 revision 和构建产物 digest。

不适用于公开市场：

- 第三方插件不能通过配置层覆盖身份认证、密钥、权限代理、更新器或任意核心服务。
- 不接受 `!!js` 一类配置表达式。
- 安装流程不能执行未经审核的 `prepare/postinstall`。

## 6. 建议的 Paws 目标边界

```text
Plugin Package / Catalog
        │ manifest + signed artifacts
        ▼
Plugin Manager
  discovery · install · enable · update · rollback · uninstall
        │
        ▼
Plugin Host ─────────── UI Slot Registry
  activation             left · right · page · modal · settings · chat
  dependency graph              │
  lifecycle/dispose             ▼
        │                 Platform Renderer
        │                 Web · Tauri · iOS · Android
        ▼
Capability Broker
  ai · agent · sessions · images · files · storage · secrets · network
        │
        ├─ App adapters
        ├─ Paws Server adapters
        └─ Machine Agent adapters (Codex / Claude Code)
```

### 6.1 不可插件化的 Kernel

以下能力必须由 Paws 核心拥有：

- 登录身份、账号边界和授权判定；
- 插件 Manifest/schema 验证、签名/完整性、允许列表和撤销；
- 服务端主密钥与 Secret Vault；
- Capability Broker 和所有调用时权限检查；
- 审计、限流、故障隔离与数据库 migration runner；
- App 导航骨架、Modal manager、主题/无障碍和平台适配；
- OTA/native runtime 与商店发布契约。

这与 DSH 的“没有 privileged core”有意不同。Paws 是账号化、多端、远程宿主机产品，需要稳定的跨信任域安全内核。

### 6.2 Plugin SDK 应包含的契约

建议新 schema 至少包含：

```ts
interface PawsPluginManifestV2 {
  schemaVersion: 2;
  id: string;
  version: string;
  engines: { paws: string; pluginApi: string };
  targets: Array<'declarative' | 'server' | 'web' | 'tauri' | 'ios' | 'android'>;
  activationEvents: string[];
  permissions: PluginPermission[];
  requires?: PluginDependency[];
  contributes: {
    commands?: CommandContribution[];
    navigation?: NavigationContribution[];
    views?: ViewContribution[];
    dialogs?: DialogContribution[];
    settings?: SettingsContribution[];
  };
  entrypoints?: {
    server?: ArtifactEntrypoint;
    web?: ArtifactEntrypoint;
    tauri?: ArtifactEntrypoint;
  };
}
```

Manifest 只描述内容、兼容性和需求。运行时注册通过版本化 `@paws/plugin-sdk` 完成；SDK 不导出 Paws 内部组件、数据库 client 或全局 store。

### 6.3 第一批 UI Slots

| Slot | 作用域 | 基数 | 移动端投影 | 说明 |
|---|---|---:|---|---|
| `navigation.left.items` | account | list | Drawer/首页入口 | 插件不能控制整个左栏 |
| `panel.right.views` | session/workspace | list | 独立页面或 Bottom Sheet | 右栏不存在时必须有宿主降级 |
| `page.routes` | account | keyed | Stack screen | key 是稳定 route ID，不是 URL |
| `dialog.definitions` | account | keyed | Modal/Sheet | 只能由 command 或用户动作打开 |
| `settings.sections` | account | list | Settings screen | Secret 字段始终由 Host renderer 处理 |
| `chat.header.actions` | session | list | Header action/menu | 数量和优先级由 Host 限制 |
| `chat.message.renderers` | session | keyed/chain | 同一消息列表 | 只处理声明的 message kind |

起步只需 `list` 与 `keyed` 两种 cardinality。DSH 的 `single`、`chain`、声明递归和复杂 store seat 可在出现真实需求后再增加，避免第一版 Plugin SDK 过深。

### 6.4 Capability 与 Permission 建议

| Capability | 示例方法 | 建议权限 | 执行位置 |
|---|---|---|---|
| `ai.http` | `streamChat(request)` | `ai.http.use`、声明 provider/origin | Paws Server |
| `agent.sessions` | `create/send/observe` | `agent.session.read/write/start` | Server + Machine Agent |
| `images` | `query/getMetadata/open` | `images.read` | App/Server |
| `files` | `read/write/list` | URI scope 下的 `files.read/write` | Machine/Tauri/Server |
| `storage.kv` | namespaced get/set/delete | `storage.kv` | Server，按账号+插件隔离 |
| `secrets` | set/delete/useWithCapability | `secrets.manage/use` | Server；默认不向插件返回明文 |
| `network` | `fetch` | `network.fetch` + origin allowlist | Server 或受限 runtime |

Secret 设计应优先返回 opaque reference，或者直接由 `ai.http` capability 在服务端使用 Secret；客户端插件和声明式 UI 不应拿到 API Key 明文。

### 6.5 运行时分层

| 插件形态 | Web | Tauri | iOS/Android | 建议阶段 |
|---|---|---|---|---|
| 纯 Manifest/声明式 UI | 动态 | 动态 | 动态 | 第一阶段 |
| 随 Paws 编译的可信 RN 插件 | 动态启用 | 动态启用 | 动态启用 | 第一阶段 |
| Server plugin | 服务端调用 | 服务端调用 | 服务端调用 | 第一/二阶段，需进程或容器隔离 |
| 远程 Web bundle | Worker/iframe | Worker/WebView | 不作为共同基线 | 后续实验 |
| 任意 React Native bundle | 技术上可加载 | 技术上可加载 | 受 native/runtime/审核约束 | 暂不支持 |

“动态安装”需要对用户讲清楚是哪一层：安装声明与账号状态、加载预置代码、还是下载并执行新代码。三者必须在 API 和 UI 上使用不同状态，不能都叫 installed 而不解释。

## 7. 适用性矩阵

| 参考模式 | Paws 采用结论 | 原因 |
|---|---|---|
| VS Code Manifest + Contribution Points | 直接采用原则 | 适合先发现、后激活和受控 UI |
| VS Code `main`/`browser`/`extensionKind` | 改造成 `targets/entrypoints` | Paws 还多 Server、Tauri 和移动端 |
| VS Code Activation Events | 简化后采用 | 降低启动成本并形成可审计生命周期 |
| VS Code Context Keys / when | 采用表达能力，限制语法 | 展示条件与权限应分开 |
| VS Code Extension Host 进程 | 仅借鉴稳定性隔离 | 官方明确它拥有完整 VS Code 权限，不是安全沙箱 |
| VS Code Workspace Trust | 借鉴“环境信任状态”概念 | Paws 还需独立的插件来源信任和用户权限授权 |
| VS Code Webview | 只作 Web/Tauri 兜底 | 跨 RN 不统一，安全和 UX 成本高 |
| DSH Service/Provider/Consumer | 采用 | 很适合 AI、Agent、Storage 等能力替换 |
| DSH typed events + reversible effects | 采用 | 支撑启用、更新、卸载与故障清理 |
| DSH typed UI slots | 采用原则，重写跨端 Contract | 目标与 Paws 左/右面板、弹窗高度一致 |
| DSH “everything is a plugin” | 不完全采用 | Paws 必须保留 privileged security kernel |
| DSH Profile/Bundle overlay | 仅用于内部/企业预设 | 公开插件覆盖核心 row 权限过大 |
| DSH Git/pnpm 安装任意代码 | 不采用为默认市场机制 | 安装脚本发生在 Agent sandbox 外，供应链风险过高 |
| 直接暴露 React 组件或全局 store | 不采用 | 强耦合内部版本，无法跨 Web/RN/Server |

## 8. 推荐落地顺序

1. **冻结 v1 的定位**：把现有系统明确命名为 Built-in Plugin Catalog，不继续往 `app-route` 上叠加任意 UI 字段。
2. **定义 Plugin Manifest v2 与 `@paws/plugin-sdk`**：先完成兼容、目标、权限、activation、contributions、Disposable 和错误契约。
3. **实现 Capability Broker**：先覆盖两个真实插件需要的 `ai.http`、`images`、`storage.kv`、`secrets`。
4. **实现跨端 Slot Registry**：先落地左侧入口、页面、右侧面板和受控 dialog；由 Host 负责移动端投影。
5. **迁移两个插件作为验证样例**：狗头军师不得再依赖专用 Paws 内部 API；画廊不得再依赖硬编码 route adapter。
6. **加入生命周期与诊断**：PENDING/ACTIVE/FAILED/DISPOSED、失败隔离、更新回滚、贡献清理和审计。
7. **最后再决定第三方代码加载**：先完成签名、权限、撤销、运行时隔离与平台策略，才能开放 Web/Tauri bundle；移动端继续以声明式 UI 或随 App 发布的可信代码为主。

两个现有插件是很好的架构验收题：如果它们能只依赖 Plugin SDK、Manifest 和能力权限，且 Paws 内部不再有它们的专用导航/运行时代码，新的 Host 边界才算成立。

## 9. 一手资料索引

### VS Code 官方

- [Extension Manifest](https://code.visualstudio.com/api/references/extension-manifest)
- [Contribution Points](https://code.visualstudio.com/api/references/contribution-points)
- [Activation Events](https://code.visualstudio.com/api/references/activation-events)
- [Extension Host](https://code.visualstudio.com/api/advanced-topics/extension-host)
- [when clause contexts](https://code.visualstudio.com/api/references/when-clause-contexts)
- [Workspace Trust Extension Guide](https://code.visualstudio.com/api/extension-guides/workspace-trust)
- [Virtual Workspaces](https://code.visualstudio.com/api/extension-guides/virtual-workspaces)
- [Web Extensions](https://code.visualstudio.com/api/extension-guides/web-extensions)
- [Extension runtime security](https://code.visualstudio.com/docs/configure/extensions/extension-runtime-security)
- [Webview API security](https://code.visualstudio.com/api/extension-guides/webview#security)
- [Views UX Guidelines](https://code.visualstudio.com/api/ux-guidelines/views)
- [Sidebars UX Guidelines](https://code.visualstudio.com/api/ux-guidelines/sidebars)
- [VS Code source organization](https://github.com/microsoft/vscode/wiki/source-code-organization)
- [Extension Host Manager source（固定 revision）](https://github.com/microsoft/vscode/blob/71408502d3be76bc573e4c676f1e4a6de5f14297/src/vs/workbench/services/extensions/common/extensionHostManager.ts)
- [Extension Registry source（固定 revision）](https://github.com/microsoft/vscode/blob/71408502d3be76bc573e4c676f1e4a6de5f14297/src/vs/workbench/services/extensions/common/extensionsRegistry.ts)

### DeepSeek 官方

- [DeepSeek Harness 发布页](https://www.deepseek.com/harness/)
- [DeepSeek Harness repository](https://github.com/deepseek-ai/deepseek-harness)
- [Architecture（固定 revision）](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/architecture.md)
- [Cordis Primer（固定 revision）](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/cordis-primer.md)
- [Plugin lifecycle（固定 revision）](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/user/develop/framework/index.md)
- [Web Client Slots（固定 revision）](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/subsystems/slots.md)
- [Package and install a plugin（固定 revision）](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/user/develop/basic/publish.md)
