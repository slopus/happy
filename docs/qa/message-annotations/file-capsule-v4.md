# 批注预览第四版：同尺度修订与验收

本地实现与本轮验收完成，未推送、未上线。沿用第三版的胶囊与文字气泡，只修订预览浮卡及其锚定。独立 agent 对同尺度图复审：上轮四项主要视觉问题已解决；不代表逐像素一致或用户最终认可。

## 修订结果

- 单行、单条预览从400×95.09改为400×75；外层padding从10改为0，单层内容padding为10×16，圆角14。
- 头部24高，元信息与意见均14px，意见行高23；元信息从当前主题的辅助文字色派生中性灰，保持主题明暗亮度。
- 直接使用语义shadow.color，去掉对已有alpha的二次衰减；原约1.6%/0.5%黑改为主题提供的10%黑两层柔和投影。
- 内部条目无圆角、无局部缩放；多条之间为直分隔。整张浮卡hover1.02，实测408×76.5；减少动态效果设置仍有效。
- 预览距计数6px，窗口缩放与滚动时使用触发器的实时位置，修复旧固定快照导致的脱离。
- 保留点击空白关闭，没有补回参考中的叉号。

## 同尺度图

使用用户最新指定图片作为参考；其CSS视口与DPR未知，按卡片外框等宽归一，不直接比较原始像素。三列分别为参考、旧版真实截图、新版真实截图；统一400宽、浅色、单条、同一意见，保留各自宽高比。旧/新来自同一完整App测试会话与相同视口。对比HTML仅使用CSS裁切和排列真实图片，没有重绘产品组件或修改截图内容。

- 参考：`/Users/jacky/.happy/attachments/2026-11-11T08-52-19-179Z-0-image.png`
- 旧版：`/var/folders/45/t5wb73212hvf82tchdvfdfhw0000gn/T/paws-browser-step-KQxiAd/screenshot.png`
- 新版：`/var/folders/45/t5wb73212hvf82tchdvfdfhw0000gn/T/paws-browser-step-2htdFb/screenshot.png`
- 对比图（已直接发送会话）：`/var/folders/45/t5wb73212hvf82tchdvfdfhw0000gn/T/paws-browser-step-gFwL73/screenshot.png`
- 深色最终状态：`/var/folders/45/t5wb73212hvf82tchdvfdfhw0000gn/T/paws-browser-step-8ELeS6/screenshot.png`

截图均由绑定helper捕获并上报；PNG及相邻证据回执保留在原路径。独立agent实看对比与完整App图，确认比例、字体关系、投影和容器层级四项主要问题已解决。剩余次要差别：缩略内容更简化、阴影略比参考明显；没有把未知DPR的参考描述为精确像素标定。

本机可重开对比产物与尺寸记录位于被忽略的`packages/happy-app/test-results/markdown-annotations-v4/`；HTML内嵌已验证图片，不含认证入口。

## 验证

| Case | 结果 |
| --- | --- |
| 同状态预览尺寸 | 旧400×95.09，新400×75；间距由10收为6 |
| 整体hover | 实际matrix(1.02)，408×76.5；条目transform为none |
| 多条与长意见 | 两条对应计数；长意见自然换为三行69px，内部条目圆角0；删除后计数回到1 |
| 空白关闭 | 预览消失且已保存意见保留 |
| 1280×800缩放 | 同轮读回预览完全位于视口，距计数约6.01px，没有保留旧位置 |
| Gingham深色 | 底色rgb(26,35,48)，按钮hover为rgb(31,42,56)，派生灰色元信息及文字可见 |
| 检查 | 批注专项20项测试通过，happy-app typecheck、Web export成功 |

本轮未重复未变更的模型提交或原生端链路，未点击统一发送、未调用真实模型。浏览器操作使用独立任务空间，生产账号与服务未修改。

经验已更新至ego-ops的paws / verify-markdown-file-annotations；全库校验遇到非本轮操作的索引缺失引用：`paws / inspect-real-chat-performance` 的operation文件不存在。本轮未创建该条目，未补造无证据知识；未将全库校验报告为通过。
