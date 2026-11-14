# Web / OTA 发布优化

## 自动 OTA 的范围

`scripts/classify-ota-impact.cjs` 是 preview / production 的共同判定入口。它在安装依赖或导出 Android bundle 前运行，无需额外依赖。

| 改动 | 自动 OTA |
| --- | --- |
| 仅 `.web.ts` / `.web.tsx` / `.web.js` 等平台实现，或 App 的 `public/` Web 资源 | 跳过构建与上传 |
| 仅文档、类型声明、测试、E2E、开发演示或发布工具 | 跳过 |
| 手机代码、共享 `.ts` / `.tsx`、共享资源，或与 Web 文件混合 | 保守保留 |
| package、lockfile、原生目录、plugin 或 runtime 等敏感配置 | 沿用兼容性门禁，跳过 OTA 并明确提示匹配原生包 |
| 手动 workflow_dispatch | 沿用显式发布行为 |

组件名含 Desktop 或 JSX 里有 `Platform.OS === 'web'`，都不能证明共享模块在手机初始化时没有影响。Web 专用实现应放在 `.web.*` 文件，原生入口通过平台文件隔离；不要为了跳过 OTA 给共享目录加宽泛白名单。历史上同时改过 `SidebarNavigator.tsx` / `GoalBoardButton.tsx` 的提交仍会保守归为共享变更。

Git diff 使用 `--no-renames` 同时检查删除和新增路径，防止把移动手机实现到 `.web` 错当成对手机无影响。缺失或不可用的比较提交会令判定失败，不会继续发布。

## 完整 Web release 的复用

上传前读取 `web/current/.paws-release-revision`，将它作为候选来源。在上一份不可变 release 中，大小和单对象/已知分片 ETag 均与本地内容一致的文件，通过 OSS 服务端批量复制到新 SHA 目录；变化或缺失的文件才从 Runner 上传。

来源标记缺失或格式不可用时退回完整上传。OSS 列举/读取失败不会被伪装成“对象不存在”。同 SHA 目录中已有内容不同仍然拒绝覆盖；复制后的全部对象仍做校验。复制中断可通过已有目标对象校验继续补齐，复制内容损坏会在公开资源更新和正式入口切换前失败。

新目录仍保留完整版本，可用于独立校验、原子切换和回退；不会把旧资源删除，也不会将上传完成当作正式激活。日志分别统计 Runner 上传、OSS 内复制、目标目录已有复用的文件数与字节。

```sh
node --test scripts/classify-ota-impact.test.cjs scripts/ota-delivery-workflows.test.mjs scripts/upload-web-assets.test.mjs scripts/deploy-web.test.mjs scripts/web-production-deploy.test.mjs
```

这些测试使用本地 Git 仓库和 OSS CLI 替身，验证判定及对象校验/复制/失败边界。实际云端耗时改善必须在优化合并后的生产 workflow 中另行测量，不能把本地替身耗时当作上线收益。
