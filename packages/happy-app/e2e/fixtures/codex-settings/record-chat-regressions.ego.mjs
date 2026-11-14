import fs from 'node:fs/promises';
import path from 'node:path';

// Capture only this owned Ego Page into fresh private frame files. The current
// Ego Page API rejects screencast frame ACK's genuine sessionId parameter, so
// use bounded page captures rather than bypassing its routing checks.
export async function recordEgoPage(page, directory) {
    await fs.mkdir(directory, { recursive: true });
    const frames = [];
    let active = true, captureError;
    const pump = (async () => {
        while (active) {
            const timestamp = Date.now() / 1000;
            const frame = await page.cdp('Page.captureScreenshot', { format: 'jpeg', quality: 85, captureBeyondViewport: false });
            const name = `frame-${String(frames.length).padStart(6, '0')}.jpg`;
            await fs.writeFile(path.join(directory, name), Buffer.from(frame.data, 'base64'));
            frames.push({ name, timestamp });
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    })().catch(error => { captureError = error; active = false; });
    return async () => {
        active = false; await pump;
        if (captureError) throw captureError;
        await fs.writeFile(path.join(directory, 'frames.json'), JSON.stringify(frames, null, 2));
        if (!frames.length) throw new Error('No owned Page frames received');
        const concat = frames.map((frame, index) => `file '${frame.name}'\nduration ${Math.max(1 / 30, Math.min(5, (frames[index + 1]?.timestamp ?? frame.timestamp + 1) - frame.timestamp))}`).join('\n');
        await fs.writeFile(path.join(directory, 'frames.txt'), `${concat}\nfile '${frames.at(-1).name}'\n`);
        return { directory, frames: frames.length, duration: frames.at(-1).timestamp - frames[0].timestamp };
    };
}
