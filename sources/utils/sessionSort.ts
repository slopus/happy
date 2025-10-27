import { Session } from '@/sync/storageTypes';

/**
 * 会话优先级权重
 * 数字越大优先级越高
 */
const PRIORITY_WEIGHTS = {
    HAS_PERMISSION_REQUEST: 1000,  // 最高优先级：需要人介入操作
    WAITING_FOR_INPUT: 500,        // 高优先级：需要人输入命令
    ACTIVE_THINKING: 100,          // 中优先级：正在工作
    COMPLETED_OFFLINE: 0,          // 低优先级：已完成/离线
};

/**
 * 计算会话的优先级分数
 *
 * 优先级判断逻辑：
 * 1. 有权限请求（需要人介入） - 最高优先级
 * 2. 等待用户输入 - 高优先级
 * 3. 正在工作（thinking） - 中优先级
 * 4. 已完成/离线 - 低优先级
 *
 * @param session - 会话对象
 * @returns 优先级分数（越大越优先）
 */
export function getSessionPriority(session: Session): number {
    // 1. 检查是否有权限请求（需要人介入操作）
    if (session.agentState?.requests) {
        const requestsCount = Object.keys(session.agentState.requests).length;
        if (requestsCount > 0) {
            return PRIORITY_WEIGHTS.HAS_PERMISSION_REQUEST;
        }
    }

    // 2. 检查是否为在线会话
    if (session.presence !== 'online') {
        // 离线会话 - 低优先级
        return PRIORITY_WEIGHTS.COMPLETED_OFFLINE;
    }

    // 3. 检查 thinking 状态（正在工作）
    if (session.thinking) {
        return PRIORITY_WEIGHTS.ACTIVE_THINKING;
    }

    // 4. 在线但未 thinking - 等待输入
    // 这表示 Claude 已经完成思考，等待用户输入命令
    return PRIORITY_WEIGHTS.WAITING_FOR_INPUT;
}

/**
 * 按智能优先级排序会话列表
 *
 * 排序规则：
 * 1. 首先按优先级分数排序（高 → 低）
 * 2. 优先级相同时，按最近更新时间排序（新 → 旧）
 *
 * @param sessions - 会话数组
 * @returns 排序后的会话数组
 */
export function sortSessionsByPriority(sessions: Session[]): Session[] {
    return [...sessions].sort((a, b) => {
        // 首先按优先级排序
        const priorityDiff = getSessionPriority(b) - getSessionPriority(a);
        if (priorityDiff !== 0) {
            return priorityDiff;
        }

        // 优先级相同时，按最近更新时间排序
        return b.updatedAt - a.updatedAt;
    });
}

/**
 * 获取会话的优先级描述（用于调试和 UI 显示）
 *
 * @param session - 会话对象
 * @returns 优先级描述字符串
 */
export function getSessionPriorityLabel(session: Session): string {
    const priority = getSessionPriority(session);

    if (priority === PRIORITY_WEIGHTS.HAS_PERMISSION_REQUEST) {
        return 'Requires Action';
    }
    if (priority === PRIORITY_WEIGHTS.WAITING_FOR_INPUT) {
        return 'Waiting for Input';
    }
    if (priority === PRIORITY_WEIGHTS.ACTIVE_THINKING) {
        return 'Active';
    }
    return 'Offline';
}

/**
 * 检查会话是否需要用户关注
 * 用于 UI 高亮显示
 *
 * @param session - 会话对象
 * @returns 是否需要关注
 */
export function sessionNeedsAttention(session: Session): boolean {
    const priority = getSessionPriority(session);
    return priority >= PRIORITY_WEIGHTS.WAITING_FOR_INPUT;
}
