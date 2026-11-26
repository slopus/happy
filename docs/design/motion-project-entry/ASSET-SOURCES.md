# 底稿与资源来源

- Paws 会话标题栏、输入区和会话行：在用户授权范围内从当前正式页面的可见节点采样，替换代表内容后保存于 `source-fragments.js`。没有保留原 App 脚本、业务请求、身份和文件路径。
- 框架与样式：当前 Paws 的 `SessionView`、文件工作区、主题和浮层规范；本稿为局部 DOM 复用与静态复原，准确范围见 `REVIEW.md`。
- Ionicons、Feather、Octicons：复用原页实际加载的 Expo 图标字体，以原字体数据内联在 `assets/icons.css`，保留字形与字体家族。字体来源为公开的 Expo / react-native-vector-icons 发布资源，按其各自许可使用。
- 正文：使用原页面的系统 UI 字体栈，没有将未加载的字体声明当作实际渲染。
- 影片画面：本稿原创 CSS 示意，用于解释工程打开后的工作区关系；没有生成或公开用户原片、截图、私人照片皮肤或原生 Studio 的分发包。

公开白名单仅为 `index.html`、`baseline.html`、`base.css`、`base.js`、`flow.css`、`flow.js`、`source-fragments.js`、`assets/icons.css`。本文件与评审记录不在公开快照中。
