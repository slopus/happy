/**
 * Mock Data Module
 *
 * Provides fake sessions, machines, and agent configs for UI testing.
 * Activate via URL param on web: ?mock=multipleProjects
 */

export {
    createMockSession,
    createMockMachine,
    createMockAgentConfig,
    createUserMessage,
    createAgentMessage,
    createToolCall,
    createToolResult,
    createThinkingMessage,
} from './factory';
export { MockDataProvider } from './MockDataProvider';
export { getFixture, FIXTURES } from './fixtures';
export type { MockFixture, FixtureName } from './fixtures';
