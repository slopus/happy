import {afterEach,expect,it,vi} from 'vitest';
import {createWorkerWake} from './workerWake';
afterEach(()=>vi.useRealTimers());
it('wakes immediately, coalesces bursts and retains hints racing with a claim',async()=>{
 vi.useFakeTimers();const control=new AbortController(),wake=createWorkerWake(control.signal);
 let finished=false;const idle=wake.wait().then(()=>{finished=true;});
 await vi.advanceTimersByTimeAsync(0);expect(finished).toBe(false);
 wake.notify();await idle;expect(finished).toBe(true);expect(vi.getTimerCount()).toBe(0);
 wake.notify();wake.notify();await wake.wait();
 finished=false;const fallback=wake.wait().then(()=>{finished=true;});
 await vi.advanceTimersByTimeAsync(999);expect(finished).toBe(false);
 await vi.advanceTimersByTimeAsync(1);await fallback;expect(finished).toBe(true);
});
it('shutdown clears idle timer and abort listener',async()=>{
 vi.useFakeTimers();const control=new AbortController(),wake=createWorkerWake(control.signal);
 const idle=wake.wait();control.abort();await idle;expect(vi.getTimerCount()).toBe(0);await wake.wait();
});
