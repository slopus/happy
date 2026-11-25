# 子 Agent 角色设置与临时委派

2026-11-26 用户明确授权实施。基线 `62e86e1e1`，分支 `feat/delegation-role-settings`，实现位于 sibling worktree `happy--delegation-role-settings`。实现验收阶段未合并、发布或修改真实账号；用户在验收后另行明确要求合并并上线。发布及真实环境验收结果由既有 Release OPS 本任务记录维护，本报告保留实施阶段证据。

## 交付行为

- 输入框上方不再显示助手/管理常驻条。设置 → 委派角色管理同一账号在当前机器上的角色；添加菜单保留角色及管理快捷入口。
- 创建只保存配置，生成或接受稳定 `roleId`；更新/删除按 ID，不按名称猜测。名称可重复，`new` 也是合法 ID。模型、强度可留空，创建默认 `autoDelegate=false`。
- 自然语言通过 `agent_roles(list/create/update/delete)` 管理配置，通过 `delegate_task` 精确指定角色、临时执行器路由或修订已有任务。AI 自行选择角色须满足已保存角色的 `autoDelegate` 策略；`explicit` 是调用方对用户意图的分类，不是独立的人类审批凭证。
- 设置与 MCP 共用机器角色 RPC/service/store。派发时原生 prepare 确认目标执行器的真实模型和强度；不继承父 Codex 强度，不静默替换不支持的模型。
- 每个任务保存自己的路由快照。修改/删除角色不改变已有任务、结果或历史。任务呈现复用原 `SubagentActivityGroup` 与真实 Codex/Antigravity 品牌，点击进入原任务详情。
- 角色列表在账号、机器、连接或原生能力变化时由事件读取；首次连接/重连各一次，不用业务状态轮询。迟到响应和旧菜单选择受账号 generation、机器及请求生命周期围栏保护。

## 验收矩阵

| Case | 结果与证据范围 |
| --- | --- |
| D1 移除常驻条/设置入口 | 源码及完整 App 桌面页面通过；设置原入口和添加菜单管理入口均可达 |
| D2 稳定 ID CRUD/草稿 | 完整 App + 实际加密机器 RPC + 生产 service/store 验证创建空模型、默认自动关闭、编辑 ID 不变、取消删除保留、确认删除后文件与刷新列表一致；失败/换账号/换机器/断线迟到回执由单测验证 |
| D3 添加菜单仅填草稿 | 真实页面选择 `technical-writer` 后原文保留并插入准确 ID；管理跳转往返草稿逐字保留，controller 的消息数仍为 1，没有因为选择/管理发消息；菜单重试恢复通过 |
| D4 自然语言接口 | MCP HTTP/stdio 注册、工具输入 schema、create/update/delete/list、未知更新/重复创建错误与稳定 ID 由 wire/CLI 测试验证；未用真实 LLM 评测自然语言识别质量 |
| D5 临时路由/默认参数 | service、native Codex/ACP prepare、协议测试通过；包含无保存角色的临时调用和实际设置 ACK、歧义/不可用错误。未调用真实外部模型 |
| D6 自动策略/历史 | 自动策略、路由+intent 幂等、角色修改/删除后的任务快照、V1/V2 响应及元数据兼容由 CLI/App 测试验证 |
| D7 原子 Agent 行/详情 | 完整 App 中两 provider 的原行/品牌已验证；两种任务详情均通过实际 RPC 读取结果，返回后分组与原草稿保留；Gingham 深色 hover/selected 分别为对应主题表面色 |

## 自动检查与独立审阅

- App：9 文件 **92 项通过**（完整批次 91 项，新增 Escape 回归后受影响 30 项再次通过）；完整 `pnpm --filter happy-app typecheck` 通过。
- CLI：10 套 **303 项通过**；CLI 类型检查与构建通过。
- wire：4 项通过，构建通过；Node 协议/replay 21 项通过。
- `git diff --check` 通过。根工作区保持干净 main，与本次起点 origin/main 一致。
- 独立 reviewer 检查 App、wire、service、runtime、原生 prepare 与 MCP，初始三项 P2（`new` 占位冲突、客户端协议与 worker 能力混用、长临时标题破坏持久任务）均已修复并复核，无剩余确认 P1/P2。reviewer 独立复跑 App 六文件 75 项通过；此数量与上面的最终检查重叠，不相加。

## 兼容与生效边界

- `machine.metadata.delegationRoles:1` 声明机器角色 CRUD；`capabilities.delegationRoutes:1` 只声明原生执行准备能力。二者不代替调用客户端协议。
- 旧请求缺省返回 V1；新 App 只对声明新机器能力的 daemon 加 `protocolVersion:2`，新 MCP 两个入口显式协商 2。V1 无法表示的临时/默认请求在副作用前拒绝。
- 旧 `delegationRoles`/`delegatedTasks` 保留真实 V1 投影，不伪造模型或角色 ID；`delegationV2={version:2,roles,tasks}` 是完整快照，新端优先读取它（包括权威空数组）。
- 本次构建没有替换用户运行中的 CLI 或 App。正式生效需要后续受授权的 CLI 与 App 发布，新会话才能加载新的工具/prepare 能力；旧会话不视为已热升级。
- 共享 RN 代码有 OTA 影响；本次无原生依赖或 runtime 修改，没有发布 OTA/APK，没有 Android 真机验收，不用桌面截图替代手机通过。

## 浏览器入口与证据

运行 `pnpm exec tsx --tsconfig packages/happy-cli/tsconfig.json packages/happy-app/e2e/fixtures/delegation-roles/serve.mjs`。它复用现有 codex-settings 完整 App/隔离 PGlite 环境，生产角色 service/store 与真实加密 machine/session RPC，只有模型目录和执行器/reporter 是合成数据。无真实 daemon、付费模型或生产用户数据。

精确 runtime、测试对象、操作断言及媒体留在被忽略的 `packages/happy-app/test-results/delegation-roles/`。Happy 的关键帧经 session/run/space/target/URL 绑定上报；不发布认证入口，不采集未要求的 PR Before/After 矩阵。UI 状态演示视频使用本任务新采集的 CDP 字节，不复制 helper 关键帧。

验收中修正的两个夹具/运行问题：

1. 合成机器最初只发 presence，没有真实 daemon 首次 `machine-update-state`，HTTP 缓存会读到初始 offline。夹具已补一次原生状态初始化；不引入状态轮询。早期受其影响、未真正删除的帧已标记无效，最终以生产 store 的角色删除及新列表为准。
2. Ego 高层点击在手动模拟视口的菜单上出现命中偏移；采用同一 Ego task/target 的 DOM hit-check 与 `Input.dispatchMouseEvent` 真实鼠标、键盘继续验证。没有通过 JS 直接调用业务回调。

另发现并修复产品冷加载时角色查询早于 socket connected 的竞态；设置页和添加菜单均在连接就绪/恢复事件后读取，相关断线旧回执和零提前请求回归通过。

浏览器补验还发现从添加按钮获得焦点时 Escape 未经过输入框键盘处理。Picker 现仅在所属输入区/菜单焦点内捕获 Escape，关闭并回焦；外部浮层按键不受影响，新增 DOM 回归与实际浏览器复验。

## 最终交付记录

- 独立 reviewer 最终代码及 PC 限定 D1/D2/D3/D7 交互结论均通过，并独立复跑 Escape 相关 3 文件 30 项。两执行器详情经机器 RPC 读取对应结果/版本后返回；最终添加菜单按 Escape 关闭，焦点为 TEXTAREA，原草稿逐字保留，两个任务不变，未检测到页面横向溢出。
- 8 个验证状态的新鲜 CDP 画面形成 `test-results/delegation-roles/role-settings-states.mp4` 状态演示（非连续录屏）。17.97 秒、1440×960、H.264/yuv420p/30fps/faststart，完整解码及首/结果/尾帧视觉检查通过，已用 Happy send_file 发送。3 个早期无效状态未加入视频。
- controller 最终 messages=1、普通 spawn=0；两项派发任务来自夹具初始化，角色 CRUD 和菜单未追加消息或新会话。测试角色已删除，浏览器空间已独立结束，fixture 由自己的 shutdown 清理且端口停止。原 daemon、账号角色和现有静态预览未改变。
- 经验写回 Ego OPS 的 paws/verify-delegation-role-settings（79 站点/453 operation 校验通过）、Android OPS 的 happy-paws/delegation-role-settings（partial、原生日期 null），以及 Web E2E 本机经验。没有用 Web 结果刷新 Android 验证日期。
