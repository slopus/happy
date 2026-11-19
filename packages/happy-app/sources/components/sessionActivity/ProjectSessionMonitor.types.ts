import type * as React from 'react';
import type { GoalTask } from '@slopus/happy-wire';
import type { ActivityScope } from './sessionActivity';
export type ProjectSessionMonitorProps = { scope?: ActivityScope; knownScopes?: ActivityScope[]; children: React.ReactNode };
export type ProjectTaskSessionsProps = { task: GoalTask; machineId: string; featurePath: string; onFallback: () => void; disabled?: boolean; offline?: boolean };
