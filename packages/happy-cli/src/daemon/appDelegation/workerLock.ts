import { createHash } from 'node:crypto';
import { createServer } from 'node:net';

export function processAlive(pid: number): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 0) return true;
    try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
// The kernel releases this lock on process death. Port collisions fail closed.
export async function acquireMachineLock(machineId: string, onLost: () => void): Promise<(() => Promise<void>) | null> {
    const port = 40000 + createHash('sha256').update(machineId).digest().readUInt16BE(0) % 20000;
    const server = createServer(socket => socket.destroy());
    return new Promise(resolve => {
        let acquired = false;
        server.once('error', () => { if (acquired) onLost(); resolve(null); });
        server.once('close', () => { if (acquired) onLost(); });
        server.listen({ host: '127.0.0.1', port, exclusive: true }, () => { acquired = true; resolve(() => new Promise<void>(done => server.close(() => done()))); });
    });
}
