# Task 005: 使用指南 - 系统通知改进

## 概述

Task 005 已经完成基础实现，创建了一个改进的通知系统，可以显示具体的会话信息和状态。

## 已完成的工作

### 1. 核心模块

#### `sources/services/notificationContent.ts`
- `getSessionDisplayName(session)` - 获取会话的显示名称
- `generateNotificationContent(params)` - 生成具体的通知内容
- 支持4种通知类型：permission, input, completion, error

#### `sources/services/notificationManager.ts`
- `sendSessionNotification(session, type, options)` - 发送通知
- `notifyPermissionRequired(session, permissionName, reason?)` - 权限请求通知
- `notifyInputRequired(session, message?)` - 等待输入通知
- `notifyTaskCompleted(session, message?)` - 任务完成通知
- `notifyError(session, errorMessage?)` - 错误通知
- `requestNotificationPermissions()` - 请求通知权限

### 2. 翻译支持

所有7种语言的翻译已添加到 `sources/text/` 目录：
- English (en)
- Russian (ru)
- Polish (pl)
- Spanish (es)
- Catalan (ca)
- Portuguese (pt)
- Chinese Simplified (zh-Hans)

### 3. 测试

- `sources/services/notificationContent.test.ts` - 完整的单元测试覆盖

## 如何集成到项目中

### Step 1: 初始化通知权限

在应用启动时请求通知权限：

```typescript
// 在 App.tsx 或主组件中
import { requestNotificationPermissions } from '@/services/notificationManager';

useEffect(() => {
    // 请求通知权限
    requestNotificationPermissions();
}, []);
```

### Step 2: 在会话状态变化时发送通知

#### 场景 1: 权限请求

当会话需要权限时：

```typescript
import { notifyPermissionRequired } from '@/services/notificationManager';

// 在处理权限请求的代码中
if (session.agentState?.requests) {
    const requests = Object.values(session.agentState.requests);
    if (requests.length > 0) {
        const request = requests[0];
        await notifyPermissionRequired(
            session,
            request.tool, // 权限名称
            'read configuration files' // 可选：原因
        );
    }
}
```

#### 场景 2: 等待用户输入

当AI完成任务等待下一步指令时：

```typescript
import { notifyInputRequired } from '@/services/notificationManager';

// 当thinking变为false且没有pending requests时
if (!session.thinking && session.presence === 'online') {
    await notifyInputRequired(
        session,
        'AI has completed data cleaning' // 可选：自定义消息
    );
}
```

#### 场景 3: 任务完成

当任务成功完成时：

```typescript
import { notifyTaskCompleted } from '@/services/notificationManager';

await notifyTaskCompleted(
    session,
    'Refactored 10 files successfully'
);
```

#### 场景 4: 错误发生

当出现错误时：

```typescript
import { notifyError } from '@/services/notificationManager';

await notifyError(
    session,
    'Network connection failed'
);
```

### Step 3: 集成建议位置

#### 在 `sources/sync/reducer/reducer.ts` 中

这是处理会话状态更新的核心文件。可以在以下位置添加通知逻辑：

```typescript
// 伪代码示例
import { notifyPermissionRequired, notifyInputRequired } from '@/services/notificationManager';

function handleStateChange(session: Session, previousState: Session) {
    // 检测新的权限请求
    const newRequests = detectNewRequests(session, previousState);
    if (newRequests.length > 0) {
        notifyPermissionRequired(session, newRequests[0].tool);
    }

    // 检测thinking状态变化
    if (previousState.thinking && !session.thinking) {
        // AI完成思考，等待用户输入
        if (!hasPermissionRequests(session)) {
            notifyInputRequired(session);
        }
    }
}
```

#### 在 `sources/sync/storage.ts` 中

可以在会话列表更新时检测状态变化并发送通知。

## 通知示例

### 权限请求
```
标题："网页开发项目" needs permission
内容：Needs file_system permission: read configuration files
```

### 等待输入
```
标题："数据分析" waiting for input
内容：AI已完成数据清洗，等待下一步指令
```

### 任务完成
```
标题："代码重构" completed
内容：已重构10个文件，准备好继续下一步
```

### 错误
```
标题："API集成" encountered error
内容：网络连接失败，请检查网络设置
```

## 注意事项

1. **通知只在后台发送**
   - 当应用在前台时，通知会被跳过
   - 这避免了用户正在使用应用时的干扰

2. **会话名称优先级**
   - 优先使用 `session.metadata.name`
   - 其次使用 `session.metadata.summary.text`（前30字符）
   - 最后使用 `session.id`（前8字符）

3. **标题长度限制**
   - 会话名称会被截断到20字符（加...）
   - 确保通知在各种设备上正常显示

4. **多语言支持**
   - 通知会自动使用用户的语言设置
   - 所有7种语言都已完整翻译

## 下一步工作

要完全集成此功能，需要：

1. **在sync reducer中添加状态检测逻辑**
   - 检测权限请求的添加
   - 检测thinking状态的变化
   - 检测错误的发生

2. **测试实际设备通知**
   - 在iOS和Android上测试通知显示
   - 验证通知点击后的应用跳转行为

3. **可选：添加通知点击处理**
   - 当用户点击通知时，打开对应的会话
   - 可以在 `notificationManager.ts` 中添加listener

## 文件清单

**新增文件：**
- `sources/services/notificationContent.ts` (120行)
- `sources/services/notificationContent.test.ts` (220行)
- `sources/services/notificationManager.ts` (157行)
- `tasks/005-USAGE.md` (本文档)

**修改文件：**
- `sources/text/_default.ts` - 添加notifications翻译
- `sources/text/translations/ru.ts` - 添加notifications翻译
- `sources/text/translations/pl.ts` - 添加notifications翻译
- `sources/text/translations/es.ts` - 添加notifications翻译
- `sources/text/translations/ca.ts` - 添加notifications翻译
- `sources/text/translations/pt.ts` - 添加notifications翻译
- `sources/text/translations/zh-Hans.ts` - 添加notifications翻译

## 总结

Task 005的基础实现已经完成，提供了：
- ✅ 完整的通知内容生成系统
- ✅ 会话名称智能显示
- ✅ 7种语言的完整翻译
- ✅ 4种通知类型（权限、输入、完成、错误）
- ✅ 单元测试覆盖
- ✅ TypeScript类型安全

还需要集成到实际的会话状态管理流程中才能完全生效。
