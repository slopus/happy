import { readlink } from "node:fs/promises";
import type { LibraryHandle } from "koffi";
import koffi from "koffi";
import { pathFromWindowsHandle } from "./desktop-sandbox-win32-path.js";

type KoffiFunction = ReturnType<LibraryHandle["func"]>;

let getPath: KoffiFunction | undefined;
let getNodeHandle: KoffiFunction | undefined;

/** Resolve the opened object, never the pathname that was used to open it. */
export async function fileHandlePath(fd: number): Promise<string> {
  if (process.platform === "linux") {
    // readlink preserves the kernel's path even if an ancestor has since been
    // replaced. realpath would follow the replacement and lose that guarantee.
    return readlink(`/proc/self/fd/${fd}`);
  }
  if (process.platform === "win32") {
    // Node descriptors belong to its own CRT. Looking them up in msvcrt.dll
    // can return an invalid or unrelated handle from a different descriptor table.
    getNodeHandle ??= koffi.load(null).func("intptr_t __cdecl uv_get_osfhandle(int fd)");
    return pathFromWindowsHandle(getNodeHandle(fd) as number | bigint);
  }
  if (process.platform === "darwin") {
    getPath ??= koffi.load("/usr/lib/libSystem.B.dylib").func("int fcntl(int fd, int cmd, ...)");
    const buffer = Buffer.alloc(1024); // Darwin MAXPATHLEN
    const result = getPath(fd, 50 /* F_GETPATH */, "void *", buffer) as number;
    const end = buffer.indexOf(0);
    if (result !== 0 || end <= 0) throw new Error("Cannot resolve the opened home file");
    return buffer.toString("utf8", 0, end);
  }
  throw new Error("Cannot securely read home files on this platform");
}
