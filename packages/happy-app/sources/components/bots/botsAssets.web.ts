type BotsRuntime = NonNullable<Window['PawsBots']>;
const styles = new WeakMap<Document, Map<string, Promise<void>>>();

/** Reuse scoped CSS and HTTP-cached code bytes, never a live account runtime.
 * Each entry execution creates fresh auth, call and preference module state. */
export function loadBotsAssets(entry: string, css: string) {
    let cache = styles.get(document);
    if (!cache) { cache = new Map(); styles.set(document, cache); }
    let styled = cache.get(css);
    if (!styled) {
        const style = document.createElement('link');
        style.rel = 'stylesheet'; style.href = css;
        styled = new Promise<void>((resolve, reject) => {
            style.onload = () => resolve();
            style.onerror = () => reject(new Error('Bots styles failed to load'));
        }).catch(error => { cache!.delete(css); style.remove(); throw error; });
        cache.set(css, styled);
        document.head.appendChild(style);
    }
    const script = document.createElement('script');
    script.async = true; script.src = entry;
    const runtime = new Promise<BotsRuntime>((resolve, reject) => {
        script.onload = () => window.PawsBots ? resolve(window.PawsBots) : reject(new Error('Bots runtime unavailable'));
        script.onerror = () => reject(new Error('Bots script failed to load'));
    });
    const ready = Promise.all([styled, runtime]).then(([, value]) => value);
    document.head.appendChild(script);
    return { ready, dispose: () => script.remove() };
}
