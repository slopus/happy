# 编程智能体图标轮换与按电脑配置

## 最终需求

用户否定上一版通用双向箭头，要求使用Codex/Claude Code/OpenCode自己的图标；点击当前图标轮换，无Agent下拉。用户自行配置电脑上哪些Agent参与轮换，并参考Magpie支持版本检查和更新。用户于本轮明确不需要截图；未启动浏览器截图或原生设备视觉验收。

## 行为

- 新建会话浮层右上角显示当前Agent品牌SVG，切换后换成下一Agent图标；管理入口位于浮层内，也可从设置→编程智能体进入。
- 按machineId保存启用项并通过账号设置同步。无配置默认仅Codex；显式空列表保持空，不用已安装项自动补齐。只轮换同时已启用、机器可用且Paws已有执行适配器的Agent。
- 现有五种执行器为Codex、Claude Code、OpenCode、Gemini、OpenClaw。本次没有将Magpie的全部Agent目录伪装成Paws支持。
- 模型与Agent独立；相同模型ID可保留，模型选择不切执行器。空配置时显示管理入口，禁止新建编程会话；实际派发前再次核对最新偏好。
- 设置页逐电脑展示Agent图标、已安装/当前版本/最新版本及启用开关。用户点击检查才查询远端版本，无新轮询；进入页面只检测当前安装。
- 更新复用加密machine RPC和现有有界processRunner。标准npm全局安装验证package元数据及真实路径后按确定版本更新；明确的Claude/OpenCode原生安装用原生更新器；Homebrew沿实际prefix/formula/cask更新。自定义Codex独立版本目录保持手动更新，不改安装渠道。
- 更新采用单次预览token、过期和来源/路径/版本复核、全局更新锁；拒绝任意命令和重复/过期调用，结束后重新读取实际版本。没有更新用户实际Agent、停止现有会话或替换daemon。

## 来源

参考Magpie固定提交289184a409c0e38a3a0a5282dbde93b56da309ca的internal/gui/assets/agentsmanager.js、internal/agent/cliupdate.go。图标源为Magpie同提交的Lobe Icons资产，MIT归属和许可随组件保留；没有复制轮询或读写Magpie模型配置。

## 验证与交付边界

App组件/真实Zustand状态/设置持久化/空配置派发门禁/OTA契约定向148项回归通过；wire请求白名单2项通过；CLI service、processRunner、环境RPC与machine集成47项回归通过，共197项。App/CLI typecheck与构建、Android导出通过。

真实本机只读探针按宿主正常PATH（排除pnpm exec注入的workspace .bin）确认：Codex独立目录为manual，Claude/OpenCode为可验证的npm安装，后二者能检测版本差异。未执行真实升级，不把mock更新通过称为本机已升级。初次直接从pnpm exec探测命中了开发依赖的CLI包装器，版本失败；排除开发工具注入后复验正常。自动探针遇到启动失败保留installed状态并显示check-failed。

新版界面和启用配置可通过定向preview验收；版本管理需要目标电脑运行本分支配套CLI。旧daemon明确提示先更新Paws CLI。本轮未切换当前稳定执行端、未合并或发布正式Web/production OTA，也没有验证手机已加载。前一版preview 1795093720149属于已被用户修正的箭头方案，不作为当前设计验收版本。

## 定向 preview 回执

源码提交：ce3adc22；发布时工作区干净。channel=preview，platform=android，runtimeVersion=24。stamp=1795097438405；Update ID=d3e71b9b-2476-78ac-c7ba-aff9c3e3e578。

不可变manifest：https://happy-app-ota-jacky.oss-cn-hangzhou.aliyuncs.com/manifests/android/24/preview/1795097438405.json

匿名读回清单核对id/runtime/源码，主包44,085,036字节完整下载并核验SHA-256与manifest一致。707项既有资源由发布脚本复用，没有逐项重新下载全部资源；未覆盖preview latest。仅代表制品发布与主包校验，用户手机加载、实际更新和正式上线未验。

当前稳定daemon未激活配套CLI；version管理在旧daemon显示需要升级Paws CLI的提示。图标与按电脑配置无需新native模块。用户单次选择不截图已在本文件保留，不扩为未来任务豁免。Android OPS的model-connection-catalog和harness已按证据补充经验；Magpie参考没有浏览器操作，无Ego成功日期写回。


维护检查：Happy OPS全库知识校验返回两处已有文件链接无效（Android publish-ota / Web verify-deployment），本轮没有修改这些链接；经验正文已保存，未声称该知识库结构校验通过。该结果与197项产品回归、构建和OTA主包哈希校验区分。

## 云端 E2E 增补：刷新清空配置修复

真实云端浏览器回归发现：启用配置上传后，完整刷新会恢复默认Codex。通过云端读回、浏览器请求追踪和相同schema复现确认，Zod 4的`SettingsSchema.partial().parse({})`仍会执行字段的`.default({})`，恢复空pending-settings时构造出清空codingAgentMachines的修改，随后同步覆盖云端。移除该字段的schema默认值，继续由settingsDefaults提供正常缺省值。新增回归先失败后修复通过；相关109项App测试与App类型检查通过。

E2E使用隔离云端完整Happy server/PGlite与分支Web export、真实账号加密设置和machine RPC。更新器使用产品service和实际子进程，但包管理器仅操作测试沙箱；模型回复为transport stub。正式Web、用户账号、真实Agent安装与当前稳定daemon不参与。用户明确不需要截图，未采集截图/视频。

云端静态服务启动时枚举资源路由（wildcard=false），增量上传新hash文件后不能直接通过旧进程新路由访问；测试环境为新主包增加独立loopback gzip资源端点，HTML仍由同一云端App服务提供。主包内容SHA-256为4466330062a3a14fe1c8794184bc6bd60aa9e26c62e0cb4283be053979beb661。该端点只提供精确测试bundle，不是正式发布方案。

## 云端最终回执

`coding-agent-cloud-cases.json`的10个Case均通过。修复版完整刷新后Codex/Claude/OpenCode开关与云端一致；另一电脑保持Codex默认。三个品牌SVG及轮换顺序通过，同名模型不切执行器，另选模型后实际spawn=claude、首条消息model=shared-model，页面收到CLOUD_AGENT_TRANSPORT_OK并完成。全部禁用并输入文本后发送disabled、云端最终读回空数组、spawn仍仅1次。

进入设置检测checkUpdates=false；显式检查发送true。Claude沙箱实际升到1.1.0，仅1次成功安装；OpenCode失败保留1.0.0且更新token被消费，另一电脑无安装。重启夹具时曾保留上一轮故障marker，导致一次Claude更新失败；清除marker再显式重新检查后成功，并已修正夹具初始化。测试控制器最终设置恢复Codex+Claude。

修复源码4cc4576c的定向preview：stamp=1795103886121，Update ID=5ec2c72f-288a-b89b-c358-743e7c9815c3；android/preview/runtime24，不覆盖latest。不可变manifest：https://happy-app-ota-jacky.oss-cn-hangzhou.aliyuncs.com/manifests/android/24/preview/1795103886121.json 。主包44,084,983字节，SHA-256=4dcbff44a62079a170f570834311cab9e3775dd52dce23c7153fbf60a7d89e25，与manifest一致。新增修复相关109项测试、7项runtime契约、App类型检查、Web/Android导出通过。最初误用了不存在的node test文件路径，随后以真实otaRuntimeConfig.test.ts复验通过；打包暂存的server源码曾被App tsc包含，移出TS扫描后类型检查通过，非产品类型错误。

合成worker/controller已关闭、Ego任务空间已结束，本地合成凭据及请求追踪文件已删除。RackNerd的专用server与gzip资源进程按PID、cwd及进程组核验后停止；阿里云早期失败尝试仍因SSH banner超时无法确认进程/目录清理，未重启机器或更改其他服务，不能声称所有云端临时资源已清理。Ego OPS新增verify-coding-agent-manager、Web E2E本机经验已写回；Ego知识校验通过。没有正式Web部署、CLI发布或真实手机加载验收。

清理补充：RackNerd上核对已无cwd位于专用测试目录的进程后，已删除该专用目录；两条本地测试SSH转发已关闭。阿里云早期目录仍待SSH恢复后清理。

## 正式发布前集成

同步当前main，仅apiMachine顶部imports发生冲突，保留跨Agent接续类型与本次管理service两项。独立评审发现Windows npm shim与shell-free执行器不兼容，新增先失败回归，并在Windows复用既有安装检测、明确手动管理，不生成无法执行的升级token；Mac管理路径保持不变。全量本机CLI回归出现受环境影响的集成失败与文件事件超时，结果按正式CI和定向复验分别记录，不称全量通过。
