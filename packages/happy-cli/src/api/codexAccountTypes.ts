import type { CodexAccountAuth } from '@/codex/codexAccountAuth';

// Wire contract: happy-server/sources/app/api/routes/codexAccountTypes.ts.
export interface CodexAccountProfile {
  id: string; displayName: string; credentialVersion: number;
  status: 'available' | 'needs-refresh' | 'invalid';
}
export interface CodexGrantRedemption {
  auth: CodexAccountAuth; launchId: string;
  profile: Pick<CodexAccountProfile, 'id' | 'displayName' | 'credentialVersion'>;
}
export interface CodexLaunchAttribution { machineId: string; launchId: string }
export interface CodexQuotaReport extends CodexLaunchAttribution {
  sourceSessionId: string; credentialVersion: number;
  weeklyUsedPercent: number; weeklyResetsAt: string; observedAt: string;
}
export interface CodexQuotaProbeReport extends CodexLaunchAttribution {
  credentialVersion: number;
  weeklyUsedPercent: number; weeklyResetsAt: string; observedAt: string;
}
export class CodexAccountRequestError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'CodexAccountRequestError'; }
}

export function codexAccountServerUrl(configured: string): string {
  if (configured === 'http://47.115.228.20:3005') return 'https://47.115.228.20:8443';
  const url = new URL(configured);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('Codex accounts require HTTPS (HTTP is allowed only on loopback).');
  }
  return configured.replace(/\/$/, '');
}
