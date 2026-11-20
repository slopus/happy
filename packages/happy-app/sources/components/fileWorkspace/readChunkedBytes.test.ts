import { expect, it, vi } from 'vitest';
import { readChunkedBytes } from './readChunkedBytes';
it('assembles media bytes through bounded ranges without a whole-file response', async () => {
 const source=new Uint8Array(700000).fill(37);const read=vi.fn(async(offset:number,length:number)=>({success:true,content:Buffer.from(source.subarray(offset,offset+length)).toString('base64'),offset,totalSize:source.length,revision:'same'}));
 expect(await readChunkedBytes(read)).toEqual(source);expect(read).toHaveBeenCalledTimes(3);
 expect(read.mock.calls.every(([,length])=>length<=256*1024)).toBe(true);
});
it('rejects changed files, oversized files and cancellation before dispatch', async () => {
 const huge=vi.fn(async()=>({success:true,content:'',offset:0,totalSize:20*1024*1024,revision:'same'}));await expect(readChunkedBytes(huge)).rejects.toThrow();
 const changed=vi.fn(async(offset:number)=>({success:true,content:Buffer.alloc(256*1024).toString('base64'),offset,totalSize:700000,revision:offset?'changed':'same'}));await expect(readChunkedBytes(changed)).rejects.toThrow();
 const abort=new AbortController();abort.abort();const read=vi.fn();await expect(readChunkedBytes(read,abort.signal)).rejects.toThrow();expect(read).not.toHaveBeenCalled();
});
