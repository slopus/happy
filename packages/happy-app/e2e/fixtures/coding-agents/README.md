# 编程 Agent 云端 E2E

完整分支 Expo Web 与独立 Happy server/PGlite 部署在专用云端目录，仅监听云端 loopback；通过独立 SSH forward 访问。生产服务、账号和执行端不参与。

1. 先构建 happy-wire 与 Web（`expo export --platform web`），运行 `prepare-cloud.mjs` 打包服务端。依赖版本优先读取 server 自己的 node_modules，不能误取根目录同名依赖。
2. 将 pack、Web export、`launch-cloud.py` 上传到专用目录。使用匹配的 Node，安装 isolated dependencies（当前上游 adapter peer 声明需 `--legacy-peer-deps`），仅生成 Prisma client，再运行 launch。迁移超时会终止自己的进程组。
3. 建立仅绑定 loopback 的 SSH forward，执行 `pnpm exec tsx --tsconfig packages/happy-cli/tsconfig.json packages/happy-app/e2e/fixtures/coding-agents/serve-cloud.mjs`。
4. `test-results/coding-agent-cloud/runtime.json` 提供合成机器及 controller 地址。凭据仅从 mode600 文件在 Ego runtime 内载入，不能打印或提交。实际浏览器操作遵循 ego-ops → ego-browser；复用同一任务空间，按实际 DOM 观察再行动。`verify.ego.mjs` 为可复用操作辅助。
5. 逐项验证默认配置、机器隔离、启用后的云端读回与完整刷新、品牌图标轮换、模型独立、空配置发送门禁、版本检查、更新成功与失败、新建会话及消息传输。页面开关变化不代表网络写入已完成，刷新前必须读回云端设置。
6. 保存脱敏 Case 结果；先停本 worker/controller，再核验 PID/cwd 后停止独立云端 server 与 SSH forward。删除自己的合成凭据、测试目录；不得清理其他服务。

更新执行真实产品 service/processRunner 和实际子进程，但只修改专用沙箱 npm/CLI 版本文件。模型回复是 transport stub。此验收不证明厂商模型推理、用户电脑真实升级或原生设备表现。

本轮用户明确不需要截图；没有截图或视频。
