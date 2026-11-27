import { readProjectCanvasCommand, readProjectCanvasSceneResult, readProjectCanvasSync, type ProjectCanvasCommand,
    type ProjectCanvasFrameMessage, type ProjectCanvasSceneResult, type ProjectCanvasSync } from '../protocol';

let current: ProjectCanvasSync | undefined;
const listeners = new Set<() => void>();
const commandListeners = new Set<(command: ProjectCanvasCommand) => void>();
const sceneListeners = new Set<(result: ProjectCanvasSceneResult) => void>();

export function currentSync() {
    return current;
}

export function subscribeSync(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function subscribeCommand(listener: (command: ProjectCanvasCommand) => void): () => void {
    commandListeners.add(listener);
    return () => { commandListeners.delete(listener); };
}

export function subscribeSceneResult(listener: (result: ProjectCanvasSceneResult) => void): () => void {
    sceneListeners.add(listener);
    return () => { sceneListeners.delete(listener); };
}

export function postCanvasMessage(message: ProjectCanvasFrameMessage): void {
    if (window.parent !== window) window.parent.postMessage(message, window.location.origin);
}

export function startParentConnection(): void {
    window.addEventListener('message', event => {
        if (window.parent === window || event.source !== window.parent || event.origin !== window.location.origin) return;
        const command = readProjectCanvasCommand(event.data);
        if (command) {
            if (command.sessionKey !== current?.sessionKey) return;
            for (const listener of commandListeners) listener(command);
            return;
        }
        const sceneResult = readProjectCanvasSceneResult(event.data);
        if (sceneResult) {
            if (sceneResult.sessionKey !== current?.sessionKey) return;
            for (const listener of sceneListeners) listener(sceneResult);
            return;
        }
        const update = readProjectCanvasSync(event.data, event.origin);
        if (!update) return;
        if (current?.sessionKey === update.sessionKey && current.manifestRevision !== undefined
            && update.manifestRevision !== undefined && update.manifestRevision < current.manifestRevision) return;
        // The editor can attach after several URI-only syncs, or remount while
        // the iframe stays alive. Retain its authoritative scene until a new
        // scene arrives; a new canvas session starts with no retained state.
        current = !update.scene && current?.sessionKey === update.sessionKey && current.scene
            ? { ...update, scene: current.scene } : update;
        for (const listener of listeners) listener();
    });
    postCanvasMessage({ type: 'paws-project-canvas/ready' });
}
