import { spawn } from "node:child_process";
import { spawnPnpm } from "../../../../scripts/pnpm.mjs";

export function runProcess(command: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<void>((resolve, reject) => {
    const options = { stdio: "inherit", env, shell: false } as const;
    const child = command === "pnpm" ? spawnPnpm(args, options) : spawn(command, args, options);
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
    });
  });
}
