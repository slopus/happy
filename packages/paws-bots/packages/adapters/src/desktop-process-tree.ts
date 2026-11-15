import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import koffi from "koffi";

export interface NativeProcessTree {
  alive(): boolean;
  kill(): void;
  close(): void;
}

let windowsApi: ReturnType<typeof loadWindowsApi> | undefined;
function loadWindowsApi() {
  const library = koffi.load("kernel32.dll");
  const limits = koffi.struct("RakazoJobLimits", {
    PerProcessUserTimeLimit: "int64_t",
    PerJobUserTimeLimit: "int64_t",
    LimitFlags: "uint32_t",
    MinimumWorkingSetSize: "size_t",
    MaximumWorkingSetSize: "size_t",
    ActiveProcessLimit: "uint32_t",
    Affinity: "uintptr_t",
    PriorityClass: "uint32_t",
    SchedulingClass: "uint32_t",
  });
  const io = koffi.struct("RakazoJobIoCounters", {
    ReadOperationCount: "uint64_t",
    WriteOperationCount: "uint64_t",
    OtherOperationCount: "uint64_t",
    ReadTransferCount: "uint64_t",
    WriteTransferCount: "uint64_t",
    OtherTransferCount: "uint64_t",
  });
  const extended = koffi.struct("RakazoJobExtendedLimits", {
    BasicLimitInformation: limits,
    IoInfo: io,
    ProcessMemoryLimit: "size_t",
    JobMemoryLimit: "size_t",
    PeakProcessMemoryUsed: "size_t",
    PeakJobMemoryUsed: "size_t",
  });
  return {
    create: library.func("void * __stdcall CreateJobObjectW(void *, void *)"),
    limits: library.func("int __stdcall SetInformationJobObject(void *, int, void *, uint32_t)"),
    open: library.func("void * __stdcall OpenProcess(uint32_t, int, uint32_t)"),
    assign: library.func("int __stdcall AssignProcessToJobObject(void *, void *)"),
    query: library.func(
      "int __stdcall QueryInformationJobObject(void *, int, void *, uint32_t, void *)",
    ),
    terminate: library.func("int __stdcall TerminateJobObject(void *, uint32_t)"),
    close: library.func("int __stdcall CloseHandle(void *)"),
    size: koffi.sizeof(extended),
    flagsOffset:
      koffi.offsetof(extended, "BasicLimitInformation") + koffi.offsetof(limits, "LimitFlags"),
  };
}

function windowsProcessTree(pid: number): NativeProcessTree {
  windowsApi ??= loadWindowsApi();
  const api = windowsApi;
  const job = api.create(null, null);
  if (!job) throw new Error("Could not own the local command process");
  const limits = Buffer.alloc(api.size);
  limits.writeUInt32LE(0x2000, api.flagsOffset); // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
  const processHandle = api.open(0x0101, 0, pid); // PROCESS_SET_QUOTA | PROCESS_TERMINATE
  try {
    if (
      !api.limits(job, 9, limits, limits.length) ||
      !processHandle ||
      !api.assign(job, processHandle)
    ) {
      throw new Error("Could not own the local command process");
    }
  } catch (error) {
    api.close(job);
    throw error;
  } finally {
    if (processHandle) api.close(processHandle);
  }
  let closed = false;
  return {
    alive() {
      if (closed) return false;
      const accounting = Buffer.alloc(48); // JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
      return (
        !api.query(job, 1, accounting, accounting.length, null) || accounting.readUInt32LE(40) > 0
      );
    },
    kill() {
      if (!closed) api.terminate(job, 130);
    },
    close() {
      if (!closed) {
        closed = true;
        api.close(job);
      }
    },
  };
}

// The wrapper waits on a private pipe until the parent assigns its Windows Job. Commands and
// credentials go through that pipe, never the command line. Descendants inherit the Job.
// Keep console applications attached; our Job owns descendants across wrapper exit.
const WINDOWS_COMMAND_WRAPPER = `
const { spawn } = require('node:child_process');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const { argv, env } = JSON.parse(input);
  const child = spawn(argv[0], argv.slice(1), { env, shell: false, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
  child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', (code) => { process.exitCode = code ?? 1; });
});
`;

export function spawnOwnedCommand(
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): {
  child: ChildProcessWithoutNullStreams;
  tree: NativeProcessTree;
} {
  const windows = process.platform === "win32";
  const child = spawn(
    windows ? process.execPath : argv[0]!,
    windows ? ["-e", WINDOWS_COMMAND_WRAPPER] : argv.slice(1),
    {
      cwd,
      env: windows ? { ...env, ELECTRON_RUN_AS_NODE: "1" } : env,
      detached: !windows,
      shell: false,
      windowsHide: true,
    },
  );
  const pid = child.pid;
  let tree: NativeProcessTree;
  try {
    tree =
      windows && pid
        ? windowsProcessTree(pid)
        : {
            alive() {
              if (!pid) return false;
              try {
                process.kill(-pid, 0);
                return true;
              } catch {
                return false;
              }
            },
            kill() {
              if (pid) {
                try {
                  process.kill(-pid, "SIGKILL");
                } catch {
                  child.kill("SIGKILL");
                }
              }
            },
            close() {},
          };
  } catch (error) {
    child.on("error", () => undefined);
    child.kill("SIGKILL");
    throw error;
  }
  child.stdin.on("error", () => undefined);
  if (windows) child.stdin.end(JSON.stringify({ argv, env }));
  return { child, tree };
}
