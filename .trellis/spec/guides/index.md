# Happy 思考指南

本目录只保留 Happy 仓库的横切检查，不重复各包的实现规范。

## 何时读

- 要新增 helper、schema、配置、组件或状态投影：code-reuse-thinking-guide.md
- 改动跨 App、CLI、Agent、Server、Wire 或发布壳：cross-layer-thinking-guide.md

## 开始前

1. 用 GitNexus query/context 找执行流与 symbol 所有者。
2. 用 rg 精确搜索现有字段、事件名、组件和配置。
3. 打开目标包的 .trellis/spec/<package>/<layer>/index.md。
4. 改函数或 class 前运行 GitNexus upstream impact。

## 提交前

- 相关包的 typecheck、测试和 build 已通过。
- 协议与配置只有一个 source of truth。
- 日志、fixture 和 diff 不含凭据。
- 核心同步、RPC、加密或 Server 改动已有跨包验证。
