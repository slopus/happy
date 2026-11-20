import * as React from 'react';
import { act } from 'react';
// @ts-expect-error react-test-renderer has no declarations.
import TestRenderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyGoalReview, readGoalReview, type GoalTask } from '@slopus/happy-wire';
import { ProjectTaskProgress } from './ProjectTaskProgress';
import { ProjectRetrospective } from './ProjectRetrospective';
const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), request: vi.fn(), account: { key: 'one', generation: 1 } as any }));
vi.mock('react-native', () => ({ Modal: 'Modal', ScrollView: 'ScrollView', Text: 'Text', View: 'View', TextInput: 'TextInput', ActivityIndicator: 'Loading', useWindowDimensions: () => ({ width: 1500, height: 900 }) }));
vi.mock('react-native-unistyles', () => { const theme = { colors: { text: 'text', textSecondary: 'secondary', textLink: 'link', surface: 'surface', divider: 'divider', success: 'success', input: {}, modal: {} } }; return { StyleSheet: { create: (fn: any) => fn(theme) }, useUnistyles: () => ({ theme }) }; });
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/hooks/useProjectModalEscape', () => ({ useProjectModalEscape: vi.fn() }));
vi.mock('@/auth/accountRuntime', () => ({ getRuntimeAccountSelection: () => mocks.account, accountRuntimeCurrent: () => true }));
vi.mock('@/sync/projectGoals', () => ({ projectTaskFiles: () => ({ readText: mocks.read, writeText: mocks.write }), isReadOnlyProjectPreview: () => false, projectGoalRequest: mocks.request, taskApproval: () => 'noDeliverables' }));
vi.mock('./GoalBoardButton', () => ({ GoalBoardButton: React.forwardRef((props: any, ref: any) => React.createElement('Button', { ...props, ref })) }));
vi.mock('./ProjectTaskStatus', () => ({ ProjectTaskStatus: (props: any) => React.createElement('Status', props) }));
let renderer: any, source: string, hash: string;
const task = { id: 'GFT-abcdefgh', title: 'Video', indexPath: '/feature/tasks/01/index.md', status: 'pending', goal: 'Make a video', dependencies: [], expectedDeliverables: [], artifacts: [] } as GoalTask;
const other = { ...task, id: 'GFT-ijklmnop', title: 'Icon', indexPath: '/feature/tasks/02/index.md' };
beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    source = '---\nstatus: pending\ntask_id: GFT-abcdefgh\n---\n# Video\nOriginal note'; hash = 'one';
    mocks.account = { key: 'one', generation: 1 }; mocks.read.mockReset(); mocks.write.mockReset(); mocks.request.mockReset();
    mocks.read.mockImplementation(async () => ({ content: source, hash }));
    mocks.write.mockImplementation(async (_path, content, expectedHash) => { if (hash !== expectedHash) throw new Error('File conflict'); source = content; hash += 'x'; return { hash }; });
    mocks.request.mockResolvedValue({ success: true, snapshot: { featurePath: '/feature', title: 'Project', revision: 'r', updatedAt: 1, tasks: [{ ...task, review: { ...emptyGoalReview(), summary: 'Automatic details', evidence: ['report.md'], decisions: [{ id: 'cut', question: 'Which cut?', recommendation: 'Use v3' }], gaps: ['Missing device test'] } }, other], warnings: [] } });
});
afterEach(() => { if (renderer) act(() => renderer.unmount()); });
const button = (id: string) => renderer.root.findAllByType('Button').find((node: any) => node.props.testID === id);
async function press(id: string) { await act(async () => { await button(id).props.onPress(); }); }
async function mount(node: React.ReactNode) { await act(async () => { renderer = TestRenderer.create(node); }); }
describe('manual progress and retrospective interaction', () => {
    it('saves progress independently from recognition and undoes it without losing notes', async () => {
        await mount(<ProjectTaskProgress machineId="m" featurePath="/feature" task={task} onSaved={async () => {}} />);
        await press('project-task-progress-GFT-abcdefgh'); await press('project-progress-option-done'); await press('project-progress-save');
        expect(source).toContain('status: done'); expect(source).toContain('Original note');
        expect(readGoalReview(source)?.recognitions).toEqual([]);
        expect(readGoalReview(source)?.statusChanges[0].actor).toBe('user');
        await press('project-progress-undo');
        expect(source).toContain('status: pending'); expect(readGoalReview(source)?.statusChanges[0].revertedAt).toBeTypeOf('number');
    });
    it('shows a conflict instead of overwriting a newer file', async () => {
        await mount(<ProjectTaskProgress machineId="m" featurePath="/feature" task={task} />);
        await press('project-task-progress-GFT-abcdefgh'); await press('project-progress-option-done');
        source += '\nLater note'; hash = 'changed'; await press('project-progress-save');
        expect(source).toContain('status: pending'); expect(source).toContain('Later note');
        expect(JSON.stringify(renderer.toJSON())).toContain('File conflict');
    });
    it('puts decisions first, hides automatic details and sends exactly selected tasks', async () => {
        const start = vi.fn(async (_tasks: unknown) => {});
        await mount(<ProjectRetrospective machineId="m" featurePaths={['/feature']} onClose={() => {}} onStart={start} onOpenTask={() => {}} onSaved={async () => {}} />);
        expect(JSON.stringify(renderer.toJSON())).toContain('Which cut?');
        expect(JSON.stringify(renderer.toJSON())).not.toContain('Automatic details');
        await press('project-review-details-toggle'); expect(JSON.stringify(renderer.toJSON())).toContain('Automatic details');
        await press('project-review-select-GFT-abcdefgh'); await press('project-review-start');
        expect(start).toHaveBeenCalledOnce(); expect(start.mock.calls[0][0]).toEqual([{ featurePath: '/feature', task: other }]);
    });
    it('records an answer in the original task and does not mark it done or accepted', async () => {
        const { writeGoalReview } = await import('@slopus/happy-wire');
        source = writeGoalReview(source, { ...emptyGoalReview(), summary: 'Automatic details', evidence: ['report.md'], decisions: [{ id: 'cut', question: 'Which cut?', recommendation: 'Use v3' }], gaps: ['Missing device test'] });
        await mount(<ProjectRetrospective machineId="m" featurePaths={['/feature']} onClose={() => {}} onStart={async () => {}} onOpenTask={() => {}} onSaved={async () => {}} />);
        await act(async () => { renderer.root.findByType('TextInput').props.onChangeText('Use v3'); });
        await act(async () => { await renderer.root.findAllByType('Button').find((n: any) => n.props.label === 'projectGoals.recordDecision').props.onPress(); });
        expect(readGoalReview(source)?.decisions[0].answer).toBe('Use v3');
        expect(readGoalReview(source)?.recognitions).toEqual([]); expect(source).toContain('status: pending');
    });
});
