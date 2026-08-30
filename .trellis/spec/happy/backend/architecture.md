# 架构与目录

## 入口与分层

src/index.ts 解析命令并把控制交给 auth、doctor、daemon、serve、resume 或 agent runner。不要在入口堆叠 provider 业务。

主要目录：

- src/api：HTTP、Socket.IO、RPC、加密后的 session/machine 通信。
- src/agent/core：provider 无关的 backend、registry、runner 与事件。
- src/agent/adapters：provider 消息与 Happy 移动端格式之间的转换。
- src/claude、src/codex、src/gemini、src/openclaw、src/acp：provider 集成。
- src/daemon：后台机器控制面与本地 IPC。
- src/sessionProtocol：共享协议的兼容出口与 mapper。
- src/modules：终端、路径安全、代理等横切能力。
- src/ui：终端展示、二维码与文件日志。
- src/persistence.ts：HAPPY_HOME_DIR 下的设置、密钥和 daemon 状态。

内部 TypeScript 导入优先使用 @/ 指向 src。导入全部放在文件顶部；不要在函数中动态 import 来绕过依赖设计。

## 代码形态

使用 strict TypeScript、显式边界类型和命名导出。共享核心优先函数与小型接口，类只用于确实有长生命周期和封装状态的对象，例如 ApiSessionClient、AgentRunner、TmuxUtilities。

不要为了缩短单个表达式拆出无语义 getter，也不要用一连串布尔 if 复制状态机。生命周期分支应有明确状态或 adapter 边界。

## 关键执行流

- 前台运行：src/index.ts → provider run 文件 → ApiSessionClient。
- 后台运行：src/index.ts → daemon control client → daemon/run.ts → detached session。
- 远程创建：App → server RPC → ApiMachineClient → daemon spawn → 新 session 自报。
- 消息输出：provider event → mapper/adapter → @slopus/happy-wire envelope → 加密 API client。

对这些核心流的改动先查看 docs/cli-architecture.md，并用 GitNexus impact 检查上游调用。
