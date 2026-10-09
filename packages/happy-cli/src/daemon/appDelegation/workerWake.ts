/** A hint only: claims still authenticate and lease work under the machine lock.
 * Coalesce bursts and retain a wake that races with the end of a claim. */
export function createWorkerWake(signal: AbortSignal) {
 let pending=false, waiting:(()=>void)|undefined;
 return {
  notify(){pending=true;waiting?.();},
  async wait(ms=1000):Promise<void>{
   if(signal.aborted)return;
   if(pending){pending=false;return;}
   await new Promise<void>(resolve=>{
    const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);waiting=undefined;pending=false;resolve();};
    const timer=setTimeout(done,ms);waiting=done;
    signal.addEventListener('abort',done,{once:true});
    if(signal.aborted||pending)done();
   });
  },
 };
}
