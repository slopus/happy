# IndexedDB 完整链路验收

运行：`pnpm exec tsx --tsconfig packages/happy-cli/tsconfig.json packages/happy-app/e2e/fixtures/indexeddb-migration/serve.mjs`。

复用 codex-settings 的独立 PGlite 服务端、真实完整 App、ApiSessionClient 加密消息传输；新增两个合成账号与 running/complete 控制。不启动 daemon、不调用模型、不接触生产账号。

认证链接仅保存在 ignored test-results/indexeddb-migration/auth-{a,b}.txt，不输出链接或凭据。Web 以 queryAuthOnly 启动，避免默认开发凭据在刷新时替换显式账号。

Case：
- IDB-AUTH-01：已登录草稿刷新恢复、发送一次并由服务端与执行端读回。
- IDB-TABS-02：两个真实标签页各自队列；先撤回再释放执行条件，撤回消息不发出，另一页消息只发一次。
- IDB-TABS-03：同账号并发草稿冲突保留；刷新不会静默覆盖。
- IDB-ACCOUNT-04：A/B 切换和刷新后身份/草稿/消息不串。
- IDB-LOGOUT-05：退出权威清理另一页 namespace、附件及恢复正文，旧页不可发送或复活旧数据；其他账号保留。

只允许使用 Ego 浏览器执行交互。控制器的 /running 与 /complete 仅代表受控执行端生命周期事件；/metrics 与 /persisted 是单次只读验证，不使用业务轮询。

开发 query-auth 只用于最初引导，不保证账号索引初始化后选择账号。切换使用头像菜单中的账号按钮，账号列表行进入详情。已登录场景等待实际 textarea 可见与账号选择完成；短时缺少会话不直接判作删除。退出后应核对权威 records/recovery/attachment stores，并刷新此前打开的页面。

本次执行结果与未完成的即时切回 case 见 docs/validation/web-indexeddb-migration.md；浏览器 Case 由 Ego 交互执行，browser-helpers 不是自动完成全部 Case 的 runner。
