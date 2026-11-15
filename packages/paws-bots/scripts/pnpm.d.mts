import type { ChildProcess, SpawnOptions } from "node:child_process";

export function spawnPnpm(args: string[], options?: SpawnOptions): ChildProcess;
