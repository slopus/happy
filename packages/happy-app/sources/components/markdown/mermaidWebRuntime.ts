import { createMermaidRuntime, type MermaidRuntime } from './mermaidRuntime';

let runtime: Promise<MermaidRuntime> | undefined;

/** Mermaid has document-global configuration: serialize initialize + render. */
export function getWebMermaidRuntime(): Promise<MermaidRuntime> {
    if (!runtime) {
        runtime = import('mermaid').then(module => createMermaidRuntime(module.default,
            () => import('@mermaid-js/layout-elk').then(layout => layout.default)))
            .catch(error => { runtime = undefined; throw error; });
    }
    return runtime;
}
