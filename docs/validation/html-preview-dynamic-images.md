# HTML 预览中的动态本地图片

## 问题与范围

PC Web 会话文件区将 HTML 和初始 DOM 中的本地资源打包后，放入独立 origin 的 iframe。素材画布通过 JavaScript 创建图片，并在进入可见区域时设置相对 `src`；这些地址未经过初始打包，因而被预览的 CSP 拒绝，出现裂图。

本次在现有预览和“运行交互”入口接入按需图片读取，不改变布局、主题或原始 HTML 文件。静态模式继续禁用脚本。新增逻辑使用 `.web.ts`，原静态打包器及手机实现保持原样。

## 实现边界

- bootstrap 位于 CSP 后、素材脚本前，观察动态 `img[src]` 和 `video[poster]`；仅请求页面实际赋值的本地图片。
- iframe 以事件请求父页面；父页面只处理当前 iframe 来源、当前 bundle channel 与合法请求字段，沿原 reader 和路径解析规则读取并返回 data URL。没有轮询、网络代理、执行桥、同源权限或应用凭据传入 iframe。
- 子页面 FIFO 最多 16 个在途请求，父页面最多 4 个文件读取并发。重复读取合并；父缓存最多 128 个 URL、16M UTF-16 code units，单张原始图片最多 10 MiB。缓存预算只约束父缓存，不代表整个 iframe 的 DOM 或图片解码内存上限。
- 响应核对当前图片地址，避免旧请求覆盖新图；切文件、停止交互或卸载后忽略旧回包；失败不自动重试。
- 保留 `connect-src 'none'`、`img-src blob: data:` 和 `sandbox="allow-scripts"`。路径词法边界沿用原实现，不新增符号链接安全保证。
- 本次覆盖已接入 DOM 的动态图片；未扩展离屏 `new Image().onload`、动态 CSS 图片、模块导入或动态视频读取。

## 验证

```sh
pnpm --filter happy-app exec vitest run sources/components/fileWorkspace
pnpm --filter happy-app typecheck
```

自动化覆盖动态 DOM 与图片赋值、重复引用、旧响应竞态、错误来源/channel、读取失败、卸载、初始 bootstrap 顺序、258 张图突发排队、超过 128 张的缓存换出、文件读取并发和原有文件工作区行为。桥脚本另经项目 Babel 的 Web 开发/生产转译后在独立 DOM realm 执行。

正式上线后，从原会话的原 HTML 验证总览、分类、逐秒画面和大图，核对图片真实解码、资源地址和目录读取。正式 CI/版本、浏览器回执及未验设备边界保存在本次发行记录，不将单元测试等同正式页面验收。
