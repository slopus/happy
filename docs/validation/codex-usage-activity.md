# Codex 用量修复与活动热图

2026-11-26。用户已批准实施前两轮核对方案。基线：`62e86e1e1d3083e3a01798bfacc403bd89048c8c`。开发在 sibling worktree，根工作区保持干净 main。

## 已实现

- 原生 `token_usage_record` 和旧 `token_count` 归一化，支持独立压缩请求、response身份去重、金额修订和明确零值；不把压缩历史快照当成新请求，不读取 Magpie 私有网关账本。
- 新旧记录关联尊重强身份；修复同额独立请求、不同会话误删及正常子任务被回放启发式丢弃。保留import边界和quota来源，累计不一致提供诊断。
- 独立热图组件采用紧凑13px格/3px间隙、完整365天、范围和机器级来源。Web支持日期悬停、单Tab停靠和方向键；选中外圈不覆盖热度底色，滚动位置不会被快照/窗口变化反复重置。
- 日期明细可展开，显示非缓存输入、缓存读取及输出，明确总量含缓存；中文采用万/亿并保留精确可访问数值。
- Native fallback保留触控入口，不引入DOM、Motion、Tailwind或新原生依赖。Web交互隔离于 `.web.tsx`。
- 用Paws既有技术独立实现，没有复制RareUI运行代码；来源与许可评估见 `rareui-activity-heatmap-assessment.md`。

## 同截止真实对账

固定上海时间2026-11-25 00:00–19:00，默认Codex根及同5个账号保留根。当前Magpie CSV与修复后的Paws逐字段相等：

| 指标 | 两边相同 |
|---|---:|
| 输入（含缓存） | 1,211,023,278 |
| 缓存读取 | 1,191,393,792 |
| 输出 | 4,003,492 |
| 推理（输出子集） | 1,700,629 |
| 总量（含缓存） | **1,215,026,770** |

token差额为0。Paws计入5719个有效事件、103个原生会话；Magpie多两条零用量行。相比11月25日最早核对快照，源日志后来补录了一条具有较早时间的142,602-token回执，因此使用当前同截止两侧重新固定的数据，不把旧数字和新数字混比。

固定对账60天扫描约6.36秒，峰值RSS约1169MB，warnings为空。另验证生产默认365天：退出0、约7.17秒、峰值RSS约1349MB、74个有活动日期，未堆溢出、未退回正文扫描。全年15条诊断为14条计数下降（15次事件）及1条累计与单次不一致；读取失败/导入边界错误/rg回退均为0。不猜补历史差额，不把全年描述为无异常；瞬时内存仍较高，尚未改成持久增量账本。

## 自动验证与独立复核

- CLI：usage38 + history21 + accountLaunch26，共85项通过；CLI类型检查通过。
- App：UsagePanel17、Web热图7、Native热图4、日期模型10、Dialog5+1，共44项通过；App完整类型检查通过。
- OTA影响分类11项通过；本次共享JS会保守进入已有OTA流程，但本轮未发布。
- 独立后端review通过，额外8个合成场景复核了压缩计数域、fork、身份冲突、零值、同额独立请求及quota池隔离。独立Web/接入review通过。

用例针对真实边界，未用上述检查替代浏览器或用户设备证据。

## 浏览器验证

使用仓库 `e2e/fixtures/usage/serve.mjs` 挂载实际UsageDialog/UsagePanel/热图；数据和RPC为可复跑的合成边界，不是生产完整App E2E。通过Ego真实输入验证：

| Case | 结果 |
|---|---|
| U1 quota范围 | QQ显示77%，日历仍365格及机器级范围；Google状态可重开恢复 |
| U2 日期与明细 | 点选日期、展开明细，选中保留原热度色和独立outline |
| U3 键盘与退出 | 单Tab；ArrowLeft按周移动；首次Escape只关Tooltip，第二次关闭Modal，重开正常 |
| U4 宽窄屏 | 1280px无页面溢出；390px页面宽390、dialog宽366、全年保留365格；日期提示右边界382不越界；真实滚轮可到明细末尾，三项指标和说明均在视口内 |
| U5 主题 | Gingham Dark与Caramel Light实际渲染通过；颜色来自当前主题 |
| U6 数据与位置 | 快照更新、选择/滚动保留以及Tooltip读取最新数据由DOM回归通过，未冒充生产实时服务事件验收 |

关键帧已按当前Happy run/任务空间/目标绑定回传。用户未回复可选PR前后截图询问，未制作PR对比矩阵；功能验收关键帧与PR对比区别记录。媒体为本轮已验证状态组成的回放，不称连续录屏。

9秒组件状态回放已通过Happy send_file交付，格式H264/yuv420p、1280×900、270帧，完整解码通过。媒体在App的ignored `test-results/usage/usage-component-state-replay.mp4`，不是可访问部署或用户设备录屏。

## 发现并修正的验收问题

- 夹具useAuth每次返回新credentials对象，导致加载effect重复运行、页面无响应。修为稳定对象，在同一Ego任务空间关闭失败页后明确记录新目标重跑；失败页未计入通过证据。
- 月份碰撞过滤先保留残月导致完整12月缺标签，改为优先完整月份。
- Tooltip保存旧day对象导致快照更新后提示旧金额，改为按日期从当前模型派生。
- RN Web Modal监听keyup；仅在日格keydown关闭提示会同时关闭外层。消费同一Escape的keyup，下一次正常传给父层。
- Portal不继承卡片border-box，在390px时提示越界16px；Tooltip显式定义盒模型和视口宽度限制，并用真实边界复验。
- 初版rg只搜新字段子串会流入巨型compacted历史、触发堆限制；改为顶层记录筛选，新增16MB历史/键序/空白压力回归。

## 保留边界与发布状态

- 缺独立usage回执、只有compacted历史快照的请求不猜数补账；本机已知两笔漏记都有独立回执并已补齐。
- 不完整新回执会提醒并跳过，不将缺失字段当明确零值。早日金额修订等下一次完整扫描更新，daemon即时当天刷新策略未改。
- 没有连接的ADB设备，原生组件测试不代表Android真机验收。
- 无新增原生模块、权限、图标或runtime变化，无需因本次修改重建APK；OTA/更新及回滚继续采用项目既有契约。本轮未部署、未发布OTA/APK，也未替换运行中的daemon。
- 本轮交付为已实现、已验证的本地分支；上线和当前用户设备验收须在后续授权发布阶段完成。

## 经验回写

- Codex OPS：`references/capabilities/usage/operations/summarize-daily-tokens.md` 及原本机对账记录。
- Android OPS：`references/projects/happy-paws/operations/usage-activity-heatmap.md`，状态partial，真机未验。
- Ego OPS：`references/sites/paws/operations/verify-usage-activity.md`，已维护站点索引并通过知识校验。
- Web E2E：`experience.local.md` 的本次组件验收与媒体边界。设计发现保留在本工程报告，没有重复建立另一套设计规范。

## v2：按 RareUI 源码补齐交互（2026-11-26）

上文保留v1的实现、对账与验收历史。v1本地提交为`139070f30`。用户指出独立实现可能漏功能后，重新逐项阅读RareUI固定SHA的完整组件、demo及许可，新增双端能力对照，见[源码评估](rareui-activity-heatmap-assessment.md)。本轮只修改展示及其测试，不改变后端计数或重新宣称已部署。

- 补齐卡片内覆盖展开、摘要图标叠层与三项真实指标的转换、入场、减少动态及`open/defaultOpen/onOpenChange`合同。Web采用持久徽标的FLIP与逐列进入；Native采用原生驱动的整体入场和图标交叉过渡。两端动效有意适配，不宣称逐帧相同。
- 保留全年365天横向查看、主题语义颜色、独立选中外圈和原有机器级数据；用真实非缓存输入、缓存和输出承接参考的三行信息，不制造仓库/项目排行。
- 新增44dp原生日期控制，Web窄屏对应按钮也为44px高；13px图表格仍是小目标，不把它描述为已满足触控面积。
- 独立review发现并修复异步快照到达后徽标不显示、变换中测量导致终点偏移、月份动画被提前终止、受控更新后焦点留在隐藏区域。另修复键盘自动滚动后的提示定位；Escape主动关闭的提示不会因随后resize/scroll重开。

### v2验证

App定向回归共**59/59**：Web热图13、Native热图8、共享展示5、日期模型10、UsagePanel17、Dialog5+1；App完整TypeScript检查退出0。`UsagePanel`旧mock缺少Animated导致的测试失败已补齐必要边界，原17项断言保留。独立源码review与独立三帧布局评审通过；截图评审不能代替动态输入或真机验收。

| Case | 实际浏览器结果（组件夹具，合成数据） |
|---|---|
| V2-1 覆盖与返回 | 1280px深色卡片展开前后stage均为272px；指标徽标与对应锚点最终偏差0px，切换前一天后收起仍保留日期 |
| V2-2 动态设置 | 动画运行中反向收起回到正确叠层；运行时改为减少动态后，展开面板活动动画数为0，徽标仍正确对齐 |
| V2-3 键盘层次 | 明细内Escape先收起面板并回到summary；日期方向键移动焦点；下一层Escape先关提示，随后Escape关闭外层Modal，重开成功 |
| V2-4 窄屏与提示 | 深浅主题390px下页面宽均为390，365格完整保留；浅色窄屏ArrowLeft到2026-11-18，提示右边界382px，未越出视口 |
| V2-5 触摸与长说明 | 390px浅色浏览器触摸模拟滑动，内部scrollTop到55（scrollHeight259/clientHeight204）；末尾说明进入可见区域，完整可读 |
| V2-6 异步与受控 | 空快照恢复、受控更新焦点、同批快速切换、运行时减少动态取消与快照更新不重放入场，由DOM/native回归及独立模拟复核；不称为生产服务事件E2E |

Ego最终状态及关键步骤已使用同一run绑定回传；失败/未验证帧未作为通过步骤上报。浏览器移动视口和触摸模拟不代表Android实体设备。

本轮视频为真实浏览器按时间顺序采样的62帧，包含展开、前一天和收起，附末尾停留；不是静态三状态拼接，也不宣称设备原生录屏或恒定帧率源。原生CDP screencast回执参数被当前Ego封装拒绝，已停用该路径，改用同一已核对目标的顺序截图采样。成品`test-results/usage/usage-v2-browser-motion.mp4`为6.43秒、1280×900、H264/yuv420p、193帧；完整解码通过，并由Happy send_file发送成功。媒体仅证明所录动效，键盘和触摸由上表另行验证。

### v2经验与交付边界

- Ego OPS：更新`references/sites/paws/operations/verify-usage-activity.md`及站点导航，记录覆盖/减少动态/焦点提示和触摸滚动方法，完成知识校验。
- Android OPS：更新`references/projects/happy-paws/operations/usage-activity-heatmap.md`、项目索引与通用基线；保持`partial / last_verified: null`，原生真机未验。
- Motion OPS：更新`references/adaptations/layout-flip.md`及父索引，沉淀稳定锚点、边框坐标、逆向先测后取消、异步就绪和尾随动画结束；原例验证日期未冒充本次日期，库校验通过。
- 未新增依赖或原生模块，未构建APK、发布OTA、替换daemon或上线Web。根工作区仍为干净main；实现保存在sibling worktree。本地实现与组件验收完成，生产及用户Android设备不在本轮已验证范围。
