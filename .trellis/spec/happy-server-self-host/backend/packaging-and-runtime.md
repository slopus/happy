# 打包与运行时

## 所有权

服务逻辑只能改 packages/happy-server。这个包只负责组装、发布和启动。不要复制 route、auth、storage 或 Prisma 模型到本包修补行为。

build-runtime.cjs 从 sibling happy-server 构建 sources/standalone.ts，并让外部依赖在安装包中解析。package.json 的 dependencies 必须与 happy-server 运行时 dependencies 完全一致；脚本会将缺失、版本不同和额外依赖视为构建失败。

@slopus/happy-wire 当前由构建脚本选择内联。调整 bundledDependencies 时必须验证发布 tarball 在没有 monorepo 的目录中启动。

## 发布资产

发布包必须包含：

- dist/standalone.mjs
- prisma/schema.prisma 与全部人工 migration
- webapp 静态文件
- bin、index.cjs、package.json、README

postinstall 在源码 checkout 没有复制后的 prisma 目录时应安全跳过，在真实发布包中则生成 client。启动进程的 cwd 保持包根，以便 runtime 找到 prisma/migrations 和 webapp。

## 验证

    pnpm --filter happy-server-self-host build
    pnpm --filter happy-server-self-host bundle:webapp
    pnpm --filter happy-server test
    pnpm --filter happy-server-self-host pack --pack-destination <临时目录>

在全新临时目录安装 tarball并执行 happy-server，是发布改动的关键验证。不要把本地 workspace symlink 成功当成发布成功。

## 反例

- 只在 self-host 包修复服务端 route。
- 手工维护第二份 schema。
- 为消除构建错误删掉依赖漂移检查。
- 发布依赖 monorepo 相对路径的产物。
