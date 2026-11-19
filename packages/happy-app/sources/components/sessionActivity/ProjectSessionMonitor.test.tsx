import * as React from 'react';
import { act } from 'react';
// @ts-expect-error no renderer declarations
import TestRenderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GlobalSessionRailEntry, GlobalSessionEntry, ProjectSessionMonitor, ProjectSessionSummary, ProjectTaskSessions } from './ProjectSessionMonitor.web';
const Button = 'Button' as any;
const mocks = vi.hoisted(() => ({ state: {} as any, push: vi.fn(), listeners: new Map<string, Function>(), deleted: new Set<string>(), deletedReads: [] as string[] }));
vi.mock('react-dom', () => ({ createPortal: (children: any) => children }));
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
function panels(){return renderer.root.findAllByType('View').filter((n:any)=>n.props.testID==='session-activity-panel')}
function items(){return renderer.root.findAllByType('View').filter((n:any)=>n.props.testID?.startsWith('session-activity-row-'))}
beforeEach(()=>{(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;mocks.push.mockClear();mocks.deleted.clear();mocks.listeners.clear();vi.stubGlobal('window',{addEventListener:(k:string,fn:Function)=>mocks.listeners.set(k,fn),removeEventListener:(k:string)=>mocks.listeners.delete(k)});vi.stubGlobal('document', { body: {}, activeElement: null });mocks.state={socketStatus:'connected',unreadSessionIds:new Set(['done']),machines:{},sessions:{one:{id:'one',updatedAt:1,presence:'online',thinking:true,metadata:{machineId:'m1',path:'/p/t1'},agentState:{}},two:{id:'two',updatedAt:2,presence:'online',thinking:true,metadata:{machineId:'m2',path:'/other'},agentState:{}},done:{id:'done',updatedAt:3,presence:'online',thinking:false,metadata:{machineId:'m1',path:'/p/t2'},agentState:{turnStatus:{status:'completed',updatedAt:3}}}}};act(()=>{renderer=TestRenderer.create(app(),{createNodeMock:()=>({focus:vi.fn(),contains:(target:any)=>target==='inside-panel'})})})});
afterEach(()=>{act(()=>renderer.unmount());vi.unstubAllGlobals()});
describe('project session monitor',()=>{
    it('toggles the rail ON badge, closes explicitly, and retains its position after reopening',()=>{
        const render = (props:any) => <Button {...props} testID="rail" />;
        act(()=>renderer.update(<ProjectSessionMonitor><GlobalSessionRailEntry render={render} /></ProjectSessionMonitor>));
        const rail=()=>renderer.root.findAllByType('Button').find((n:any)=>n.props.testID==='rail');
        expect(rail().props.badge).toBeUndefined();press('rail');expect(rail().props.badge).toBe('ON');
        const handle=renderer.root.findAllByType('View').find((n:any)=>n.props.testID==='session-activity-drag-handle');
        act(()=>handle.props.onPointerDown({button:0,pointerId:1,clientX:100,clientY:100,target:{closest:()=>null},currentTarget:{setPointerCapture:vi.fn()},preventDefault:vi.fn()}));
        act(()=>handle.props.onPointerMove({pointerId:1,clientX:300,clientY:250}));
        const position=panels()[0].props.style[1];expect(position.left).toBe(284);expect(position.top).toBe(222);
        act(()=>handle.props.onPointerUp());press('session-activity-close');expect(rail().props.badge).toBeUndefined();
        press('rail');expect(panels()[0].props.style[1].left).toBe(284);press('rail');expect(panels()).toHaveLength(0);
    });
    it('keeps the global panel open across project unmount and session navigation',()=>{
        const render=(props:any)=><Button {...props} testID="rail" />;
        const tree=(project:boolean)=><ProjectSessionMonitor><GlobalSessionRailEntry render={render} />{project && <ProjectSessionMonitor scope={{machineId:'m1',path:'/p',title:'P'}}><ProjectSessionSummary /></ProjectSessionMonitor>}</ProjectSessionMonitor>;
        act(()=>renderer.update(tree(true)));press('project-session-running');expect(items()).toHaveLength(1);
        press('session-activity-open-one');expect(panels()).toHaveLength(1);
        act(()=>renderer.update(tree(false)));expect(panels()).toHaveLength(1);expect(items()).toHaveLength(1);
    });
    it('labels a pinned project scope after switching projects and can clear it',()=>{
        const tree=(title:string,path:string)=><ProjectSessionMonitor><GlobalSessionEntry /><ProjectSessionMonitor scope={{machineId:'m1',path,title}}><ProjectSessionSummary /></ProjectSessionMonitor></ProjectSessionMonitor>;
        act(()=>renderer.update(tree('Project A','/p')));press('project-session-running');expect(items()).toHaveLength(1);
        act(()=>renderer.update(tree('Project B','/other')));
        const current=renderer.root.findAllByType('Button').find((n:any)=>n.props.testID==='session-activity-scope-project');
        expect(current.props.selected).toBe(false);expect(JSON.stringify(renderer.toJSON())).toContain('Project A');
        press('session-activity-scope-all');expect(items()).toHaveLength(2);
    });
    it('clamps dragging to the viewport and cancels on lost capture',()=>{
        press('global-session-entry');const handle=renderer.root.findAllByType('View').find((n:any)=>n.props.testID==='session-activity-drag-handle');
        act(()=>handle.props.onPointerDown({button:0,pointerId:2,clientX:0,clientY:0,target:{closest:()=>null},currentTarget:{setPointerCapture:vi.fn()},preventDefault:vi.fn()}));
        act(()=>handle.props.onPointerMove({pointerId:2,clientX:9000,clientY:-9000}));
        expect(panels()[0].props.style[1]).toMatchObject({left:1228,top:12});
        act(()=>handle.props.onLostPointerCapture());act(()=>handle.props.onPointerMove({pointerId:2,clientX:100,clientY:100}));
        expect(panels()[0].props.style[1]).toMatchObject({left:1228,top:12});
    });
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
    it('opens global work, filters to the current project, searches and closes without navigating',()=>{press('global-session-entry');press('session-activity-tab-running');expect(items()).toHaveLength(2);press('session-activity-scope-project');expect(items()).toHaveLength(1);act(()=>renderer.root.findByType('TextInput').props.onChangeText('不存在'));expect(items()).toHaveLength(0);press('session-activity-close');expect(panels()).toHaveLength(0);expect(mocks.push).not.toHaveBeenCalled()});
    it('opens exactly the chosen real session without clearing unread itself',()=>{press('project-session-unread');press('session-activity-open-done');expect(mocks.push).toHaveBeenCalledExactlyOnceWith('/session/done');expect(mocks.state.unreadSessionIds.has('done')).toBe(true);expect(panels()).toHaveLength(1)});
    it('subscribes to state changes, hides deletions and treats socket loss as unknown',()=>{press('global-session-entry');press('session-activity-tab-running');mocks.state={...mocks.state,socketStatus:'disconnected'};act(()=>renderer.update(app()));expect(items()).toHaveLength(0);press('session-activity-tab-unknown');expect(items()).toHaveLength(2);mocks.deleted.add('one');mocks.state={...mocks.state,sessions:{...mocks.state.sessions}};act(()=>renderer.update(app()));expect(items()).toHaveLength(1)});
    it('does not consume Escape from the underlying chat or other overlays',()=>{
        press('global-session-entry');const preventDefault=vi.fn(),stopImmediatePropagation=vi.fn();
        act(()=>mocks.listeners.get('keydown')?.({key:'Escape',target:'chat-input',preventDefault,stopImmediatePropagation}));
        expect(panels()).toHaveLength(1);expect(preventDefault).not.toHaveBeenCalled();expect(stopImmediatePropagation).not.toHaveBeenCalled();
    });
    it('cleans Escape handling on close and can close again after reopening',()=>{press('global-session-entry');act(()=>mocks.listeners.get('keydown')?.({key:'Escape',target:'inside-panel',preventDefault:vi.fn(),stopImmediatePropagation:vi.fn()}));expect(panels()).toHaveLength(0);expect(mocks.listeners.has('keydown')).toBe(false);press('global-session-entry');expect(mocks.listeners.has('keydown')).toBe(true);press('session-activity-close');expect(mocks.listeners.has('keydown')).toBe(false)});
});
