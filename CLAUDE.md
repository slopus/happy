# CLAUDE.md — Paws 协作约定

> Paws 最初源自 [slopus/happy](https://github.com/slopus/happy)，现已作为独立产品与代码线维护。
> GitHub 仍保留 fork/upstream 关系是平台与下游 fork 约束，不代表本仓库需要持续跟随上游。
> 本文件规定**分支模型**与 **worktree 开发流程**，所有在本仓库工作的 Claude 会话都必须遵守。

## 零、最高优先级规则：根仓库永远保持干净

- **根仓库工作区 `~/jacky-github/happy` 只保留给 `main`。**
- **根仓库必须始终与 `origin/main` 完全一致。** 不允许在这个工作区留下任何已跟踪改动、未跟踪文件、临时实验或功能分支。
- **所有实际开发一律在 sibling worktree 中进行**，目录形如 `../happy--<topic>`。
- 如果发现根仓库变脏，**第一优先级不是继续开发，而是先把改动迁移到 sibling worktree，并把根仓库恢复为干净的 `main`。**

根仓库的日常自检命令：

```bash
cd ~/jacky-github/happy
git status --short
git rev-parse HEAD
git rev-parse origin/main
```

- `git status --short` 必须为空。
- `HEAD` 必须等于 `origin/main`。
- 如果任一条件不满足，先修复根仓库状态，再继续其他任务。

## 一、远端与仓库

| 远端 | 地址 | 用途 |
|------|------|------|
| `origin` | `github.com/wangjs-jacky/happy` | Paws 的唯一开发与发布主场，所有成果推这里 |
| `upstream` | `github.com/slopus/happy` | 历史来源，只读；仅用于署名、考古或明确指定的单次参考，不做例行同步 |

## 二、分支模型

```
   origin/main           ← 【Paws 主分支】独立长期集成基线
        ▲
        │  Pull Request（不直接 push 功能 commit）
   feat/* · fix/*              ← 功能/修复分支，从 main 切出
```

- **`main` 是 Paws 的主分支**，是独立集成基线，所有成果最终汇入这里。
- **禁止把功能 commit 直接 push 到 `main`**，一律通过 PR 合入（`--base main`），保留评审与记录。
- 功能分支从 `main` 切出，开发完提 PR 回 `main`。

> ⚠️ 根目录 `AGENTS.md` 里的 "Sync To Main" 工作流针对的是上游语境的 `origin/main`。
> 在 Paws 独立开发语境中，「主分支」始终指 **`main`**，以本文件为准。

## 三、日常开发流程

```bash
# 1. 先把根仓库恢复到干净的 main
git switch main
git fetch origin
git reset --hard origin/main
git clean -fd

# 2. 从根仓库创建 sibling worktree（不要在根仓库直接开发）
git worktree add ../happy--<topic> -b <branch-name> main

# 3. 进入 worktree 开发、提交（提交信息见第六节）
cd ../happy--<topic>
pnpm install
git add -p && git commit

# 4. 推送到 fork
git push -u origin <branch-name>

# 5. 提 PR 到 main
gh pr create --repo wangjs-jacky/happy --base main --head <branch-name>
```

### PC/UI PR 可视证据门

只要 PR 包含用户可见的 PC Web、布局、图标、状态或交互变化，合并前必须让 PR 正文自身携带逐 Case 证据：

1. 声明 `Visible UI cases: N`。
2. 用 `Case ID → 问题 → 修复前 → 修复后` 矩阵逐项嵌入图片；每个可见 Case 一组，整页总览或 contact sheet 不得重复代替多组证据。
3. `N` 必须同时等于矩阵中的可见 Case 数和独立前后截图组数。纯逻辑或不可见后台 Case 不进入 `N`，共享证据必须在表内说明理由。
4. 图片使用不可变 commit SHA 的仓库 URL 或 GitHub 上传附件，不得引用合并后会删除的功能分支。PR 创建或更新后必须打开实际 PR，确认每张图片能够渲染。
5. 独立验收 Agent 必须评审实际 PR 正文。缺图、错配、重复占位、失效链接或只在聊天/本地报告中存在时，即使测试和 CI 全绿也不得合并。

使用根目录 [`.github/pull_request_template.md`](.github/pull_request_template.md) 的 Visual evidence 区块，不要在 `gh pr create --body` 时删掉该区块。非视觉 PR 填 `Visible UI cases: 0` 并说明原因。

### 主题与交互表面颜色规范

所有用户可见的界面和交互态都必须从**当前 Unistyles 主题的语义 token**取色；主题包不是仅供页面背景和主按钮使用的色板。该规则同时适用于 Android、iOS、PC Web。

- 组件不得为卡片、列表项、按钮、图标按钮、菜单项、导航项、文件夹入口等交互表面写死 `#...` 色值，也不得从某个主题包/基础主题直接挑色。需要新颜色时，先在主题定义中增加有语义的 token，再由组件消费该 token。
- 普通、hover、pressed、selected/active/focused、drag-over 等状态必须使用对应的语义表面 token。现有通用层级为：`surface`（普通）、`surfacePressed`（按下/hover）和 `surfaceSelected`（选中/激活）；不要用 `background`、焦糖色或其他默认主题颜色临时替代交互态。
- 主题包的 `light` 和 `dark` 两态必须完整覆盖交互表面层级。在 `sources/themePacks.ts` 的 `applyAccent` 中，`surfacePressed` 必须映射到当前主题包的 `surfaceHigh`，`surfaceSelected` 必须映射到 `surfaceHighest`，避免深蓝/深色主题仍露出基础焦糖暖色。
- 固定品牌资产、图片和明确不可主题化的内容色可以例外；例外必须是有意的产品设计，而不是为了省略 token。

主题相关改动的验收门禁：

1. 修改主题 token 或主题包映射时，为至少一个非默认深色主题补充/更新单测，断言交互态 token 来自该主题包；不得只验证默认焦糖主题。
2. 修改可见交互态时，在深色非默认主题（优先 `ginghamDark`）下检查普通、hover/pressed 和 selected/active 状态。PC Web 的可见变更还必须在 PR 的逐 Case 前后证据中展示该主题状态。
3. 若发现某个主题下出现与当前主题不协调的残留底色，优先检查组件是否绕过 `theme.colors.*`，以及主题包是否遗漏了语义 token；不要用局部硬编码掩盖问题。

## 四、Worktree 开发流程（隔离开发，推荐）

需要在不打断当前工作区的前提下并行开发时，用 git worktree。约定如下（与全局 `~/.claude/CLAUDE.md` 一致）：

| 项目 | 约定 |
|------|------|
| **位置** | 仓库**同级目录（sibling）**：`../happy--<topic>`。**不要**放在仓库内部或 `.claude/worktrees/` 等工具默认路径 |
| **命名** | 目录 `happy--<topic>`；分支名直接用 `<topic>` slug，**不加 `worktree-` 前缀** |
| **基分支** | 一律从 `main` 切 |
| **根仓库** | `~/jacky-github/happy` 永远停留在干净的 `main`，不承载开发改动 |

### 创建

```bash
# 先确保根仓库是最新的 main
cd ~/jacky-github/happy
git switch main
git fetch origin
git reset --hard origin/main
git clean -fd

# 再从 main 切出隔离 worktree + 同名分支
git worktree add ../happy--<topic> -b <topic> main
```

### 安装依赖（pnpm monorepo）

本仓库是 **pnpm workspace**（`pnpm@10.11.0`，8 个 workspace 包）。worktree 里直接重新安装即可，pnpm 全局 store 会硬链接复用、很快：

```bash
cd ../happy--<topic>
pnpm install
```

> ❗ **不要**像普通 npm 项目那样 symlink 整个 `node_modules`：pnpm 的 `node_modules/.pnpm` 虚拟 store + 各 workspace 包各自的 `node_modules` 结构复杂，symlink 极易损坏。老老实实 `pnpm install`。

### 开发完成

```bash
# 推送并提 PR
git -C ../happy--<topic> push -u origin <topic>
gh pr create --repo wangjs-jacky/happy --base main --head <topic>

# 合并后清理 worktree 与分支
git worktree remove ../happy--<topic>
git branch -d <topic>

# 最后确认根仓库仍然是干净的 main
git -C ~/jacky-github/happy status --short
git -C ~/jacky-github/happy rev-parse HEAD
git -C ~/jacky-github/happy rev-parse origin/main
```

## 五、上游关系

- **不做例行 upstream sync。** Paws 的产品、品牌、发布和演进路线独立于原项目。
- `upstream` remote 只保留作历史署名与代码考古；不要把“落后 upstream”当成维护欠账。
- 如果某次任务明确要参考或移植上游实现，按普通第三方代码引入处理：先评估兼容性、许可和 Paws 现有行为，再通过独立 PR 合入。

## 六、构建与本机运行说明

- **构建单个包**：`cd packages/happy-cli && pnpm run build`（`tsc --noEmit && pkgroll`，产物在 `dist/`，已被 `.gitignore` 忽略）。
- **本机为 dev-link 模式**：全局 `paws`（以及兼容 alias `happy`）通过 `npm link` 指向 `packages/happy-cli`。因此**改源码 → `pnpm run build` 重建 `dist/` 即对新会话生效，无需发布 npm 包**。
  - daemon 给每个新会话 spawn 全新进程读取 `dist/`，**重建后不必重启 daemon**；但**已在运行的会话**仍是旧代码（已加载进内存），需新开会话才用上新代码。
- 只有当你想让**其他机器 / 其他人**用上改动，或想从 dev-link 切回干净的 npm 安装版时，才需要走「发 npm 包」流程。


## 六补充、Mac mini 上 Paws daemon / CLI 切换规范

> 本节只针对 Mac mini 这台远端执行机。它解决的是 Paws App 能看到机器在线，但新建 Codex 会话失败、daemon 日志出现 `Session webhook timeout` 的反复问题。

### 背景

Mac mini 的 Paws daemon 是手机 Paws 远程拉起 Codex/OpenCode/Claude 会话的入口。它不仅要运行，还必须从稳定环境启动：

- Node 固定使用 `/Users/jacky/.nvm/versions/node/v24.14.0/bin/node`
- 工作目录固定为 `/Users/jacky`
- `HAPPY_SERVER_URL=http://47.115.228.20:3005`
- `HAPPY_CODEX_PROXY_URL=http://127.0.0.1:10802`
- `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` 指向 `http://127.0.0.1:10802`
- 需要时继承 `NODE_EXTRA_CA_CERTS=$HOME/.reclaude/ca.pem`

历史故障模式：某个 Paws/Codex 会话从 repo 目录或 Homebrew Node 环境重启了 daemon，导致 daemon 进程变成 `/opt/homebrew/Cellar/node/.../bin/node`、`PWD` 变成 `~/jacky-github/happy/packages/happy-cli`。之后 App 新建 Codex 会话时，子进程 `happy codex --started-by daemon` 3-4 秒内退出，daemon 侧最终报 `Session webhook timeout`。

### 硬约束

1. 在 Mac mini 上不要直接运行裸 `happy daemon start`、`happy daemon restart` 或从 `packages/happy-cli` 目录启动 daemon。
2. 不要依赖 `happy` shebang 的 `/usr/bin/env node` 启动 daemon；不同上下文会解析到 Homebrew Node。
3. 需要重启 daemon 时，一律使用稳定入口：

```bash
/Users/jacky/.local/bin/happy-daemon-rc
```

4. 如果必须手动等价执行，必须显式固定目录、Node 和环境：

```bash
cd /Users/jacky
export PATH="/Users/jacky/.nvm/versions/node/v24.14.0/bin:/opt/homebrew/bin:/Users/jacky/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export HAPPY_SERVER_URL="http://47.115.228.20:3005"
export HAPPY_CODEX_PROXY_URL="http://127.0.0.1:10802"
export HTTP_PROXY="http://127.0.0.1:10802"
export HTTPS_PROXY="http://127.0.0.1:10802"
export ALL_PROXY="http://127.0.0.1:10802"
export NO_PROXY="localhost,127.0.0.1,::1,47.115.228.20"
[ -f "$HOME/.reclaude/ca.pem" ] && export NODE_EXTRA_CA_CERTS="$HOME/.reclaude/ca.pem"
/Users/jacky/.nvm/versions/node/v24.14.0/bin/node --no-warnings --no-deprecation /Users/jacky/jacky-github/happy/packages/happy-cli/dist/index.mjs daemon start
```

### 切换后的必检项

每次切换 CLI、更新 `packages/happy-cli/dist/`、修改 npm link、切 agent，或任何动作触发 daemon 重启后，必须检查：

```bash
happy daemon status
LOG=$(ls -t ~/.happy/logs/*-daemon.log | head -1)
sed -n '1,60p' "$LOG"
lsof -nP -iTCP:10802 -sTCP:LISTEN
```

通过标准：

- daemon log 里的 `processArgv[0]` 是 `/Users/jacky/.nvm/versions/node/v24.14.0/bin/node`
- `nodeVersion` 是 `v24.14.0`
- `PWD` / `workingDirectory` 是 `/Users/jacky`
- `serverUrl` 是 `http://47.115.228.20:3005`
- 日志出现 `Machine registered` 和 `Connected to server`
- `127.0.0.1:10802` 有 `v2ray` 监听

### 新会话 smoke check

如果用户反馈 App 里 Mac mini 在线但新建 Codex 会话失败，优先看 daemon 最新日志是否有：

- `spawn-happy-session`
- `Child PID ... exited with code 1`
- `Session webhook timeout`

修复后至少验证一次新会话能报告到 daemon。日志里必须出现：

- `Session started: ...`
- `Session reported`
- `startedFromDaemon: true`
- `flavor: "codex"`

### 排查顺序

1. `ssh macmini` 是否通，先排除整机/Tailscale 问题。
2. `lsof -nP -iTCP:10802 -sTCP:LISTEN`，确认代理还在。
3. `happy daemon status` 和最新 daemon log，确认 daemon 连接的是阿里云中继。
4. 如果失败发生在 `spawn-happy-session` 后，重点查 daemon 的 Node、`PATH`、`PWD`，以及是否绕过了 `happy-daemon-rc`。

## 七、提交信息规范

```
<type>(<scope>): <简述>

Generated with [Claude Code](https://claude.ai/code)
via [Paws](https://paws-landing-eo4.pages.dev)

Co-Authored-By: Claude <noreply@anthropic.com>
```

- 推送/拉取前若需代理：`git config --global http.proxy http://127.0.0.1:10802`（https 同理），完成后 `--unset`。

## 八、本地构建 Android APK 并发布到 GitHub Release

> 在本机直接出一个可 sideload 安装的 Android APK，并作为构建产物发到 GitHub Release（不进 npm、不进商店）。所有命令在 `packages/happy-app/` 下执行。

### 前置条件（本机已就绪，换机时核对）

- JDK 17（`java -version`）、`ANDROID_HOME` 已指向 Android SDK、`android/gradlew` 存在
- **无需自备 keystore**：`android/app/build.gradle` 中 release 签名回退到 `debug.keystore`，产物为 debug 签名，足够 sideload 安装/内测（**不可上架商店**）

### 构建步骤

```bash
cd packages/happy-app

# 1) android/ 是 gitignore 的 prebuild 产物。首次/换机/配置变更后需重建；已存在可跳过
pnpm prebuild                  # = rm -rf android ios && expo prebuild

# 2) 构建 release APK（APP_ENV 决定环境，按需 preview/production）
#    必须加 -PreactNativeArchitectures=arm64-v8a 只打真机用的 arm64：
cd android && APP_ENV=production ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a

# 产物固定路径：
#   packages/happy-app/android/app/build/outputs/apk/release/app-release.apk
```

> ⚠️ **务必带 `-PreactNativeArchitectures=arm64-v8a`**：`gradle.properties` 默认 `reactNativeArchitectures=armeabi-v7a,arm64-v8a,x86,x86_64`，不加参数直接 `assembleRelease` 会打成含 4 种架构的 **universal 包（~293MB）**，其中 x86/x86_64 是模拟器专用、armeabi-v7a 是老 32 位 ARM，真机全用不到。只打 arm64 后包体回到 **~122MB**。sideload 给真机一律只要 arm64。

> 想直接装到连着的真机/模拟器而不出 APK 文件，用 `pnpm android:production`（会 install 而非只 assemble）。

### 发布到 GitHub Release

```bash
# 版本号取自 app.config.js（APP_ENV=production 下当前为 1.7.1），不要用 package.json 的 1.0.0
VERSION=$(cd packages/happy-app && APP_ENV=production node -e "const c=require('./app.config.js');const cfg=typeof c==='function'?c({config:{}}):(c.default||c);console.log(cfg.expo?.version||cfg.version)")
TAG="android-v$VERSION"            # tag 加 android- 前缀，与桌面/其他端 release 区分
APK="packages/happy-app/android/app/build/outputs/apk/release/app-release.apk"

# 走代理（见第七节）后再推 tag 与建 release
git tag "$TAG" && git push origin "$TAG"
gh release create "$TAG" --repo wangjs-jacky/happy \
  --title "Android $TAG" \
  --notes "本地构建的 Android APK（debug 签名，可直接 sideload）。" \
  "$APK"
```

### 约定

- **Release tag 用 `android-v<version>` 前缀**，避免与 iOS/桌面端或上游 release 命名冲突
- APK 是构建产物，**不提交进 git**（`*.apk` 已隐含在 prebuild 产物链路中，不要 `git add`）
- 同一版本号重复发布前先删旧 release/tag，或递增 `app.config.js` 的 version
- 此流程纯属本机/内测分发；正式商店包仍走 EAS（`pnpm release:build:appstore`）

## 九、自建 OTA：发布、版本管理与真机验证

> 改了 JS 层（RN 组件 / 逻辑，**无原生改动**）后，不必重新出 APK，直接推自建 OTA，真机冷启动即拉到更新。所有命令在 `packages/happy-app/` 下执行。

### 机制速记

- 自建 OTA 把 `expo export` 的产物上传到**阿里云 OSS 桶 `happy-app-ota-jacky`**（`oss-cn-hangzhou`），脚本 `scripts/publish-ota.js`。
- 当前 production 使用 **`runtimeVersion: 23`**，development/preview 使用 **runtime 22**（见 `scripts/ota-runtime-config.js`）。2026-08-08 因新增 `expo-media-library` 原生模块，分别从旧 runtime 22/21 前移；旧二进制因此不会收到引用该模块的 OTA。**runtimeVersion 必须和装机包完全一致**，否则该机器永远跳过这次更新——各 runtime 是互不相通的独立通道 `manifests/<platform>/<runtime>/<channel>/`。改 runtime 只改共享配置，并运行 `pnpm test:image-batch-native-config` 与对应测试；必须先出包含新原生模块的安装包，不能把此变更发布到旧 runtime。
- **频道（channel）分流**：App 端 `updates.url` 指向 FC 服务 `happy-oa-server-...fcapp.run`，请求头 `expo-channel-name` **按构建变体注入**（`app.config.js` 的 `otaChannel` 映射）：
  - **dev / preview 包 → `preview` 频道**（给开发在真机预览 PR）
  - **production 包 → `production` 频道**（线上正式用户）
  - FC 服务按该频道头取 `manifests/<platform>/<runtime>/<channel>/latest.json`；production 频道在新路径未命中时回退到旧的无 channel 路径（存量用户无感）。改 url / 频道映射都必须重新构建装机才生效。
- 凭证复用本机 `aliyun configure` 的默认 profile（`~/.aliyun/config.json`），脚本用 `aliyun ossutil` 上传，无需环境变量里写 AccessKey。

### 频道模型与常见误区（传承 · 反复踩过）

- **preview 频道的 `latest.json` 被所有 JS-compatible PR 共享、谁最后发谁覆盖**：对 `main` 提的 PR 会触发自动 `ota-preview`，但 workflow 检测到原生依赖、lockfile、Expo config、runtime mapping 或 native/plugin 目录变化时会跳过发布，直到匹配的新二进制就绪后手动 dispatch。所以「preview latest」≠ 你某个 PR 的包；想在真机看某个具体 PR，必须用「定向锁版本」（版本浏览站扫码 / App 内 Developer→OTA→OTA Versions 选该 stamp），不能只跟 latest。
- **生产 OTA 不在 PR 的 checks 里**：`ota-production.yml` 触发条件是 **push 到 `main`（即合并 PR）**，不是 `pull_request`。所以它**不会出现在 PR 页面的检查列表**——合并后它作为一个**独立的 push 触发 run**（工作流名「Self-hosted OTA production (on merge to main)」）才跑。native-sensitive merge 会由兼容性 job 标记并跳过实际发布；JS-compatible merge 才会继续上传。盯着 PR checks 找生产 OTA 会误以为「没发」，去 **Actions 页**看那个 run 才对。preview OTA 才是挂在 PR 上的。
- **手机拉不到 OTA 的排查顺序**：设置→连点版本号→Developer→**Expo Constants**，核对 **Channel**（preview/production，决定拉哪条频道）+ **Runtime Version**（必须与该 runtime 的 OTA 通道一致，对不上永远跳过）+ **Update ID**（对上 `manifests/android/<rt>/<ch>/latest.json` 的 `id`）。再确认没在 OTA Versions 里锁死旧 stamp。FC 服务按请求头 `expo-runtime-version` 动态取路径，**改 runtime 不用重部署 FC**。

### 发布

```bash
cd packages/happy-app
pnpm ota:selfhost            # 发到 production 频道（= node scripts/publish-ota.js，缺省 production）
pnpm ota:selfhost:preview    # 发到 preview 频道（= ... --channel preview，仅 preview 包能拉到）
# 也可手动指定：node scripts/publish-ota.js --channel <channel> --platform <android|ios>
```

- **PR 预览自动化**：协作者把分支推到本仓库并对 `main` 提 PR 后，`.github/workflows/ota-preview.yml`
  会自动 `expo export` + 发到 `preview` 频道，并在 PR 上评论 Update ID 与验证步骤。开发用 preview 包真机预览，
  确认无误再合并。命中 native-sensitive 路径时自动发布会跳过，必须先构建并安装匹配 runtime 的新包，再手动 dispatch。需在仓库 Secrets 配 `ALIYUN_OSS_ACCESS_KEY_ID` / `ALIYUN_OSS_ACCESS_KEY_SECRET`（建议用只授权该桶的 RAM 子账号）。fork 来的 PR 因拿不到 secret 会自动跳过。
- 建议**先在功能分支提交一次再发**，让发出去的包对得上一个明确 commit。
- **默认验收闭环**：凡是 `packages/happy-app` 的用户可见 JS/UI/交互改动，完成本地测试/类型检查后，默认还要执行一次 `pnpm ota:selfhost:preview`，把 preview OTA 当成给用户验收的标准交付物；只有原生改动、runtimeVersion 不兼容或其他明确不能走 OTA 的场景，才允许例外，并且要把阻塞写明。
- **OTA 回复格式**：只要这次交付里实际发布了 Paws OTA，给用户的回复里除人类可读说明外，还要额外附上一段结构化的
  `<happy-ota-preview> ... </happy-ota-preview>` 元数据块（标签名是兼容协议），方便客户端右侧面板直接提取和展示。
- 发布成功会打印「频道 / 新版本 id（UUID）/ manifest 地址」。OSS 上版本结构（按频道分层）：
  - `manifests/android/23/<channel>/latest.json` —— production 频道当前线上指针（preview 使用 runtime 22）
  - `manifests/android/23/<channel>/<毫秒时间戳>.json` —— 每次发布留的历史备份（JS 包从不删，故任意历史版本可回滚）

### 列出全部 OTA 版本 / 看当前线上

```bash
# 注意带上频道段（production / preview）
aliyun ossutil ls oss://happy-app-ota-jacky/manifests/android/23/production/ | grep -E '\.json'
```

- `latest.json` 与某个 `<时间戳>.json` 的 **ETag 相同** → 那个时间戳就是当前线上版本。
- 或直接 `pnpm ota:rollback`（生产频道）/ `pnpm ota:rollback:preview`（预览频道）：列出该频道所有历史版本并标注「← 当前线上」，选序号即把该版本覆盖回 `latest.json` 完成回滚。

### 真机验证「是否已拉到本次 OTA」

App 内 `useUpdates`（`sources/hooks/useUpdates.ts`）在**每次启动 + 每次切回前台**查更新，查到就后台下载并弹「**有可用更新**」横幅；点横幅 `reloadApp()` 重载进新包，不点则下次冷启动自动生效（`__DEV__` 下不查更新）。

两种验证手段：

1. **看行为**（最快）：完全杀掉 App 重开 → 等横幅 → 点它重载（或再冷启一次）→ 观察这次 OTA 的可见改动是否出现。
2. **看 Update ID**（最准）：
   - **设置 → 连点底部「版本号」那一行好几下** 解锁开发者模式（多击 hook 在 `SettingsView.tsx`，切 `devModeEnabled`）。
   - 出现 **Developer** 分组 → `/dev` → **Expo Constants**（`/dev/expo-constants`）。
   - **Update ID** 应等于发布时打印的那个 UUID；新 production 原生包的 **Runtime Version** 必须是 `23`（preview 为 `22`）。对上即真机正跑该 OTA。

> 服务端侧无法直接确认设备是否来拉（OSS 未开访问日志）；以真机上的 **Update ID / 行为** 为准。PostHog 有 `ota_update_available` / `ota_update_applied` 事件（带 `ota_version`）可作旁证。

### preview 版本浏览站 + App 定向切换（单设备锁定任意历史版本）

> 解决「回归验收时不知道真机当前跑哪个 commit 的 OTA」+ 想看某历史版本。**仅 preview 频道、仅本设备生效**，production 永远跟随 latest。

- **版本浏览站**（公开）：<https://wangjs-jacky.github.io/happy-ota-site/>
  列出 preview 频道全部历史版本（commit/时间），每行一个二维码，手机扫码即把本机锁定到该版本。
  托管在 **GitHub Pages**（仓库 `wangjs-jacky/happy-ota-site`）——⚠️ **阿里云所有默认域名**
  （OSS `*.aliyuncs.com`、FC `*.fcapp.run`）对 HTML 一律强制 `text/plain + Content-Disposition: attachment`
  （反钓鱼，不绑备案自定义域名改不了），所以网页**不能**托管在阿里云，最终用 GitHub Pages。
  网站源码 `packages/happy-app/ota-server/site/index.html`，改完同步到 happy-ota-site 仓库根 `index.html` 重推即可。
  页面前端直接 fetch OSS 列版本，依赖下面的 OSS 匿名 list + CORS。
- **App 内切换**：设置 → 连点版本号解锁开发者模式 → Developer → OTA → **OTA Versions**，
  列出版本、高亮当前运行/锁定项，点选即锁定该版本并重载，可一键「解除锁定回到最新」。
  页面底部有「诊断」分组（HTTP 状态/字节数/解析结果），排查真机拉不到版本时用。
- **机制**：App 用 `Updates.setExtraParamAsync('ota-target-stamp', <stamp>)` 把目标版本时间戳随
  `Expo-Extra-Params` 头发给 FC；FC（`ota-server/code/index.js`）仅在 preview 频道按该 stamp 取
  `manifests/android/22/preview/<stamp>.json`，取不到静默回退 latest。stamp 纯数字白名单防路径穿越。
  改 FC 后 `cd ota-server && s deploy --use-local -y` 重新部署。
- **依赖**：OSS 桶 `happy-app-ota-jacky` 对 `meta/` + `manifests/` 前缀开了匿名 `ListObjects`/`GetObject`
  （bucket policy，用 `oss:Prefix` 条件锁死只能列这两个前缀，不暴露 `updates/` 下 bundle）+ 一条 CORS 规则
  （`AllowedOrigin: *`，GET/HEAD）供网页跨域读取。**注意：该桶禁开静态网站托管**——一旦开启，标准域名的
  ListObjects API 会被网站模式拦截、返回 index.html，App/网页都拉不到版本（踩过）。
- **已知问题**：真机 App 内版本列表偶发拉不到（显示「暂无版本」），后端 curl 正常，疑似 RN 端 fetch/解析；
  已加诊断信息辅助定位，未最终收口。网站（GitHub Pages）与「当前状态」展示不受影响。

## 十、CLI 发 npm 包（@wangjs-jacky/paws）

> 让其他人不克隆代码即可使用 CLI：`npm i -g @wangjs-jacky/paws`，提供 `happy` / `paws` / `happy-mcp` / `paws-mcp` 四个命令。首发 1.2.0（2026-07-08，tag `cli-v1.2.0`）。

### 硬约束：Paws 使用的 happy-wire 必须 bundle 进 dist

- `packages/happy-cli/package.json` 中 `@slopus/happy-wire` **必须留在 `devDependencies`**（`workspace:*`），**严禁挪回 `dependencies`**。
- **Why**：pkgroll 只 bundle 不在 dependencies/peerDependencies 里的包。若放回 dependencies，发布时 `workspace:*` 会被替换成版本号，用户安装时从 npm 拉到的是**原项目发布的 zod3 版 wire**，与 Paws 的 zod4 代码不一致，运行直接报错。
- 发布前验证：`pnpm pack` 后解包确认 package.json 的 dependencies 不含 `@slopus/happy-wire`，且 `grep -E "from ['\"]@slopus/happy-wire" dist/*` 无外部 import（dist 里出现该字符串是内嵌 package.json 元数据，属正常）。

### 发布流程

```bash
# 1. 从 main 顶点建 release worktree（发布内容必须 = origin/main tip）
git worktree add ../happy--release-x.y.z -b release-x.y.z origin/main
cd ../happy--release-x.y.z && pnpm install

# 2. 先构建 happy-wire（其 exports 指向 dist/，不先构建 CLI 编译会失败）
pnpm --filter @slopus/happy-wire run build

# 3. 升 packages/happy-cli/package.json 的 version（提 PR 合入 main 后再发）

# 4. 发布（prepublishOnly 自动跑 build + 全量单测；node 用 v20+，本机默认 /usr/local/bin/node 是 v14 会挂）
cd packages/happy-cli
pnpm publish --publish-branch release-x.y.z

# 5. 打 tag（cli-v 前缀，与 android-v 系列区分）并推送
git tag cli-vX.Y.Z <发布时的 main tip> && git push origin cli-vX.Y.Z
```

### 注意事项

- **`publishConfig` 必须保留 `"access": "public"`**（scoped 包缺它首发报 402）
- **npm token**：在 `~/.npmrc`（granular、限 `@wangjs-jacky` scope、90 天过期，当前批次 2026-10-06 到期；记录见全局 `~/.claude/CLAUDE.md`）。发布报 EOTP = token 没有免 2FA 权限，需重建 token
- **包体 ~113MB 属正常**：106MB 是 `tools/archives/` 的 ripgrep/difftastic 全平台二进制（上游同款设计，postinstall 解压当前平台），CLI 代码本体仅 ~2MB
- **冒烟验证**：新包首发后 registry 元数据传播需 1-2 分钟；在干净目录 `npm init -y && npm i @wangjs-jacky/paws --registry https://registry.npmjs.org`，跑 `./node_modules/.bin/paws --version`（注意：目录里没 package.json 时 npm 会向上找祖先目录安装，务必先 `npm init -y`）

<!-- ob-index:start -->
## Obsidian 知识库

> 索引路径：`/Users/jacky/jacky-github/jacky-obsidian/wiki/projects/happy/index.md`
> 渐进式加载：先读本概览，需要详情时读取索引文件，再读取具体文章。

| 文件 | 主题 | 何时读取 |
|------|------|----------|
| pc-web-interaction-review-fix-loop.md | Paws PC Web 全站交互评审、独立选题/修复/验收与证据链 | 做 PC Web 交互评审、Picker 焦点修复或复用 Playwright 生产评审 Harness 时 |
| foreground-push-notification.md | 让会话通知在 App 前台也弹 + 点通知跳转会话 | 改推送通知行为、排查「收不到通知」时 |
| selfhost-server-deploy.md | 把服务端源码改动部署到阿里云 VPS（docker 离线叠层 + esbuild） | 部署/重建 happy-server、改服务端代码要上线时 |
| selfhost-intranet-deploy.md | 内网自托管实操手册（Docker Standalone + PGlite + 三端客户端配置 + 验证） | 在公司内网/隔离环境部署 happy-server，让 CLI+App 连内网时 |
<!-- ob-index:end -->
