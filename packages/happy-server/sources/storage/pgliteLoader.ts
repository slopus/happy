import { PGlite } from "@electric-sql/pglite";
import * as fs from "fs";
import * as path from "path";

function findWasmFiles(): { wasmModule: WebAssembly.Module; fsBundle: Blob } | null {
    const searchPaths = [
        process.cwd(),
        path.dirname(process.execPath),
    ];

    for (const dir of searchPaths) {
        const wasmPath = path.join(dir, "pglite.wasm");
        const dataPath = path.join(dir, "pglite.data");
        if (fs.existsSync(wasmPath) && fs.existsSync(dataPath)) {
            const wasmModule = new WebAssembly.Module(fs.readFileSync(wasmPath));
            const fsBundle = new Blob([fs.readFileSync(dataPath)]);
            return { wasmModule, fsBundle };
        }
    }
    return null;
}

export function createPGlite(dataDir: string): PGlite {
    const wasmOpts = findWasmFiles();
    if (wasmOpts) {
        return new PGlite({ dataDir, ...wasmOpts });
    }
    return new PGlite(dataDir);
}
