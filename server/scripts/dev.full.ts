import dotenv from "dotenv";
import { execSync } from "node:child_process";
import { parseDevFullArgs } from "./dev.fullArgs";

const args = parseDevFullArgs(process.argv.slice(2), process.env);

dotenv.config({ path: '.env.dev' });
process.env.PORT = String(args.port);

if (args.killPort) {
    try {
        execSync(
            `sh -c 'pids="$(lsof -ti tcp:${args.port} 2>/dev/null || true)"; if [ -n "$pids" ]; then kill -9 $pids; fi'`,
            { stdio: 'inherit' }
        );
    } catch {
        // ignore: nothing to kill / lsof missing / permission issues
    }
}

await import('../sources/main');
