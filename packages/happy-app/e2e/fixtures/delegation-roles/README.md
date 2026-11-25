# 子 Agent 角色设置验收

从仓库根目录运行：

```sh
pnpm exec tsx --tsconfig packages/happy-cli/tsconfig.json packages/happy-app/e2e/fixtures/delegation-roles/serve.mjs
```

复用 codex-settings 的完整 App、隔离 PGlite、真实加密 machine/session RPC；直接使用生产 delegation service/store 处理角色 CRUD 和任务历史。模型目录和子执行器为合成数据，不启动真实 daemon，不调用外部模型，不修改用户配置。

私有登录入口、runtime 和控制端点存于被忽略的 `test-results/delegation-roles/`。只通过 Ego 打开登录入口，导航到干净 URL 后再观察/绑定关键帧。使用 controller 的 POST `/shutdown` 关闭本轮隔离环境。

验收 D1–D3/D7：设置内新建、复制 ID、编辑、删除取消/确认；添加菜单仅预填保留草稿；管理跳转；输入框无常驻条；Codex/Antigravity 复用原子 Agent 行，点击详情显示相应任务。详细结果归 `docs/validation/delegation-role-settings.md`。
