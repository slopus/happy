import type { FC, ReactNode } from 'react'
import type { StudioConfigResponse } from '../../shared.js'

/**
 * Lifecycle of the license value the infinite canvas is allowed to mount with.
 * tldraw 5.3.0 reads its license key once, when LicenseProvider first mounts
 * (its `useState(() => new LicenseManager(licenseKey))` has no update path), so
 * the key cannot be swapped under a running editor without dropping local
 * canvas state. The gate therefore keeps the editor unmounted until the first
 * config read settles, then lets the canvas capture that one value.
 */
export type StudioCanvasLicenseState = 'loading' | 'unconfigured' | 'configured' | 'failed'

export function studioCanvasLicenseState(
  config: Pick<StudioConfigResponse, 'tldrawLicenseKey'> | null,
  loading: boolean,
): StudioCanvasLicenseState {
  if (loading) return 'loading'
  if (config === null) return 'failed'
  return config.tldrawLicenseKey?.trim() ? 'configured' : 'unconfigured'
}

/** Hold the tldraw surface until the license read settles; a failed read still opens it. */
export const StudioCanvasGate: FC<{
  state: StudioCanvasLicenseState
  loadingLabel: string
  children: ReactNode
}> = ({ state, loadingLabel, children }) => state === 'loading'
  ? <div className="dsh-ig-canvas"><div className="dsh-ig-canvas-empty" role="status">{loadingLabel}</div></div>
  : <>{children}</>
