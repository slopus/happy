import { codexAcpDepCapability } from '@/capabilities/registry/depCodexAcp';
import { codexMcpResumeDepCapability } from '@/capabilities/registry/depCodexMcpResume';
import type { Capability } from '@/capabilities/service';

export const capabilities: ReadonlyArray<Capability> = [
  codexMcpResumeDepCapability,
  codexAcpDepCapability,
];

