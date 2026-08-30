# 组件、状态、路由与插件

## React 与目录

- sources/app/pages：路由页面。
- sources/app/layouts：Root、Main、Settings 布局。
- sources/app/components：共享 UI；同名 .tsx 与 .css 并列。
- sources/app/components/chat：消息与权限提示。
- sources/app/components/terminal：终端视图。
- sources/app/chat 与 workspace：Jotai store、runner 与持久化桥。
- sources/plugins：插件协议和 host。

页面在 sources/app/routes.tsx 注册并嵌入现有 layout，不在组件内部创建独立 BrowserRouter。

## 状态

Jotai atom 是 renderer 的共享状态入口。更新对象和数组时使用不可变写法；store mutation 集中为 write atom。真实例子见 sources/app/chat/store.ts：

    set(chatsAtom, (prev) => ({
        ...prev,
        [id]: { ...prev[id], status: 'idle' },
    }));

临时 UI 状态保留在组件 useState。进程重启后的状态由 ChatsPersistence、main chat-store 或 app-storage 管理；hydrate 时清除 streaming 等瞬时状态，避免崩溃状态永久化。

## 插件

sources/plugins/types.ts 定义 Plugin 与 capability discriminated union。sources/plugins/host.ts 负责注册、activate/connect/disconnect、revision 通知和模型聚合。插件 UI 不直接访问某个 provider 私有对象，而通过 capability 与 host 查询。

新增插件应：

- 使用唯一稳定 id。
- 只声明实际能力。
- activate 失败不阻断其他插件启动。
- 凭据由 main/安全存储所有，不进入 React atom 快照。
- 状态变化调用 PluginContext 的通知方法。

## 组件风格

优先复用现有 Toolbar、SelectButton、OptionCard、SettingsRow、ToggleSwitch 等组件和同名 CSS。小组件保持单一视觉职责，页面组合它们。CSS class 使用现有 kebab-case，组件 props 与领域类型显式定义。

## 反例

- 在多个页面各维护一份 chats useState。
- 组件直接调用 Electron ipcRenderer。
- 为一个下拉框复制整套 SelectButton CSS。
- 在 PluginDetail 页面硬编码 provider 特有认证流程。
