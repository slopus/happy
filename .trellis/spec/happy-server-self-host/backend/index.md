# Happy Server Self Host 规范

## 适用范围

packages/happy-server-self-host 是发布壳，不拥有服务端业务源码。它把 packages/happy-server 的 standalone 入口、Prisma schema/migrations 和 Happy Web 应用打包成 npm 包与 happy-server 可执行文件。

包内主要文件：

- scripts/build-runtime.cjs：构建 standalone.mjs，校验依赖漂移并复制 Prisma 资产。
- scripts/postinstall.cjs：发布包安装后生成 Prisma client。
- bin/happy-server.cjs：命令入口。
- index.cjs：编程式入口。
- README.md：用户运行与环境变量合同。

修改前读 packaging-and-runtime.md。
