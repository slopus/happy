type ServiceWorkerHost = Pick<Window, "addEventListener" | "navigator" | "rakazoDesktop">;

/**
 * Production browsers only. Dev must always reach Vite, and Electron serves the
 * renderer itself, so a worker there would shadow the bundled assets.
 */
export function registerServiceWorker(
  target: ServiceWorkerHost = window,
  production: boolean = import.meta.env.PROD,
): void {
  if (!production || target.rakazoDesktop || !("serviceWorker" in target.navigator)) return;
  target.addEventListener(
    "load",
    () => {
      target.navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    },
    { once: true },
  );
}
