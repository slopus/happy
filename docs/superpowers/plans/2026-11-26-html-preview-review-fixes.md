# HTML Preview Review Fixes Implementation Plan

> **For agentic workers:** Use the existing systematic debugging and TDD workflow; independent file ownership permits parallel implementation, followed by whole-change review.

**Goal:** 修复用户已确认的 HTML 预览评审 8 项问题，并完成正常 PR、CI 发布和实际入口验收。

**Architecture:** 保留当前受控读取、opaque sandbox、静态/交互开关与预算。静态打包器恢复脚本/CSS/内嵌资源语义，图片桥修复节点复用，组件取消后停止新增读取，路径解析先分离 URL query/fragment 再解码路径。

**Tech Stack:** React、TypeScript、css-tree、Vitest/JSDOM、Ego 浏览器。

**Spec:** 本会话上轮 8 项评审结果；验证入口 `docs/validation/html-preview-dynamic-images.md`。

## Global Constraints

- 根工作区只保留干净 main，实施在 sibling worktree；不同代理不写同一权威文件。
- 不放开网络、同源、嵌套 frame 或工具执行能力；原静态 128 项/32MiB 与动态图预算保留。
- 模块、srcset、CSS @import、离屏图片/动态媒体等能力扩展不属于这 8 项修复。
- 保留有意义的实际行为回归、类型检查和独立评审；CI 通过后沿现有持续授权正常 PR 合并及原 CI 自动发布。

## Review Focus

- defer 源码自己注册 DOMContentLoaded，多个脚本依赖顺序与 body 访问。
- 外链 CSS 中合法 closing-style 字符串、媒体条件与比较运算符不能变义。
- CSS 自定义变量/image-set 的图片读取不能误读普通字符串或 type()。
- 图片移出/重插时的成功、失败和旧响应竞态，关闭后不发后续 RPC。
- 编码 #/?/Unicode 文件名与编码 traversal/协议/反斜杠的边界保持。

## Task 1: 静态脚本、CSS 和 data 资源（问题 1–5）

Files: `htmlPreviewBundle.ts`、`htmlPreviewBundle*.test.ts`。
Interface: 保持 `buildHtmlFilePreview(content,path,root,read)` 返回 html/dispose。
- [x] 从已复现问题补真实执行/解析的失败测试，并验证红灯。
- [x] 恢复 defer/DOMContentLoaded 时序；安全序列化 CSS；补变量/image-set URL；保留媒体条件；允许安全内嵌图像/字体。
- [x] 运行相关测试与旧静态打包回归。

## Task 2: 图片节点生命周期与取消（问题 6–7）

Files: `htmlPreviewImageBridge.web.ts`、`HtmlFilePreview.web.tsx` 及对应测试。
Interface: 现有图片消息协议、FIFO16、父读取并发4不变；所有 read 前后遵守同一 AbortSignal。
- [x] 先验证 detach→响应→reinsert 和首资源读取中关闭预览的失败测试。
- [x] 修复节点 current/pending 状态，阻断取消后的后续依赖读取。
- [x] 验证旧响应、失败不重试、pagehide 和会话切换回归。

## Task 3: 路径解析、集成与交付（问题 8）

Files: `previewResources.ts`、`previewResources.test.ts`、验证说明。
- [x] 编码 #/? 文件名先红，再按原始 URL 分隔 query/fragment 后解码路径；测试安全边界。
- [x] 集成全部修改，运行文件工作区/完整App/类型/OTA runtime检查，进行独立代码评审。
- [ ] 正常 PR 与精确 head CI，通过后正常合并，核验 Web 和适用 OTA 各目标。
- [ ] 在正式日常入口打开原 HTML 和合成回归文件验核心行为；维护实际证据、经验和根 main 清洁。
