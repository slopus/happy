import type { HappySessionClientLike } from './offline-stub';
import type {
  PiExtensionApiLike,
  PiHappyExtensionContext,
  PiHappyModelSelectEvent,
} from './types';

export type PiHappyMetadataPatch = {
  tools: string[];
  slashCommands: string[];
  currentModelCode?: string;
};

export function collectMetadataPatch(
  pi: Pick<PiExtensionApiLike, 'getAllTools' | 'getCommands'>,
  ctx: Pick<PiHappyExtensionContext, 'model'>,
): PiHappyMetadataPatch {
  return {
    tools: pi.getAllTools().map(tool => tool.name),
    slashCommands: pi.getCommands().map(command => command.name),
    currentModelCode: ctx.model?.name,
  };
}

export async function syncModelSelection(
  client: HappySessionClientLike,
  event: PiHappyModelSelectEvent,
): Promise<void> {
  await client.updateMetadata(metadata => ({
    ...metadata,
    currentModelCode: event.model.name,
  }));
}
