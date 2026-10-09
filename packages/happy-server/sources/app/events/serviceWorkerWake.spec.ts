import {it,expect,vi} from 'vitest';
import {eventRouter} from './eventRouter';
it('work hints go exclusively to the authorized owner and selected machine room',()=>{
 const emit=vi.fn(),to=vi.fn(()=>({emit}));eventRouter.init({to} as any);
 eventRouter.emitEphemeral({userId:'owner-a',recipientFilter:{type:'machine-only',machineId:'machine-a'},payload:{type:'ai-service-work-available',machineId:'machine-a'}});
 expect(to).toHaveBeenCalledWith(['user:owner-a:machine:machine-a']);
 expect(emit).toHaveBeenCalledWith('ephemeral',{type:'ai-service-work-available',machineId:'machine-a'});
});
