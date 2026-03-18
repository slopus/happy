---
name: release-changelog
description: 准备新版本更新日志，更新 CHANGELOG、README、docs 共 6 个文件
---

# 版本更新日志

准备新版本的更新日志，涉及 6 个文件的更新。

## 前置准备

### 确认上一版本

```bash
# 读取当前最新版本号
cat packages/happy-app/sources/changelog/changelog.json | head -5
```

### 整理提交记录

```bash
# 找到上一版本的 changelog commit
git log --all --oneline --grep="Version N"

# 列出自上一版本以来的所有提交
git log <上版本commit>..HEAD --oneline --no-merges
```

按功能领域分类提交，向用户展示分类结果，等待确认后再开始写入。

## 更新步骤

### 步骤 1：编写 CHANGELOG.md

文件：`packages/happy-app/CHANGELOG.md`

在文件顶部（`# Changelog` 之后、上一版本之前）插入新版本条目。

**格式要求**（参考已有版本风格）：
- 标题：`## Version N - YYYY-MM-DD`
- 一句话摘要（英文）
- Bullet points，每条以功能领域开头，简洁描述用户可感知的变化
- 不写技术实现细节，面向用户

### 步骤 2：生成 changelog.json

```bash
cd packages/happy-app
npx tsx sources/scripts/parseChangelog.ts
```

自动生成 `packages/happy-app/sources/changelog/changelog.json`，确认 `latestVersion` 已更新。

### 步骤 3：更新 README（中英文）

文件：`README.md` + `README.zh-CN.md`

**关键原则**：这两个文件展示的是「Happy Next 相比 Happy 的完整功能」，**不按版本分**。

- 将新功能合并进已有章节（如 DooTask 新功能并入「DooTask Integration」章节）
- 全新功能领域加为新的独立章节（不加版本标签）
- 同步更新 "Why Happy Next" 亮点列表（带 emoji 的那段）
- 中英文内容保持一致

### 步骤 4：更新 changes-from-happy 文档（中英文）

文件：`docs/changes-from-happy.md` + `docs/changes-from-happy.zh-CN.md`

**关键原则**：同样**不按版本分**，是 Happy Next 相对 Happy 的完整变更记录。

- 更新顶部 TL;DR 概览表格
- 将新功能合并进已有章节
- 全新功能领域加为独立章节（不加版本标签）
- 更新 bug 修复计数
- 中英文内容保持一致

## 文件清单

| # | 文件 | 方式 |
|---|------|------|
| 1 | `packages/happy-app/CHANGELOG.md` | 手写新版本条目 |
| 2 | `packages/happy-app/sources/changelog/changelog.json` | 运行脚本自动生成 |
| 3 | `README.md` | 合并新功能进已有章节 |
| 4 | `README.zh-CN.md` | 合并新功能进已有章节 |
| 5 | `docs/changes-from-happy.md` | 合并新功能进已有章节 |
| 6 | `docs/changes-from-happy.zh-CN.md` | 合并新功能进已有章节 |

## 注意事项

- CHANGELOG.md 是唯一按版本记录的文件，其余 4 个 md 文件都是功能总览
- 先向用户展示 CHANGELOG 草稿内容，确认后再写入全部文件
- 中英文文档结构和内容必须对齐
- 版本号中提到的依赖版本（如 Codex vX.Y.Z）需确认是最新的
