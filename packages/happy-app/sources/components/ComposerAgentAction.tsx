import * as React from 'react';
export type ComposerAgentActionProps = { agent?: string | null; label: string; fallback: React.ReactNode; busy?: boolean };
export function getComposerAgentActionStyle(_agent: string | null | undefined, _label?: string): object | undefined { return undefined; }
export function ComposerAgentAction({ fallback }: ComposerAgentActionProps) { return <>{fallback}</>; }
