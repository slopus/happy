export function requireReactDOM(): any {
    // IMPORTANT:
    // Use `require` so this module can be imported in cross-platform code without pulling `react-dom`
    // into native bundles. Callers should only invoke this on web.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('react-dom');
}

