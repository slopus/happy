import * as React from 'react';
/** Desktop Web owns the floating monitor; other platforms keep their existing UI. */
export function GlobalSessionMonitor({ children }: { children: React.ReactNode }) { return <>{children}</>; }
export function GlobalSessionRailEntry(_props: { render: (props: { label: string; selected: boolean; onPress: () => void; badge?: string; notificationCount?: number; runningCount?: number }) => React.ReactNode }) { return null; }
