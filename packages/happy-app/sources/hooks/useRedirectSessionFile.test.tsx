import * as React from 'react';
import { act } from 'react';
// @ts-expect-error react-test-renderer has no declarations.
import TestRenderer from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
const state=vi.hoisted(()=>({desktop:true,web:true,root:'/work',navigate:vi.fn()}));
vi.mock('react-native',()=>({Platform:{get OS(){return state.web?'web':'android';}},useWindowDimensions:()=>({width:1400})}));
vi.mock('expo-router',()=>({useRouter:()=>({navigate:state.navigate})}));
vi.mock('@/sync/storage',()=>({useSession:()=>({metadata:{path:state.root}})}));
vi.mock('@/hooks/useDesktopWorkspaceLayout',()=>({useDesktopWorkspaceLayout:()=>({enabled:state.desktop,rightPanelAvailable:false})}));
import {useRedirectSessionFile} from './useRedirectSessionFile';
let redirect=false;
function Probe({path='/work/PRIVACY.md',positioned=false}:{path?:string;positioned?:boolean}){redirect=useRedirectSessionFile('s',path,positioned);return null;}
beforeEach(()=>{(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;state.desktop=true;state.web=true;state.root='/work';state.navigate.mockClear();});
it('redirects an old desktop file URL back to its conversation with a selected tab',()=>{
 let renderer:any;act(()=>{renderer=TestRenderer.create(<Probe/>);});
 expect(redirect).toBe(true);expect(state.navigate.mock.calls[0][0].params.id).toBe('s');
 act(()=>renderer.update(<Probe/>));expect(state.navigate).toHaveBeenCalledTimes(1);act(()=>renderer.unmount());
});
it.each([{path:'/outside/a.md'},{positioned:true}])('preserves legacy behavior outside the project or for positioned links: %o',props=>{
 let renderer:any;act(()=>{renderer=TestRenderer.create(<Probe {...props}/>);});
 expect(redirect).toBe(false);expect(state.navigate).not.toHaveBeenCalled();act(()=>renderer.unmount());
});
it('waits for root metadata and only redirects when desktop layout is available',()=>{
 state.root='';let renderer:any;act(()=>{renderer=TestRenderer.create(<Probe/>);});expect(redirect).toBe(false);
 state.root='/work';act(()=>renderer.update(<Probe/>));expect(redirect).toBe(true);
 state.desktop=false;act(()=>renderer.update(<Probe/>));expect(redirect).toBe(false);act(()=>renderer.unmount());
});
it('keeps the native file screen',()=>{
 state.web=false;let renderer:any;act(()=>{renderer=TestRenderer.create(<Probe/>);});expect(redirect).toBe(false);expect(state.navigate).not.toHaveBeenCalled();act(()=>renderer.unmount());
});
