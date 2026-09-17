import { Moon, Sun } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Message, Participant, PartyMeta } from '../../vendor/agents-party/src/core/types.js'
import { Button } from '../../vendor/agents-party/src/ui/components/button.js'
import { Input } from '../../vendor/agents-party/src/ui/components/input.js'
import { Chat, type ChatMessage } from '../../vendor/agents-party/src/ui/party/chat.js'
import type { PartyListItem } from '../../vendor/agents-party/src/ui/party/sidebar.js'
import { decrypt } from './lib/crypto.js'
import { getScheme, type Scheme, toggleScheme } from './lib/theme.js'

// Adapted from agents-party web/src/party-app.tsx at af00afbd49b3235c2084cff9849ef12353073484 (MIT).
import { initialTimeline, receivedBatch } from '../timeline.js'
import { ROLE_IDS, type ConnectionStatus, type FollowUpInput, type ImageRef, type MachinesResponse, type RoleId, type RunSnapshot } from '../contracts.js'
import { ApiError, bootstrapToken, createApi, Unauthorized } from './api.js'
import { ConnectionPanel } from './ConnectionPanel.js'
import { AgentDetails } from './AgentDetails.js'
import { Attachments, RichMessage } from './Attachments.js'
import { isActive, RunStatus, StartConsultation } from './Consultation.js'

const PAGE = 50
const HOST = 'host'

/** Owner-facing party meta as returned by GET /api/parties — publicMeta with the plaintext `key`. */
type OwnerParty = Pick<PartyMeta, 'id' | 'title' | 'createdAt' | 'lastMessageAt' | 'messagesCount' | 'key'>

const decodeToChat = async (raw: Message[], key: string | null): Promise<ChatMessage[]> =>
  Promise.all(
    raw.map(async (m) => ({
      id: m.id,
      kind: m.kind,
      from: m.from,
      to: m.to,
      ts: m.ts,
      text: m.kind !== 'message' ? null : key === null ? null : await decrypt(key, m.text),
    })),
  )

export const PartyApp = () => {
  const [token, setToken] = useState<string>(() => bootstrapToken(window.location, window.history, sessionStorage))
  const [gate, setGate] = useState(!token)
  const [gateDraft, setGateDraft] = useState('')
  const [gateError, setGateError] = useState('')

  const [parties, setParties] = useState<OwnerParty[]>([])
  const [partiesHasMore, setPartiesHasMore] = useState(false)
  const [partiesLoadingMore, setPartiesLoadingMore] = useState(false)
  const [partiesLoading, setPartiesLoading] = useState(true)
  const [current, setCurrent] = useState<OwnerParty | null>(null)
  const [participants, setParticipants] = useState<Participant[]>([])
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [hasOlder, setHasOlder] = useState(false)

  const [scheme, setSchemeState] = useState<Scheme>('light')
  useEffect(() => setSchemeState(getScheme()), [])

  const [connection, setConnection] = useState<ConnectionStatus>({ state: 'disconnected' })
  const [machines, setMachines] = useState<MachinesResponse['machines']>([])
  const [runs, setRuns] = useState<RunSnapshot[]>([])
  const [creating, setCreating] = useState<number | null>(null)
  const creationRef = useRef<number | null>(null)
  const navigationRef = useRef(0)
  const [detailRole, setDetailRole] = useState<RoleId | null>(null)
  const [images, setImages] = useState<ImageRef[]>([])
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const timelineRef = useRef(initialTimeline())
  const draftGenerationRef = useRef(0)
  const draftGeneration = draftGenerationRef.current
  const pendingFollowUp = useRef<{ runId: string; input: FollowUpInput } | null>(null)
  const run = runs.find(item => item.partyId === current?.id)
  const keyRef = useRef<string | null>(null)
  const oldestRef = useRef<string | null>(null) // oldest loaded — the `before` for older pages
  const listenAbortRef = useRef<AbortController | null>(null)
  const tokenRef = useRef(token)
  tokenRef.current = token

  const projectTimeline = useCallback(async (key: string | null, signal?: AbortSignal) => {
    // Reducer states are immutable: identity is the version of this projection.
    // Another receive/older page may merge while WebCrypto is still decrypting.
    const snapshot = timelineRef.current
    const decoded = await decodeToChat(snapshot.messages, key)
    if (!signal?.aborted && timelineRef.current === snapshot) setMessages(decoded)
  }, [])

  const api = useMemo(() => createApi(() => tokenRef.current, () => setGate(true)), [])
  const refreshRuns = useCallback(async () => {
    const result = await api<{ runs: RunSnapshot[] }>('/api/consultations')
    setRuns(result.runs)
  }, [api])
  useEffect(() => {
    if (gate || !token) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try {
        const [status, result] = await Promise.all([api<ConnectionStatus>('/api/paws/status'), api<{ runs: RunSnapshot[] }>('/api/consultations')])
        if (cancelled) return
        setConnection(status); setRuns(result.runs)
        if (status.state === 'ready') {
          const result = await api<MachinesResponse>('/api/paws/machines')
          if (!cancelled) setMachines(result.machines)
        } else setMachines([])
      } catch (error) { if (!cancelled) setError((error as Error).message) }
      if (!cancelled) timer = setTimeout(refresh, 1500)
    }
    void refresh()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [api, gate, token])

  const partiesCountRef = useRef(0)
  useEffect(() => {
    partiesCountRef.current = parties.length
  }, [parties])

  // Refresh keeps the loaded window (order and counters move on every message); more pages ride in on scroll.
  const loadParties = useCallback(async () => {
    const limit = Math.max(PAGE, partiesCountRef.current)
    const { parties: list } = (await api(`/api/parties?limit=${limit}`)) as { parties: OwnerParty[] }
    setParties(list)
    setPartiesHasMore(list.length >= limit)
    return list
  }, [api])

  const loadMoreParties = useCallback(async () => {
    setPartiesLoadingMore(true)
    try {
      const offset = partiesCountRef.current
      const { parties: page } = (await api(`/api/parties?limit=${PAGE}&offset=${offset}`)) as { parties: OwnerParty[] }
      setParties((prev) => {
        const seen = new Set(prev.map((p) => p.id))
        return [...prev, ...page.filter((p) => !seen.has(p.id))]
      })
      setPartiesHasMore(page.length >= PAGE)
    } catch (error) {
      setError((error as Error).message)
    } finally {
      setPartiesLoadingMore(false)
    }
  }, [api])

  const refreshParticipants = useCallback(
    async (id: string, signal?: AbortSignal) => {
      const { participants: list } = (await api(`/api/parties/${id}/participants`, { signal })) as { participants: Participant[] }
      if (!signal?.aborted) setParticipants(list)
    },
    [api],
  )

  const listenLoop = useCallback(
    (id: string) => {
      const ctl = listenAbortRef.current!
      const key = keyRef.current
      void (async () => {
        while (!ctl.signal.aborted) {
          try {
            const since = `&since=${timelineRef.current.receiveCursor}`
            // `all=1`: this is the owner's machine and the owner's party, so the stream carries everything, exactly
            // like the history load above (which asks for no viewer). Filtered to `for=host`, an agent-to-agent
            // message never arrived here and never even ended the poll, so it showed up only on a page reload.
            const res = await fetch(`/api/parties/${id}/listen?for=${HOST}&all=1&timeoutSec=50${since}`, {
              signal: ctl.signal,
              headers: tokenRef.current ? { authorization: `Bearer ${tokenRef.current}` } : {},
            })
            if (ctl.signal.aborted) {
              return
            }
            if (!res.ok) {
              // 401 → token changed, raise the gate and stop. Anything else (e.g. 404 party deleted): back off, don't
              // spin. Without this, error JSON has no `messages` and the loop re-fires instantly — a hot request loop.
              if (res.status === 401) {
                setGate(true)
                return
              }
              setError('Party 监听暂时断开，正在重试。')
              await new Promise((r) => setTimeout(r, 2000))
              continue
            }
            const body = (await res.json()) as { messages?: Message[] }
            const incoming = body.messages ?? []
            if (incoming.length > 0) {
              timelineRef.current = receivedBatch(timelineRef.current, incoming)
              await projectTimeline(key, ctl.signal)
              if (ctl.signal.aborted) {
                return
              }
              void refreshParticipants(id, ctl.signal).catch(() => undefined)
              void loadParties().catch(error => setError((error as Error).message))
            }
          } catch (error) {
            if (ctl.signal.aborted || error instanceof Unauthorized) {
              return
            }
            setError('Party 监听暂时断开，正在重试。')
            await new Promise((r) => setTimeout(r, 2000))
          }
        }
      })()
    },
    [loadParties, refreshParticipants, projectTimeline],
  )

  const openParty = useCallback(
    async (id: string) => {
      navigationRef.current += 1
      listenAbortRef.current?.abort()
      draftGenerationRef.current += 1
      const ctl = new AbortController()
      listenAbortRef.current = ctl
      setDetailRole(null); setImages([]); setUploading(false); pendingFollowUp.current = null; setError('')
      // The list is paged — a party can sit past the loaded window; fall back to fetching its meta by id.
      const party =
        parties.find((p) => p.id === id) ?? ((await api(`/api/parties/${id}`).catch(() => null)) as OwnerParty | null)
      if (party === null) {
        return
      }
      if (ctl.signal.aborted) return
      sessionStorage.setItem('apCurrentParty', id)
      timelineRef.current = initialTimeline()
      keyRef.current = party.key
      setCurrent(party)
      setSelected([])
      setMessages([])
      setParticipants([])
      setMessagesLoading(true)
      setLoadingOlder(false)
      try {
        await refreshParticipants(id, ctl.signal)
        if (ctl.signal.aborted) return
        const { messages: raw } = (await api(`/api/parties/${id}/messages?limit=${PAGE}`, { signal: ctl.signal })) as { messages: Message[] }
        if (ctl.signal.aborted) return
        oldestRef.current = raw[0]?.cursor ?? null
        timelineRef.current = receivedBatch(initialTimeline(), raw)
        setHasOlder(raw.length >= PAGE)
        await projectTimeline(party.key, ctl.signal)
        if (ctl.signal.aborted) return
        void loadParties().catch(error => setError((error as Error).message))
        listenLoop(id)
      } catch (error) {
        if (!ctl.signal.aborted && !(error instanceof Unauthorized)) {
          setError((error as Error).message)
        }
      } finally {
        if (!ctl.signal.aborted) setMessagesLoading(false)
      }
    },
    [api, parties, refreshParticipants, loadParties, listenLoop, projectTimeline],
  )

  const [loadingOlder, setLoadingOlder] = useState(false)
  const loadOlder = useCallback(async () => {
    if (current === null || oldestRef.current === null || loadingOlder) {
      return
    }
    setLoadingOlder(true)
    const ctl = listenAbortRef.current
    const key = keyRef.current
    try {
      const { messages: raw } = (await api(
        `/api/parties/${current.id}/messages?limit=${PAGE}&before=${oldestRef.current}`,
        { signal: ctl?.signal },
      )) as { messages: Message[] }
      if (ctl?.signal.aborted) return
      if (raw.length === 0) {
        setHasOlder(false)
        return
      }
      oldestRef.current = raw[0]!.cursor
      timelineRef.current = receivedBatch(timelineRef.current, raw)
      await projectTimeline(key, ctl?.signal)
      if (ctl?.signal.aborted) return
      setHasOlder(raw.length >= PAGE)
    } catch (error) {
      if (!ctl?.signal.aborted) setError((error as Error).message)
    } finally {
      if (!ctl?.signal.aborted) setLoadingOlder(false)
    }
  }, [api, current, loadingOlder, projectTimeline])

  const send = useCallback(async (text: string) => {
    if (!run || connection.state !== 'ready') throw new Error('先连接 Paws 并选择会诊。')
    const generation = draftGeneration
    const pending = pendingFollowUp.current ?? { runId: run.id, input: { requestId: crypto.randomUUID(), text, to: selected as RoleId[], images } }
    pendingFollowUp.current = pending
    try {
      await api('/api/consultations/' + pending.runId + '/messages', { method: 'POST', body: JSON.stringify(pending.input) })
    } catch (error) {
      if (error instanceof ApiError && error.status < 500 && pendingFollowUp.current === pending) pendingFollowUp.current = null
      throw error
    }
    if (pendingFollowUp.current === pending) pendingFollowUp.current = null
    if (generation !== draftGenerationRef.current) return
    setImages([])
    await refreshRuns().catch(error => setError((error as Error).message))
  }, [api, run, connection.state, selected, images, refreshRuns, draftGeneration])

  const boot = useCallback(async () => {
    try {
      const list = await loadParties()
      setGate(false)
      const saved = sessionStorage.getItem('apCurrentParty')
      if (saved) void openParty(saved)
      else if (list[0]) void openParty(list[0].id)
    } catch (error) {
      if (error instanceof Unauthorized) {
        setGateError('令牌无效，请核对服务的 access-token 文件。')
      } else {
        setError((error as Error).message)
      }
    } finally {
      setPartiesLoading(false)
    }
  }, [loadParties])

  useEffect(() => {
    if (token) void boot()
    return () => { navigationRef.current += 1; creationRef.current = null; draftGenerationRef.current += 1; listenAbortRef.current?.abort() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const submitGate = (e: React.FormEvent) => {
    e.preventDefault()
    const t = gateDraft.trim()
    setToken(t)
    tokenRef.current = t
    sessionStorage.setItem('apToken', t)
    setGateError('')
    void boot()
      .catch((error) => {
        if (error instanceof Unauthorized) {
          setGateError('令牌无效，请核对服务的 access-token 文件。')
        }
      })
  }

  const partyItems: PartyListItem[] = parties.map((p) => ({
    id: p.id,
    title: p.title,
    lastMessageAt: p.lastMessageAt,
    messagesCount: p.messagesCount,
  }))

  const recipientOptions = participants
    .filter((p) => p.leftAt === undefined && p.name !== HOST)
    .map((p) => ({ name: p.name, color: p.color }))

  const headerActions = run ? <RunStatus run={run} onStop={async () => {
    await api('/api/consultations/' + run.id + '/stop', { method: 'POST', body: '{}' }); await refreshRuns()
  }} /> : undefined

  return (
    <div className="flex h-dvh w-full flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-border px-4 sm:px-6">
        <div className="flex items-baseline gap-3">
          <a href="https://github.com/1gr14/agents-party/tree/af00afbd49b3235c2084cff9849ef12353073484" target="_blank" rel="noreferrer" className="font-logo text-lg font-bold text-foreground">agents-party ↗</a>
          <span className="font-accent text-xs text-muted-foreground">{HOST}</span>
        </div>
        <Button onClick={() => { creationRef.current = ++navigationRef.current; setCreating(creationRef.current) }} disabled={gate}>新建会诊</Button>
        <Button
          variant="secondary"
          size="icon-sm"
          aria-label="切换主题"
          icon={scheme === 'dark' ? Moon : Sun}
          onClick={() => setSchemeState(toggleScheme())}
        />
      </header>

      <div className="border-b border-border bg-muted px-4 py-2 text-xs">Mock 行情 · 合成数据，不构成投资建议</div>
      <ConnectionPanel status={connection} api={api} active={runs.some(isActive)} onChange={setConnection} />
      {error && <div role="alert" className="flex justify-between px-4 py-2 text-sm text-destructive">{error}<button onClick={() => setError('')}>关闭提示</button></div>}
      <main className="flex min-h-0 w-full flex-1">
        <Chat
          parties={partyItems}
          activeId={current?.id ?? null}
          onOpenParty={(id) => void openParty(id)}
          onOpenParticipant={name => { if (run && ROLE_IDS.includes(name as RoleId)) setDetailRole(name as RoleId) }}
          renderMessage={message => <RichMessage text={message.text} api={api} />}
          partiesHasMore={partiesHasMore}
          partiesLoadingMore={partiesLoadingMore}
          partiesLoading={partiesLoading}
          onLoadMoreParties={() => void loadMoreParties()}
          headerActions={headerActions}
          title={current?.title ?? null}
          participants={participants}
          messages={messages}
          messagesLoading={messagesLoading}
          hasOlder={hasOlder}
          loadingOlder={loadingOlder}
          onLoadOlder={() => void loadOlder()}
          onSend={send}
          composerDisabled={!run || run.status === 'running' || connection.state !== 'ready' || uploading || isActive(run)}
          composerHasContent={images.length > 0}
          composerExtension={<><span>{!run ? '此 Party 无关联会诊。' : connection.state !== 'ready' ? '先连接 Paws，才能追问。' : isActive(run) ? '等待当前协调结束后追问。' : '追问未选收件人时交给主持人。'}</span><Attachments key={draftGeneration} images={images} onChange={next => { if (draftGeneration === draftGenerationRef.current) setImages(next) }} api={api} disabled={!run || isActive(run)} onBusy={busy => { if (draftGeneration === draftGenerationRef.current) setUploading(busy) }} /></>}
          recipients={{
            options: recipientOptions,
            selected,
            onToggle: (name) =>
              setSelected((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name])),
            onEveryone: () => setSelected([]),
          }}
          currentName={HOST}
          onBack={() => {
            navigationRef.current += 1
            listenAbortRef.current?.abort()
            draftGenerationRef.current += 1
            pendingFollowUp.current = null; setImages([]); setUploading(false)
            sessionStorage.removeItem('apCurrentParty')
            setCurrent(null)
            setDetailRole(null)
            setMessages([])
          }}
        />
        {run && detailRole && <AgentDetails key={run.id + ':' + detailRole} run={run} role={detailRole} api={api} onClose={() => setDetailRole(null)} />}
      </main>
      {creating !== null && <StartConsultation key={creating} ready={connection.state === 'ready'} machines={machines} api={api} onClose={() => {
        if (creationRef.current !== creating) return
        creationRef.current = null; navigationRef.current += 1; setCreating(null)
      }} onStarted={created => {
        // Accepted work stays in history even after its dialog closes. Navigation
        // belongs only to the originating instance and must survive the refresh.
        setRuns(previous => [created, ...previous.filter(item => item.id !== created.id)])
        const ownsDialog = creationRef.current === creating
        const navigation = creating
        if (ownsDialog) { creationRef.current = null; setCreating(null) }
        void loadParties().then(() => {
          if (ownsDialog && navigation === navigationRef.current) return openParty(created.partyId)
        }).catch(error => { if (ownsDialog && navigation === navigationRef.current) setError((error as Error).message) })
      }} />}

      {gate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
          <form onSubmit={submitGate} className="flex w-80 flex-col gap-3">
            <h1 className="font-logo text-xl font-bold text-foreground">agents-party</h1>
            <p className="text-sm text-muted-foreground">
              输入本地服务 access-token 文件中的访问令牌。令牌仅保存在此标签页会话中，不是 Paws 账号密钥。
            </p>
            <Input
              type="password"
              autoFocus
              value={gateDraft}
              onChange={(e) => setGateDraft(e.target.value)}
              aria-label="服务访问令牌"
              placeholder="服务访问令牌"
            />
            <Button type="submit">进入</Button>
            {gateError && <p className="text-sm text-destructive">{gateError}</p>}
          </form>
        </div>
      )}
    </div>
  )
}
