import * as React from 'react';
import {act} from 'react';
import {expect,it,vi} from 'vitest';
// @ts-expect-error renderer declarations are not present in the workspace.
import TestRenderer from 'react-test-renderer';
vi.mock('@/sync/storage',()=>({storage:{getState:()=>({settings:{agentDefaultOverrides:{}}})}}));
vi.mock('@/sync/persistence',()=>({loadNewSessionDraft:()=>null,saveNewSessionDraft:vi.fn()}));
vi.mock('@/auth/accountRuntime',()=>({accountStorageId:(value:string)=>value}));
import {createNewSessionDraftStore,NewSessionDraftProvider,newSessionDraftSnapshot,useNewSessionDraft,useNewSessionDraftStore} from './useNewSessionDraft';
import {createComposeDraftStore,ComposeDraftProvider,useComposeDraft,useComposeDraftStore,useComposeDraftSelectionGeneration,composeDraftAttachmentSelectionGeneration} from '@/sync/composeDraft';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
it('keeps ordinary new-session text, attachments and explicit model choices outside the scoped role composer',()=>{
    useNewSessionDraft.getState().setMachineId('original');
    useNewSessionDraft.getState().setModelMode('gpt-6-astra');
    useNewSessionDraft.getState().setEffortLevel('ultra');
    useComposeDraft.getState().setText('Original unfinished question');
    const attachment={id:'keep-file',uri:'file://original',name:'source.txt'} as any;
    useComposeDraft.getState().setImages([attachment]);
    const config=createNewSessionDraftStore({...newSessionDraftSnapshot(useNewSessionDraft.getState()),selectedMachineId:'role-target'},vi.fn());
    const composer=createComposeDraftStore({text:'Create my role'},vi.fn());
    let observed:any;
    function Probe(){observed={config:useNewSessionDraft(),composer:useComposeDraft(),configStore:useNewSessionDraftStore(),composeStore:useComposeDraftStore(),generation:useComposeDraftSelectionGeneration()};return null;}
    let renderer:any;
    act(()=>{renderer=TestRenderer.create(<NewSessionDraftProvider store={config}><ComposeDraftProvider store={composer}><Probe/></ComposeDraftProvider></NewSessionDraftProvider>);});
    expect(observed.config.selectedMachineId).toBe('role-target');expect(observed.config.modelMode).toBe('gpt-6-astra');
    act(()=>{observed.composer.setText('Role-specific unfinished text');observed.config.setModelMode('gpt-6.1-sol');});
    expect(useComposeDraft.getState().text).toBe('Original unfinished question');expect(useComposeDraft.getState().images).toEqual([attachment]);
    expect(useNewSessionDraft.getState()).toMatchObject({selectedMachineId:'original',modelMode:'gpt-6-astra',effortLevel:'ultra'});
    expect(observed.composeStore.getState().text).toBe('Role-specific unfinished text');
    const originalEpoch=composeDraftAttachmentSelectionGeneration.currentDraftEpoch();observed.generation.invalidate();
    expect(composeDraftAttachmentSelectionGeneration.currentDraftEpoch()).toBe(originalEpoch);
    act(()=>renderer.unmount());
    act(()=>{renderer=TestRenderer.create(<Probe/>);});
    expect(observed.composer.text).toBe('Original unfinished question');expect(observed.config.selectedMachineId).toBe('original');
    act(()=>renderer.unmount());
});
