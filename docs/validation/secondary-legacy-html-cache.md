# 次入口旧式 OSS HTML 代理兼容

## 问题与修复

Android 加号修复 PR961 的主入口 Web 已激活、production OTA 已发布，但 Web 部署在更新次入口时失败。新增 HTML 缓存策略只识别带 `paws-web-oss` 标记的配置；只读确认实际次入口沿用无此标记的旧配置，仍有正确的站点级 OSS HTML 兜底。

失败发生在本地转换阶段，早于 SCP、备份和远端写入；次入口未被该次失败改动，主入口保持上线。没有通过手工修改服务器配置代替 CI。

兼容处理只接受已批准次入口中的唯一顶层默认 handler，且要求直接 rewrite 到 `/web/current/index.html` 和唯一精确受信 OSS upstream。部分/重复标记、多个兜底、错误地址与嵌套伪装继续拒绝。HTML 使用 deferred `Cache-Control: no-store`；后端、其他站点、资源与画布缓存边界保留，不新增或重写旧站点的路由标记。

## 验证

- 旧代码在历史无标记 fixture 及真实 Caddy HTTP 集成中先复现生产错误；修复后通过。
- 21 项相关 Node 测试通过且无跳过，含有标记/无标记两种真实 Caddy HTTP 验证、GET/HEAD/304、资源缓存、代理边界、幂等与部署/回滚保护。
- 已对脱敏的真实 70 行次站配置完成只读转换与重复执行检查；成功，不修改远端配置。
- 独立评审未发现 Critical / Important。
- CI 补充次入口配置/部署测试和对应路径触发，防止相关回归遗漏；安装方式对齐 CI 后，直接读取并执行工作流中的完整命令，187/187 通过且无跳过（含此前缺 yaml 的 bots 套件）。
- 此次仅修改发布脚本、测试与 CI，无 App JS/native/runtime 变化；不需要重新发布 Android OTA 或 APK。

额外尝试的未修改测试需单独披露：`configure-production-bots-caddy.test.mjs` 初次因未安装工作树依赖缺少 `yaml` 导入失败；后续使用 CI 相同安装方式验证。`configure-production-tunnel-caddy.test.mjs` 的 `CLI writes changed and unchanged outputs and never overwrites a destination on invalid input` 在本地含空格路径下因 `%20` 路径找不到模块失败；本补修没有修改该模块，不将额外测试称作全通过。

最终 CI、承载本修复的 main Web 发布与双入口上线结果由同任务发行记录分别维护。Android 修复的原生组件、视频与用户手机未验边界见 [加号菜单验收](android-add-menu-scroll.md)。
