import { realpath } from 'node:fs/promises';
import { ArtifactRequests, ARTIFACT_LIMITS, ARTIFACT_PROTOCOL } from '@slopus/happy-wire';
import { ArtifactError, inside } from './files';
import type { ArtifactStore } from './store';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';

export function registerArtifactHandlers(manager: Pick<RpcHandlerManager, 'registerHandler'>, getStore: () => Promise<ArtifactStore>, directory?: string, authorizeRoot?: (root: string) => Promise<void>) {
  for (const method of Object.keys(ArtifactRequests) as (keyof typeof ArtifactRequests)[]) {
    manager.registerHandler(method, async (input: unknown) => {
      try {
        const parsed = ArtifactRequests[method].safeParse(input);
        if (!parsed.success) throw new ArtifactError('LIMIT_EXCEEDED', 'Invalid or oversized artifact request');
        const data = parsed.data as any;
        const store = await getStore();
        if (method === 'artifactCapabilities') return { ok: true, value: { protocol: ARTIFACT_PROTOCOL, formats: ['html', 'markdown'], snapshot: true, restore: true, automaticAgents: ['codex'], limits: ARTIFACT_LIMITS } };
        const allowed = directory ? await realpath(directory) : undefined;
        if (method === 'artifactRegister') {
          const root = await realpath(data.root);
          if (allowed && !inside(allowed, root)) throw new ArtifactError('PATH_OUT_OF_BOUNDS', 'Workspace is outside this session directory');
          await authorizeRoot?.(root);
        } else if (data.workspaceId && allowed) {
          const ws = (await store.catalog(data.workspaceId))[0];
          if (!ws || !inside(allowed, ws.root)) throw new ArtifactError('PATH_OUT_OF_BOUNDS', 'Workspace is outside this session directory');
        }
        let value: unknown;
        switch (method) {
          case 'artifactCatalog': {
            const root = data.root ? await realpath(data.root) : undefined;
            value = (await store.catalog(data.workspaceId)).filter(ws => (!allowed || inside(allowed, ws.root)) && (!root || ws.root === root)); break;
          }
          case 'artifactRegister': value = await store.register(data); break;
          case 'artifactRead': value = await store.read(data); break;
          case 'artifactResourceRead': value = await store.resource(data); break;
          case 'artifactVersions': value = await store.versions(data); break;
          case 'artifactSave': value = await store.save(data); break;
          case 'artifactRestore': value = await store.restore(data); break;
          case 'artifactRename': value = await store.rename(data); break;
          case 'artifactOperation': value = await store.operation(data.workspaceId, data.operationId); break;
          case 'artifactResolveOperation': value = await store.resolveOperation(data); break;
        }
        return { ok: true, value };
      } catch (error) {
        return { ok: false, error: error instanceof ArtifactError ? { code: error.code, message: error.message, ...(error.operationId ? { operationId: error.operationId } : {}), ...(error.actualRevision ? { actualRevision: error.actualRevision } : {}) } : { code: 'INTERNAL', message: 'Artifact operation failed; no complete success has been confirmed' } };
      }
    });
  }
}
