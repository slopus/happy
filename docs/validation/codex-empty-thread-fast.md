# Codex 新会话开启 Fast 的空线程恢复修复

## 行为与边界

原路径在 worker 启动时先创建 standard 空线程，首条消息选择 Fast 后重启 app-server，再恢复尚无 rollout 的线程，导致 `no rollout found`。后续消息重复同样的切换和失败。

修复只允许替换由当前客户端成功创建、且从未尝试写入或开始执行的空线程。切换 tier 时清除该线程，再由原有 ensure 流程按当前消息的模型、目录、权限和 MCP 设置创建线程。Paws 元数据同步清除失效 ID，即使重连失败也不留下旧 ID 供命令或重试恢复。

恢复/分叉线程、尝试发送过 turn 的线程（含失败或结果不确定）、设置过 goal 或收到执行开始事件的线程都不能走空线程替换。恢复失败仍抛错并保留原线程 ID；后续重试恢复相同 ID，不静默创建新会话。

## 回归覆盖

- 首条 Fast 消息：不请求恢复空线程；新线程收到原始文本和本地图片一次；app-server 使用 fast tier。
- Fast 重连失败后重试：失效 ID 已清除，再次发送可以成功。
- 替代线程创建失败后重试：失效 ID 已清除，不重复投递 turn。
- 恢复、分叉、turn 拒绝、turn 接受、goal 五种受保护线程：即使恢复报 no rollout，连续重试仍使用原 ID，不创建新线程。
- 保留原有 service-tier 恢复失败及重试测试。

## 验证环境

独立 sibling worktree；运行测试前仅从测试子进程环境移除宿主注入的 `HAPPY_CODEX_*`，不修改真实账号、运行配置或服务。构建 workspace 依赖 happy-wire 与 paws-agent。

测试先在旧实现上观察到两个新增用例因 `thread/resume: no rollout found` 失败，再实现修复。客户端测试最终为 84 项；最终完整结果见下方。

初次并行全量：190 个文件，1836 通过、3 失败、2 跳过。失败为 executionBinding 的旧 chat-only grant 用例、serviceCapabilities 的 Claude YOLO 用例超时、goalBoard 的 fs.watch 用例无事件。将两处已修改生产文件临时还原到 HEAD 后，这三个文件独立运行 51 通过、1 跳过；随后已还原修复文件。此对照不能单独证明并发失败的根因。

尚未合并、发布或替换正在运行的 worker；回归使用协议边界的假 app-server，未调用真实模型。

## 最终结果

- `pnpm --filter @wangjs-jacky/paws run test --maxWorkers=1`：浏览器采集脚本测试通过，CLI 构建（含 TypeScript）通过；190 个单测文件全部通过，1839 项通过、2 项跳过。串行结果消除了本轮首个并行 run 的三个失败，但没有确定它们的具体原因。
- 最后将元数据清理改为等待真实 `updateMetadataAndAwait` 提交，并让测试模拟异步提交；随后重跑客户端与启动 trace 两个文件：87 项通过，测试启动阶段的构建及类型检查通过。未再次扩大运行无关文件。
- `git diff --check` 通过。根工作区仍干净，与 origin/main 一致。
- 本地日志：`/tmp/paws-fast-regression-full.log`、`/tmp/paws-fast-baseline-check.log`、`/tmp/paws-fast-regression-serial.log`、`/tmp/paws-fast-final-focused.log`；它们是临时诊断输出，验收事实以本报告为持久记录。
