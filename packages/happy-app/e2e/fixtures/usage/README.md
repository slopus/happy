# 使用情况真实组件验收

在 `packages/happy-app` 运行：

```sh
node e2e/fixtures/usage/serve.mjs
```

默认监听 `127.0.0.1:49847`。`?theme=dark` 使用 Gingham Dark，`?theme=light` 使用 Caramel Light。只运行本地的真实 UsageDialog、UsagePanel 和热图组件；账号、机器、API边界为公开合成数据，不连接生产服务器，不发送模型请求。

只有需要前后对照且用户已要求时才加 `--before`，以 `?revision=before` 重放固定基线 `62e86e1e1` 的 UsagePanel；普通功能验证不构建对照版本。

通过 Ego 验证以下 Case：

1. Google/QQ 标签只切换 quota；年度图仍显示机器级范围和365个日期。
2. 点击日期、展开和收起明细；非缓存输入 + 缓存 + 输出等于总量。
3. 热度底色不随选中而丢失；hover/focus提示有精确日期与token。
4. 日历仅一个Tab停靠点，方向键移动日期；第一次Escape关闭提示、对应keyup不关闭Modal，第二次Escape正常关闭。
5. 1280px和390px均无整页横向溢出；窄屏完整年度可横滚，Tooltip留在视口内。
6. 深浅主题分别使用当前主题变量，弹窗关闭后可重开。

快照更新/滚动保留和Tooltip更新的确定性回归在 `CodexActivityHeatmap.web.test.tsx`；原生触控与首次滚动由 native.test 保护。这些组件证据不代表完整生产App/服务链路或用户Android真机验收。

不要为此入口使用其他浏览器自动化。Ego关键帧应按当前Happy会话、run、任务空间和目标绑定报告；数字ID不得从旧运行复制。结束后关闭本轮任务空间并停止本次server进程。
