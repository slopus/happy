# 测试、构建与发布

## 测试

测试与源文件同目录，使用 .test.ts。每个 schema 至少覆盖：

- 所有合法 discriminator 成员。
- 缺失必填字段与非法类型。
- refine/superRefine 的跨字段约束。
- create/helper 的默认值与显式值。
- legacy/alias 仍能解析现有 fixture。

代表性文件：

- src/messages.test.ts
- src/sessionProtocol.test.ts
- src/controlMessages.test.ts
- src/rigMetadata.test.ts

consumer 行为不能只靠本包测试；跨包改动还需在实际消费包增加 contract test。

## 命令

    pnpm --filter @slopus/happy-wire typecheck
    pnpm --filter @slopus/happy-wire test
    pnpm --filter @slopus/happy-wire build

test 会先 build 再运行 Vitest，发布前 prepublishOnly 会再次执行 build 和 test。

## 发布

包同时输出 ESM、CJS 与 declarations，由 pkgroll 构建。package.json 的 exports 是公开 API；src/index.ts 未导出的文件视为内部实现。新增依赖应保持最小，协议库不得依赖 React、Node 专用文件系统或具体服务端框架。

版本发布要根据兼容性选择 semver，并在 workspace consumers 中更新声明。不要依赖未发布的 workspace 源文件来验证 npm 用户场景。
