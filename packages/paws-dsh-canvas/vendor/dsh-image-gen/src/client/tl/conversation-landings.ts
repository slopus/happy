import { imageResultsFromMeta, imageResultsFromPtcDispatch } from '../image-result-node.js'
import { pushTlLandingsLive } from './tl-canvas-bridge.js'

interface EventEntry {
  readonly type: string
  readonly event: { readonly type: string; readonly seq: number; readonly data: Record<string, unknown> }
}

interface EventSource {
  getSnapshot(): {
    readonly entries: readonly EventEntry[]
    readonly change: { readonly kind: string; readonly entries?: readonly EventEntry[] }
  }
  subscribe(listener: () => void): () => void
}

/** Small runtime face: older hosts may not expose the modern session feed. */
export interface CanvasSessions {
  list: {
    getSnapshot(): {
      current?: string | undefined
      byId?: Readonly<Record<string, { id: string; retainedBy?: Readonly<Record<string, number>> }>>
    }
    subscribe(listener: () => void): () => void
  }
  binding(id: string): { eventSource: EventSource } | undefined
}

/** Runtime face of uiSession.adapter.current; absent on older hosts. */
export interface CanvasSessionSelection {
  getSnapshot(): { readonly key?: string | undefined } | undefined
  subscribe(listener: () => void): () => void
}

/** Keep one landing subscription while the optional UI service loads or unloads. */
export function createCanvasSessionSelection(): CanvasSessionSelection & { bind(source: CanvasSessionSelection): () => void } {
  let current: CanvasSessionSelection | undefined
  const listeners = new Set<() => void>()
  const notify = (): void => { for (const listener of listeners) listener() }
  return {
    getSnapshot: () => current?.getSnapshot(),
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    bind(source) {
      current = source
      const stop = source.subscribe(notify)
      notify()
      return () => {
        stop()
        if (current !== source) return
        current = undefined
        notify()
      }
    },
  }
}

function currentSessionId(sessions: CanvasSessions, selection?: CanvasSessionSelection): string | undefined {
  const selected = selection?.getSnapshot()
  // A present UI store with no key means no active conversation, not permission
  // to land images from a different retained/background session.
  if (selected !== undefined) return selected.key || undefined
  const snapshot = sessions.list.getSnapshot()
  if (snapshot.current) return snapshot.current
  const mainViews = Object.values(snapshot.byId ?? {}).filter(row => (row.retainedBy?.mainView ?? 0) > 0)
  // Without the UI authority, ambiguous windows must not cross-deliver images.
  return mainViews.length === 1 ? mainViews[0]!.id : undefined
}

/** Subscribe to live additions, never to card rendering or history replay. */
export function startConversationLandings(sessions: CanvasSessions, selection?: CanvasSessionSelection): () => void {
  let source: EventSource | undefined
  let stopEvents: (() => void) | undefined
  const followCurrent = (): void => {
    const id = currentSessionId(sessions, selection)
    const next = id === undefined ? undefined : sessions.binding(id)?.eventSource
    if (next === source) return
    stopEvents?.()
    source = next
    if (next === undefined) return
    let lastSeq = next.getSnapshot().entries.reduce((seq, entry) => Math.max(seq, entry.event.seq), -1)
    stopEvents = next.subscribe(() => {
      const change = next.getSnapshot().change
      for (const entry of change.entries ?? []) {
        if (entry.type !== 'event') continue
        const { event } = entry
        const isNew = event.seq > lastSeq
        lastSeq = Math.max(lastSeq, event.seq)
        if (change.kind !== 'append' || !isNew) continue
        const results = event.type === 'tool/result'
          ? imageResultsFromMeta(event.data.meta) : imageResultsFromPtcDispatch(event)
        if (results.length === 0) continue
        // A vector result has no attachment and therefore no canvas landing.
        pushTlLandingsLive(results.flatMap(result => result.attachment === undefined ? [] : [{
          galleryId: String(result.attachment.attachmentId),
          attachment: result.attachment,
          fromConversation: true,
          prompt: result.prompt,
          provider: result.provider,
          model: result.model,
        }]))
      }
    })
  }
  const stopList = sessions.list.subscribe(followCurrent)
  const stopSelection = selection?.subscribe(followCurrent)
  followCurrent()
  return () => { stopList(); stopSelection?.(); stopEvents?.() }
}
