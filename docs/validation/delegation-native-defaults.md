# 子代理省略型号时的默认配置

## 行为约定

- `model` / `effort` 是可选覆盖项。实际任务必须先解析出目标执行器的型号与强度，并确认配置后再发送；不会继承主会话的型号或强度。
- Codex 启动后，先等待原生线程实际型号和强度的元数据写入，并读回核对，再发出 processor / delegation ready。写入失败、正常返回但未保存、或读回配置不一致，都不能宣告就绪。
- 省略型号且原生当前型号可用时沿用它，即使目录另有默认型号。当前型号不可用时，自动使用原生当前目录唯一可见的 `isDefault` 型号，并采用该型号的默认强度或调用方显式强度；仍需确认设置成功。
- 不从父会话、目录第一项或硬编码列表选型号。目录没有唯一可见默认项时，提示在角色设置或委派参数中指定型号。显式指定的失效型号或不支持的强度继续报错，不替换用户选择。
- 自动解析只影响当前子任务及其续修快照，不修改已保存角色或全局 Codex 配置。原生 `thread/start` 自身失败仍按启动失败处理。

## 根因与回归

原生线程已启动时，旧代码通过不等待的 `updateMetadata` 发布设置，随后立即宣告 delegation ready。准备 RPC 从尚未更新的会话元数据读取当前型号，导致省略型号的任务在发送前报 `The current native Codex model is unavailable`。

新增回归分别在修复前观察到失败，再完成修复：延迟元数据回执、回执拒绝、写入正常返回但缺失或不一致、不可用当前型号的自动默认选择，以及无唯一默认项的明确拒绝。

验证入口：

```sh
cd packages/happy-cli
pnpm exec vitest run --project unit \
  src/codex/runCodex.startupTrace.test.ts \
  src/codex/codexDelegationRpc.test.ts \
  src/codex/sessionConfigMetadata.test.ts \
  src/daemon/delegationRuntime.test.ts \
  src/daemon/delegation/service.test.ts
```

当前 5 个文件、134 项回归通过；测试启动流程同时运行 CLI 构建及类型检查。独立代码评审已检查启动顺序、配置读回和自动默认策略。生产生效和正式入口真实子任务验收分别记录，不以这些回归代替。
