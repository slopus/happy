# 项目 GitHub 仓库入口

项目/子目标标题右侧显示所属项目的 GitHub 图标；点击复用系统外链打开逻辑（Web 新标签页）。缺失或无效地址时隐藏。选中任务后的桌面目录也保留入口。图标、hover 与焦点复用 GoalBoardButton 的当前主题语义色和键盘行为。

项目 `index.md` 的可选 frontmatter 字段：

```yaml
---
github_url: https://github.com/owner/repository
---
```

唯一来源位于项目层，feature/task 继承所属项目，RPC/cache 字段名为 `githubUrl`。旧档案无需迁移；坏字段不影响整个项目加载。仅解析 frontmatter，不从正文中的参考仓库推断；拒绝凭据、非 GitHub 地址、子路径、查询参数与 fragment，兼容引号、CRLF、尾部斜线和 `.git` clone 后缀。

Goal First OPS 的 `references/knowledge-schema.md` 定义维护协议：首次源码推送核实后，以及仓库重命名/转移后更新字段。Release OPS 的发布与重命名操作已补同一检查点。规则与真实本机档案在原 Skills 仓库维护，不在本仓库复制本机项目资料。

## 验证（2026-11-20）

- CLI Goal Board/RPC：134 passed，2 skipped；新目录字段用例先失败再通过。最后 URL 验证器调整后目录 15 项重新通过。
- App 项目缓存、导航、RPC、按钮主题与数据刷新：57 passed。
- happy-wire build、App typecheck、CLI typecheck 通过。CLI 首次检查缺 paws-agent dist，构建工作树内该依赖后重新通过；未切换 daemon 或生产 CLI。
- 用户明确要求截图后，使用完整隔离 App、同一合成项目、Gingham 深色主题和 1680×950 / DPR 1 视口采集两种状态的前后图。基线 UI 使用 4b4339af 的原组件，候选使用 7d960659；未改造 DOM 来伪造效果。
- 真浏览器检查标题右侧图标、44×44 触达区、仓库地址提示与键盘焦点反馈；无字段时隐藏。截图来自相同 Ego 空间与精确目标，关键帧已向 Happy Skills 上报。手机和正式上线仍未验。
- 无原生依赖、权限或 runtime 变化；本次未发布 APK/OTA/Web，也未修改生产执行端。

## 部署边界

客户端与机器端 CLI 均有变更；仅更新 Web 不会使旧 CLI 返回新字段。合并后沿正式 CI 发布 Web/适用 OTA，机器端按现有稳定入口更新 CLI；不能将本工作树的构建产物视为已切换运行环境。


## 用户要求的前后截图

| 状态 | 修改前 | 修改后 |
| --- | --- | --- |
| 已配置仓库 | [原图](project-github-link/before-with-repository.png) | [原图](project-github-link/after-with-repository.png) |
| 未配置仓库 | [原图](project-github-link/before-without-repository.png) | [原图](project-github-link/after-without-repository.png) |

验收环境只含合成账号和项目；启动器为 stub，未提交模型指令。捕获前通过单次合成机器 presence 事件恢复可比在线状态，未实现查询轮询。早期截图含离线提示，最终对比采用本表在线版本。
