import React from 'react';
import { act } from 'react';
import { describe,it,expect,vi } from 'vitest';
// @ts-expect-error renderer types
import TestRenderer from 'react-test-renderer';
import { useSessionAttachmentDraft } from './useSessionAttachmentDraft.web';
vi.mock('@/auth/accountRuntime',()=>({getActiveAccountKey:()=> 'test-account'}));
it('keeps source attachments after leaving and returning to a session',()=>{let value:any;let renderer:any;function Harness(){value=useSessionAttachmentDraft('unique-source');return null;}act(()=>{renderer=TestRenderer.create(<Harness/>);});const image:any={id:'image',uri:'blob:test',kind:'image'};act(()=>value.setImages([image]));act(()=>renderer.unmount());act(()=>{renderer=TestRenderer.create(<Harness/>);});expect(value.images).toEqual([image]);act(()=>renderer.unmount());});
