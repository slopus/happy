# HTML 预览中的动态本地图片

## 问题与范围

PC Web 会话文件区将 HTML 和初始 DOM 中的本地资源打包后，放入独立 origin 的 iframe。素材画布通过 JavaScript 创建图片，并在进入可见区域时设置相对 `src`；这些地址未经过初始打包，因而被预览的 CSP 拒绝，出现裂图。

本次在现有预览和“运行交互”入口接入按需图片读取，不改变布局、主题或原始 HTML 文件。静态模式继续禁用脚本。初版新增逻辑使用 `.web.ts`。后续评审修复同时修改静态打包器及共享路径解析；OTA 由既有分类器按真实文件判定。

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


## 评审问题修复（2026-11-26）

| 问题 | 最终行为 | 回归 |
| --- | --- | --- |
| defer 脚本错过初始化 | 本地经典脚本字节转为 data script，保留 defer/async，由浏览器原生调度；DOMContentLoaded 无重放 | 实际执行脚本，断言 body 可用、顺序及原事件监听 |
| CSS 关闭标签变成 HTML | 仅转义 closing-style 的斜杠，重新解析仍是 CSS 字符串 | 脚本标记未执行、字符串原值及媒体比较符保留 |
| CSS 变量/image-set 漏资源 | 解析 custom property URL 与 image-set 的直接字符串资源，沿原作用域读取 | 文件读取和 AST 正反例，type()/content 不误读 |
| 打印 CSS 影响屏幕 | link 转 style 保留 media 等属性 | media=print 保留；实际浏览器屏幕正文可见 |
| 自包含 SVG/字体被拒 | 支持安全 MIME 白名单 data 资源；HTML/JS data 与网络仍拒绝 | 编码/base64 SVG、WOFF2、危险类型及真实解码 |
| IMG 移出重插后裂图 | 匹配原 id/src 的成功响应可写到暂离 DOM 的节点 | 成功重插、失败不重试、旧响应不覆盖 |
| 取消后仍发后续读取 | 每次 read 前后、异步媒体导入后检查原 AbortSignal | 真实组件与真实 builder：卸载/切文件/刷新 |
| 编码文件名损坏 | 先按原始 URL 分隔 query/fragment，再解码路径 | #/?/Unicode 文件名、编码 traversal/协议/反斜杠/NUL |

完整 App 637 文件/6039 测试、文件工作区与 runtime 202 项、类型检查、独立代码评审均通过。受控实际浏览器使用候选打包器输出，在 opaque sandbox 下通过 11 项检查，含 readyState=interactive、DOMContentLoaded 单次、有效 SVG/WOFF2 解码和 detached IMG 重插；这层证据不代替正式 Paws 文件入口。

新增 script-src data: 仅用于本地读取后嵌入的脚本字节；原始外链 data 脚本仍不通过路径解析。没有开放网络连接、同源、嵌套 frame、表单或执行工具能力。原生依赖、包名和 runtime 未修改。

仍保留的边界：模块、srcset、CSS @import、动态 CSS/媒体、离屏图片、本地 JSON 请求未新增支持；静态 128 项/32MiB、动态图预算及既有符号链接边界保留。各发布与正式浏览器结果由本次发行记录维护。
