import * as React from 'react';
import { act } from 'react';
// @ts-expect-error no renderer declarations
import TestRenderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GlobalSessionEntry, ProjectSessionMonitor, ProjectSessionSummary, ProjectTaskSessions } from './ProjectSessionMonitor.web';
const mocks = vi.hoisted(() => ({ state: {} as any, push: vi.fn(), listeners: new Map<string, Function>(), deleted: new Set<string>(), deletedReads: [] as string[] }));
vi.mock('react-native', () => ({ Modal: 'Modal', Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', TextInput: 'TextInput', View: 'View', useWindowDimensions: () => ({ width: 1600, height: 900 }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/text', () => ({ t: (k: string) => k, getCurrentLanguage: () => 'zh-Hans' }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/sync/storage', () => ({ storage: (selector: any) => selector(mocks.state) }));
vi.mock('@/sync/projectSessionLinks', () => ({ subscribeProjectSessionDeletions: () => () => {}, getProjectSessionDeletionRevision: () => 0, isProjectSessionDeleted: (id: string) => { mocks.deletedReads.push(id); return mocks.deleted.has(id); } }));
vi.mock('../goalBoard/GoalBoardButton', () => ({ GoalBoardButton: React.forwardRef((props: any, ref: any) => React.createElement('Button', { ...props, ref })) }));
vi.mock('react-native-unistyles', () => { const colors = new Proxy({ status: {}, permission: {}, shadow: {}, input: {} }, { get: (o: any, k) => o[k] ?? String(k) }); const theme = { colors }; return { useUnistyles: () => ({ theme }), StyleSheet: { absoluteFillObject: {}, hairlineWidth: 1, create: (f: any) => f(theme) } }; });
let renderer: any;
function app(){return <ProjectSessionMonitor knownScopes={[{machineId: 'm1', path: '/archive/project-a', title: 'Design Library'}]} scope={{ machineId: 'm1', path: '/p', title: '当前项目' }}><GlobalSessionEntry /><ProjectSessionSummary /></ProjectSessionMonitor>}
function press(id: string){act(()=>renderer.root.findAllByType('Button').find((n:any)=>n.props.testID===id).props.onPress())}
function items(){return renderer.root.findAllByType('View').filter((n:any)=>n.props.testID?.startsWith('session-activity-row-'))}
beforeEach(()=>{(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;mocks.push.mockClear();mocks.deleted.clear();mocks.listeners.clear();vi.stubGlobal('window',{addEventListener:(k:string,fn:Function)=>mocks.listeners.set(k,fn),removeEventListener:(k:string)=>mocks.listeners.delete(k)});mocks.state={socketStatus:'connected',unreadSessionIds:new Set(['done']),machines:{},sessions:{one:{id:'one',updatedAt:1,presence:'online',thinking:true,metadata:{machineId:'m1',path:'/p/t1'},agentState:{}},two:{id:'two',updatedAt:2,presence:'online',thinking:true,metadata:{machineId:'m2',path:'/other'},agentState:{}},done:{id:'done',updatedAt:3,presence:'online',thinking:false,metadata:{machineId:'m1',path:'/p/t2'},agentState:{turnStatus:{status:'completed',updatedAt:3}}}}};act(()=>{renderer=TestRenderer.create(app(),{createNodeMock:()=>({focus:vi.fn()})})})});
afterEach(()=>{act(()=>renderer.unmount());vi.unstubAllGlobals()});
describe('project session monitor',()=>{
    it('searches full explicit project bindings and available catalogue names',()=>{
        mocks.state={...mocks.state,sessions:{bound:{id:'bound',presence:'online',thinking:true,updatedAt:1,metadata:{machineId:'m1',path:'/code',goalBoard:{featurePath:'/archive/project-a/features/shared',taskId:'t'}},agentState:{}}}};
        act(()=>renderer.update(app()));press('global-session-entry');press('session-activity-tab-running');
        act(()=>renderer.root.findByType('TextInput').props.onChangeText('project-a'));expect(items()).toHaveLength(1);
        act(()=>renderer.root.findByType('TextInput').props.onChangeText('Design Library'));expect(items()).toHaveLength(1);
    });
    it('checks durable deletion markers only for activity candidates, even when closed',()=>{
        mocks.deletedReads=[];const idle=Object.fromEntries(Array.from({length:200},(_,i)=>['idle'+i,{id:'idle'+i,presence:'online',thinking:false,updatedAt:1,agentState:{},metadata:{path:'/idle'}}]));
        mocks.state={...mocks.state,sessions:{...mocks.state.sessions,...idle}};act(()=>renderer.update(app()));
        expect(new Set(mocks.deletedReads)).toEqual(new Set(['one','two','done']));expect(mocks.deletedReads).toHaveLength(3);
    });
    it('preserves disabled offline fallback while allowing inspection of known offline task activity',()=>{
        const fallback=vi.fn();const task={id:'t1',title:'task',indexPath:'/p/t1/index.md'} as any;
        act(()=>renderer.update(<ProjectSessionMonitor scope={{machineId:'m1',path:'/p',title:'P'}}><ProjectTaskSessions task={task} machineId="m1" featurePath="/p" onFallback={fallback} offline /></ProjectSessionMonitor>));
        expect(renderer.root.findAllByType('Button').find((n:any)=>n.props.testID==='project-task-chat-t1').props.disabled).not.toBe(true);
        press('project-task-chat-t1');expect(items()).toHaveLength(1);expect(fallback).not.toHaveBeenCalled();
        mocks.state={...mocks.state,sessions:{}};act(()=>renderer.update(<ProjectSessionMonitor><ProjectTaskSessions task={task} machineId="m1" featurePath="/p" onFallback={fallback} offline /></ProjectSessionMonitor>));
        expect(renderer.root.findAllByType('Button').find((n:any)=>n.props.testID==='project-task-chat-t1').props.disabled).toBe(true);
    });
    it('opens global work, filters to the current project, searches and closes without navigating',()=>{press('global-session-entry');press('session-activity-tab-running');expect(items()).toHaveLength(2);press('session-activity-scope-project');expect(items()).toHaveLength(1);act(()=>renderer.root.findByType('TextInput').props.onChangeText('不存在'));expect(items()).toHaveLength(0);act(()=>renderer.root.findByType('Modal').props.onRequestClose());expect(renderer.root.findAllByType('Modal')).toHaveLength(0);expect(mocks.push).not.toHaveBeenCalled()});
    it('opens exactly the chosen real session without clearing unread itself',()=>{press('project-session-unread');press('session-activity-open-done');expect(mocks.push).toHaveBeenCalledExactlyOnceWith('/session/done');expect(mocks.state.unreadSessionIds.has('done')).toBe(true);expect(renderer.root.findAllByType('Modal')).toHaveLength(0)});
    it('subscribes to state changes, hides deletions and treats socket loss as unknown',()=>{press('global-session-entry');press('session-activity-tab-running');mocks.state={...mocks.state,socketStatus:'disconnected'};act(()=>renderer.update(app()));expect(items()).toHaveLength(0);press('session-activity-tab-unknown');expect(items()).toHaveLength(2);mocks.deleted.add('one');mocks.state={...mocks.state,sessions:{...mocks.state.sessions}};act(()=>renderer.update(app()));expect(items()).toHaveLength(1)});
    it('cleans Escape handling on close and can close again after reopening',()=>{press('global-session-entry');act(()=>mocks.listeners.get('keydown')?.({key:'Escape',preventDefault:vi.fn(),stopImmediatePropagation:vi.fn()}));expect(renderer.root.findAllByType('Modal')).toHaveLength(0);expect(mocks.listeners.has('keydown')).toBe(false);press('global-session-entry');expect(mocks.listeners.has('keydown')).toBe(true);press('session-activity-close');expect(mocks.listeners.has('keydown')).toBe(false)});
});
