/** Values shared by the Host and browser Bundle faces. */
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'

function pluginRoute(route: string): string {
  const path = 'plugins/dsh-image-gen/' + route
  return typeof document === 'undefined' ? '/' + path : new URL(path, document.baseURI).pathname
}

/** Browser route used by the generated-image card. */
export const IMAGE_ROUTE = pluginRoute('image')

/** Encode a durable image reference for the cacheable GET form of IMAGE_ROUTE. */
export function encodeImageRef(ref: ImageAttachmentRef): string {
  const bytes = new TextEncoder().encode(JSON.stringify(ref))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Decode a GET query value; the caller supplies the reference parser. */
export function decodeImageRef(value: string, parse: (input: unknown) => ImageAttachmentRef | undefined): ImageAttachmentRef | undefined {
  try {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
    return parse(JSON.parse(new TextDecoder().decode(bytes)))
  } catch {
    return undefined
  }
}

/** Same-origin GET URL for one attachment; safe to put in an <img src>. */
export function imageUrlFor(ref: ImageAttachmentRef): string {
  return IMAGE_ROUTE + '?ref=' + encodeImageRef(ref)
}

/** Same-origin GET URL for a host-rendered thumbnail of one attachment. */
export function thumbUrlFor(ref: ImageAttachmentRef, width = 320): string {
  return THUMB_ROUTE + '?w=' + String(width) + '&ref=' + encodeImageRef(ref)
}

/** Mid-size preview used by the lightbox; originals stay for copy/download/drag. */
export function previewUrlFor(ref: ImageAttachmentRef): string {
  return PREVIEW_ROUTE + '?ref=' + encodeImageRef(ref)
}

/** Content-addressed vault key: the sha256 of the original bytes, validated on both faces. */
export const VAULT_KEY_PATTERN = /^[a-f0-9]{64}$/

/** Content-addressed raw copy, served when the attachment layer normalized an import or a generated GIF. */
export function vaultUrlFor(key: string, mediaType?: string): string {
  const base = VAULT_ROUTE + '?key=' + encodeURIComponent(key)
  return mediaType === undefined ? base : base + '&mediaType=' + encodeURIComponent(mediaType)
}
/** Browser route that uploads user-picked images as DSH attachments. */
export const IMPORT_ROUTE = pluginRoute('import')
/** Browser route used for deleting generated images and workspace files. */
export const DELETE_ROUTE = pluginRoute('delete')
/** Same-origin route used by the browser image workbench. */
export const STUDIO_ROUTE = pluginRoute('studio')
/** Same-origin route for built-in prompt inspiration metadata and images. */
export const INSPIRATION_ROUTE = pluginRoute('inspiration')
/** Browser route used for saving generated images to workspace on demand. */
export const SAVE_WORKSPACE_ROUTE = pluginRoute('save-workspace')
/** Browser route that streams a ZIP export of the selected gallery images. */
export const ZIP_ROUTE = pluginRoute('zip')
/** Browser route that serves host-rendered gallery thumbnails. */
export const THUMB_ROUTE = pluginRoute('thumb')
export const PREVIEW_ROUTE = pluginRoute('preview')
export const VAULT_ROUTE = pluginRoute('vault')
export const VAULT_REFS_ROUTE = pluginRoute('vault-refs')
export const VAULT_DELETE_ROUTE = pluginRoute('vault-delete')
export const ZIP_PROGRESS_ROUTE = pluginRoute('zip/progress')
export const ZIP_CANCEL_ROUTE = pluginRoute('zip/cancel')
export const STORAGE_STATS_ROUTE = pluginRoute('storage-stats')
/** Browser route the settings card probes provider connectivity through. */
export const TEST_CONNECTION_ROUTE = pluginRoute('test')
/** Non-secret settings capability probe, available even when the host cannot serve a form. */
export const SETTINGS_HEALTH_ROUTE = pluginRoute('settings-health')

export interface SettingsHealth {
  settings: 'unavailable' | 'legacy' | 'live'
  liveSchema: boolean
}
/** Browser route the workbench infinite canvas pushes live state through. */
export const CANVAS_STATE_ROUTE = pluginRoute('canvas-state')
/** Upload a selected canvas original to the host attachment store. */
export const CANVAS_ASSET_ROUTE = pluginRoute('canvas-asset')
export const SUBSCRIPTION_LOGIN_ROUTE = pluginRoute('subscription-login')
export const SUBSCRIPTION_STATUS_ROUTE = pluginRoute('subscription-status')

/** Coarse model-facing kind of one shape on the workbench infinite canvas. */
export type CanvasNodeKind = 'image' | 'draw' | 'text' | 'note' | 'geo' | 'arrow' | 'frame' | 'other'

/** Every accepted canvas node kind, for validating untrusted pushes. */
export const CANVAS_NODE_KINDS: readonly CanvasNodeKind[] = ['image', 'draw', 'text', 'note', 'geo', 'arrow', 'frame', 'other']

/**
 * Cap on the selection identity list: the client trims `selection.items` to
 * this size and the canvas-state route rejects pushes carrying more, so the
 * two ends can never drift apart.
 */
export const CANVAS_MAX_SELECTION_ITEMS = 16

/**
 * Cap on the node inventory: the client trims `nodes` to this size and the
 * canvas-state route rejects pushes carrying more, so the two ends can never
 * drift apart. Sized to keep the model-facing digest compact.
 */
export const CANVAS_MAX_NODES = 48

/** Same shared-cap contract as CANVAS_MAX_NODES, for the selection kind list. */
export const CANVAS_MAX_SELECTION_KINDS = 8

/**
 * Cap on the generation prompt copied onto canvas image shapes and into the
 * model-facing summaries. The landing path truncates to this and the
 * canvas-state route rejects longer values, so the two ends can never drift.
 * The gallery keeps the full prompt; this is only the canvas-side digest view.
 */
export const CANVAS_MAX_PROMPT_CHARS = 120

/** One shape on the workbench infinite canvas, summarized for the model. */
export interface CanvasNodeSummary {
  kind: CanvasNodeKind
  /** Gallery id when the shape is a generated image landed from the bus. */
  galleryId?: string
  /** Conversation attachment id for generated images; edit_image can target it directly. */
  attachmentId?: string
  /** Complete host reference; remains usable after switching conversations. */
  attachment?: ImageAttachmentRef
  /** Human-facing label: image name, geo variant, or similar. */
  name?: string
  width?: number
  height?: number
  /** Short text preview for text-bearing shapes. */
  text?: string
  /**
   * Truncated generation prompt for landed generated images: the model can
   * reproduce or precisely vary a canvas image instead of guessing from pixels.
   */
  prompt?: string
  /** Provider id (e.g. "google") the landed image was generated with. */
  provider?: string
  /** Model (or ComfyUI workflow label) the landed image was generated with. */
  model?: string
}

/** What is currently selected on the canvas. */
export interface CanvasSelectionSummary {
  count: number
  kinds: readonly CanvasNodeKind[]
  /**
   * Capped identity list of the selected shapes, using the same summary shape
   * as canvas nodes: the model learns WHICH images or strokes are selected
   * (name, attachment id, dimensions), not just how many. Without this, two
   * selections of the same size and kind are indistinguishable.
   */
  items?: readonly CanvasNodeSummary[]
}

/**
 * One live state push from a browser tldraw instance of the workbench canvas.
 * The browser owns the canvas; the host keeps only this compact mirror, so
 * the conversation agent can reason about (and look at) what the user sees.
 */
export interface CanvasStatePush {
  /** Tldraw editor id; distinguishes simultaneously mounted canvases. */
  clientInstance: string
  /** False on the final push right before a canvas unmounts. */
  connected: boolean
  /** Total shape count on the current page (the node list may be capped). */
  nodeCount: number
  /** Capped shape inventory, capped client-side before transport. */
  nodes?: readonly CanvasNodeSummary[]
  selection?: CanvasSelectionSummary
  /**
   * PNG data-URL screenshot of the current selection, pushed whenever a
   * selection settles. It shows the selection as it looks on the canvas —
   * including annotations drawn over generated images — so the model sees the
   * live canvas state, not just the original conversation attachment.
   */
  selectionImage?: string
  /** Changes whenever the selection or its contents change. */
  selectionRevision?: string
  selectionStatus?: 'preparing' | 'ready' | 'error'
  selectionError?: string
  /** Monotonic per mounted editor, including its final disconnect. */
  sequence?: number
  updatedAt: number
}

/** Namespace persisted through DSH Settings. */
export const IMAGE_GENERATION_NAMESPACE = 'image-generation'

/**
 * Loader entry id of this plugin's composition entry (see cordis.patch.yml).
 * DSH 0.1.7 serves a plugin's settings under its entry id as the namespace,
 * so browser-side reads/writes bind `configForms` to this id.
 */
export const IMAGE_GENERATION_ENTRY_ID = 'image-gen'

/** Supported providers. */
export const IMAGE_PROVIDERS = ['google', 'openai', 'openai-compat', 'seedream', 'dashscope', 'xai', 'zhipu', 'comfyui', 'chatgpt-sub', 'grok-sub', 'google-sub'] as const
export type ImageProvider = typeof IMAGE_PROVIDERS[number]

/**
 * Providers that generate through a logged-in subscription account instead
 * of an API key. They use no credential reference and never join the
 * cloud/BYOK sets.
 */
export const SUBSCRIPTION_PROVIDERS = ['chatgpt-sub', 'grok-sub', 'google-sub'] as const
export type SubscriptionProvider = typeof SUBSCRIPTION_PROVIDERS[number]

/** True when the provider generates through a logged-in subscription account. */
export function isSubscriptionProvider(provider: ImageProvider): provider is SubscriptionProvider {
  return (SUBSCRIPTION_PROVIDERS as readonly string[]).includes(provider)
}

/** Providers supported by the first browser workbench release. */
export const CLOUD_IMAGE_PROVIDERS = ['google', 'openai', 'openai-compat', 'seedream', 'dashscope', 'xai', 'zhipu'] as const
export type CloudImageProvider = typeof CLOUD_IMAGE_PROVIDERS[number]

/** Normalize the relay model list while keeping the legacy default model selectable. */
export function resolveOpenAICompatModels(config: {
  openaiCompatModel?: string
  openaiCompatModels?: readonly string[]
}): string[] {
  const defaultModel = config.openaiCompatModel?.trim() ?? ''
  const models = [...new Set((config.openaiCompatModels ?? []).map(model => model.trim()).filter(Boolean))]
  if (defaultModel.length > 0 && !models.includes(defaultModel)) models.unshift(defaultModel)
  return models
}

export const DEFAULT_OPENAI_COMPAT_CHANNEL_ID = 'default'

export interface OpenAICompatChannel {
  id: string
  label: string
  keyRef: string
  baseURL: string
  model: string
  models?: string[]
  editModel?: string
  supportsGif?: boolean
  quality?: string
  qualityOptions?: string[]
  extraBody?: Record<string, unknown>
  editSizeMode?: 'auto' | 'selected'
  /** `modelscopeAsync` also switches generation to the async task flow (#140). */
  editFormat?: 'multipart' | 'jsonImageUrlArray' | 'formReferenceImages' | 'siliconflowJson' | 'modelscopeAsync'
  editExtra?: Record<string, unknown>
  sizes?: Record<string, Record<string, string>>
}

export interface OpenAICompatChannelSource {
  openaiCompatLabel?: string
  openaiCompatBaseURL?: string
  openaiCompatModel?: string
  openaiCompatModels?: readonly string[]
  openaiCompatSupportsGif?: boolean
  openaiCompatEditModel?: string
  openaiCompatQuality?: string
  openaiCompatQualityOptions?: readonly string[]
  openaiCompatExtraBody?: Record<string, unknown>
  openaiCompatEditSizeMode?: 'auto' | 'selected'
  openaiCompatEditFormat?: 'multipart' | 'jsonImageUrlArray' | 'formReferenceImages' | 'siliconflowJson' | 'modelscopeAsync'
  openaiCompatEditExtra?: Record<string, unknown>
  openaiCompatSizes?: Record<string, Record<string, string>>
  openaiCompatChannels?: readonly OpenAICompatChannel[]
  openaiCompatActiveChannel?: string
}

export function openAICompatKeyRef(channelId: string): string {
  return channelId === DEFAULT_OPENAI_COMPAT_CHANNEL_ID
    ? OPENAI_COMPAT_API_KEY_ENV
    : `${OPENAI_COMPAT_API_KEY_ENV}_${channelId.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`
}

/** The legacy flat fields remain the first channel; additional entries are fully independent. */
export function resolveOpenAICompatChannels(source: OpenAICompatChannelSource): OpenAICompatChannel[] {
  const legacy: OpenAICompatChannel = {
    id: DEFAULT_OPENAI_COMPAT_CHANNEL_ID,
    label: source.openaiCompatLabel?.trim() || 'OpenAI 兼容',
    keyRef: OPENAI_COMPAT_API_KEY_ENV,
    baseURL: source.openaiCompatBaseURL ?? '',
    model: source.openaiCompatModel ?? '',
    models: [...source.openaiCompatModels ?? []],
    ...(source.openaiCompatSupportsGif ? { supportsGif: true } : {}),
    editModel: source.openaiCompatEditModel ?? '',
    quality: source.openaiCompatQuality ?? '',
    qualityOptions: [...source.openaiCompatQualityOptions ?? []],
    extraBody: source.openaiCompatExtraBody ?? {},
    editSizeMode: source.openaiCompatEditSizeMode ?? 'auto',
    editFormat: source.openaiCompatEditFormat ?? 'multipart',
    editExtra: source.openaiCompatEditExtra ?? {},
    sizes: source.openaiCompatSizes ?? {},
  }
  const channels = [legacy]
  const seen = new Set([legacy.id])
  for (const [index, entry] of (source.openaiCompatChannels ?? []).entries()) {
    const id = typeof entry?.id === 'string' ? entry.id.trim() : ''
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id) || seen.has(id)) continue
    seen.add(id)
    const storedKeyRef = typeof entry.keyRef === 'string' ? entry.keyRef.trim() : ''
    channels.push({
      id,
      label: typeof entry.label === 'string' && entry.label.trim().length > 0 ? entry.label.trim() : `OpenAI 兼容 ${index + 2}`,
      keyRef: /^DSH_IMAGE_GEN_OPENAI_COMPAT_KEY_[A-Z0-9_]+$/.test(storedKeyRef) ? storedKeyRef : openAICompatKeyRef(id),
      baseURL: typeof entry.baseURL === 'string' ? entry.baseURL : '',
      model: typeof entry.model === 'string' ? entry.model : '',
      models: Array.isArray(entry.models) ? entry.models.filter((model): model is string => typeof model === 'string') : [],
      ...(entry.supportsGif === true ? { supportsGif: true } : {}),
      editModel: typeof entry.editModel === 'string' ? entry.editModel : '',
      quality: typeof entry.quality === 'string' ? entry.quality : '',
      qualityOptions: Array.isArray(entry.qualityOptions) ? entry.qualityOptions.filter((quality): quality is string => typeof quality === 'string') : [],
      extraBody: entry.extraBody ?? {},
      editSizeMode: entry.editSizeMode === 'selected' ? 'selected' : 'auto',
      editFormat: entry.editFormat ?? 'multipart',
      editExtra: entry.editExtra ?? {},
      sizes: entry.sizes ?? {},
    })
  }
  return channels
}

export function resolveOpenAICompatChannel(source: OpenAICompatChannelSource, channelId?: string): OpenAICompatChannel {
  const channels = resolveOpenAICompatChannels(source)
  const explicit = channelId?.trim() ?? ''
  if (explicit.length > 0) {
    const selected = channels.find(channel => channel.id === explicit)
    if (selected === undefined) throw new Error(`Unknown OpenAI-compatible channel "${explicit}". Available channels: ${channels.map(channel => channel.id).join(', ')}.`)
    return selected
  }
  const active = source.openaiCompatActiveChannel?.trim() ?? ''
  return channels.find(channel => channel.id === active) ?? channels[0]!
}

/**
 * Providers the browser workbench can drive: the BYOK cloud set plus the
 * logged-in subscription channels. ComfyUI stays out; it has its own workflow
 * pipeline and no shared request shape.
 */
export const STUDIO_PROVIDERS = [...CLOUD_IMAGE_PROVIDERS, ...SUBSCRIPTION_PROVIDERS] as const
export type StudioProvider = CloudImageProvider | SubscriptionProvider

export function studioTargetKey(provider: StudioProvider, channel?: string): string {
  return channel === undefined ? provider : `${provider}:${channel}`
}

/** True when the provider is selectable in the browser workbench. */
export function isStudioProvider(provider: ImageProvider): provider is StudioProvider {
  return (STUDIO_PROVIDERS as readonly string[]).includes(provider)
}

/** Default timeout for API-key cloud generation in the browser workbench. */
export const DEFAULT_CLOUD_TIMEOUT_MS = 150_000

/** Timeout for one subscription image call, shared by the tool path and the
 * studio route so neither drifts from the other. */
export const SUBSCRIPTION_TIMEOUT_MS = 300_000

/** OpenAI Images GIF output contract: frame count, per-frame delay, and the
 * longest edge of the sheet all frames are tiled into. */
export const GIF_FRAME_COUNT_MIN = 2
export const GIF_FRAME_COUNT_MAX = 16
export const GIF_FRAME_DURATION_MS_MIN = 20
export const GIF_FRAME_DURATION_MS_MAX = 2000
export const GIF_SHEET_MAX_EDGE = 3840

/** A GIF draws every frame in one image call, so it runs longer than a still; the host's HTTP client gives up on response headers after 300 s anyway. */
export const DEFAULT_GIF_TIMEOUT_MS = 300_000

/** The cloud timeout for a request: a GIF gets the longer GIF default while the cloud timeout is left at its default. */
export function cloudTimeoutFor(configuredMs: number | undefined, gif: boolean): number {
  const timeout = configuredMs ?? DEFAULT_CLOUD_TIMEOUT_MS
  return gif && timeout === DEFAULT_CLOUD_TIMEOUT_MS ? DEFAULT_GIF_TIMEOUT_MS : timeout
}

/**
 * Credential references resolved through the DSH Credentials service (BYOK).
 * These are POSIX-style reference names, not environment variables: the host
 * layers the process environment and its managed store behind them, so a name
 * like OPENAI_API_KEY is shared with any other plugin resolving the same ref.
 */
export const GOOGLE_API_KEY_ENV = 'GEMINI_API_KEY'
/** OpenAI Platform credential reference. */
export const OPENAI_API_KEY_ENV = 'OPENAI_API_KEY'
/**
 * OpenAI-compatible relay credential reference. Deliberately distinct from
 * OPENAI_API_KEY so an official key and a relay key can coexist without
 * overwriting each other.
 */
export const OPENAI_COMPAT_API_KEY_ENV = 'DSH_IMAGE_GEN_OPENAI_COMPAT_KEY'
/** Volcengine Ark credential reference. */
export const SEEDREAM_API_KEY_ENV = 'ARK_API_KEY'
/** DashScope credential reference. */
export const DASHSCOPE_API_KEY_ENV = 'DASHSCOPE_API_KEY'
/** xAI credential reference; matches the official xAI SDK environment name. */
export const XAI_API_KEY_ENV = 'XAI_API_KEY'
/** Zhipu credential reference; matches the official Zhipu SDK environment name. */
export const ZHIPU_API_KEY_ENV = 'ZHIPUAI_API_KEY'

/** The credential reference each cloud provider's API key is stored under. */
export const CLOUD_CREDENTIAL_REFS: Record<CloudImageProvider, string> = {
  google: GOOGLE_API_KEY_ENV,
  openai: OPENAI_API_KEY_ENV,
  'openai-compat': OPENAI_COMPAT_API_KEY_ENV,
  seedream: SEEDREAM_API_KEY_ENV,
  dashscope: DASHSCOPE_API_KEY_ENV,
  xai: XAI_API_KEY_ENV,
  zhipu: ZHIPU_API_KEY_ENV,
}

/** The credential reference storing this provider's API key, when it uses one. */
export function cloudCredentialRef(provider: ImageProvider): string | undefined {
  return (CLOUD_IMAGE_PROVIDERS as readonly string[]).includes(provider)
    ? CLOUD_CREDENTIAL_REFS[provider as CloudImageProvider]
    : undefined
}

/** Locale-neutral provider names for user-facing errors and status lines. */
export const PROVIDER_DISPLAY_NAMES: Record<ImageProvider, string> = {
  google: 'Google Gemini',
  openai: 'OpenAI',
  'openai-compat': 'OpenAI 兼容',
  seedream: 'Seedream',
  dashscope: 'DashScope',
  xai: 'xAI Grok',
  zhipu: '智谱 GLM',
  comfyui: 'ComfyUI',
  'chatgpt-sub': 'ChatGPT 订阅',
  'grok-sub': 'Grok 订阅',
  'google-sub': 'Google 订阅',
}

/** English provider names for English UI and English messages. */
export const PROVIDER_ENGLISH_NAMES: Record<ImageProvider, string> = {
  google: 'Google Gemini',
  openai: 'OpenAI',
  'openai-compat': 'OpenAI Compatible',
  seedream: 'Seedream',
  dashscope: 'DashScope',
  xai: 'xAI Grok',
  zhipu: 'Zhipu GLM',
  comfyui: 'ComfyUI',
  'chatgpt-sub': 'ChatGPT Subscription',
  'grok-sub': 'Grok Subscription',
  'google-sub': 'Google Subscription',
}

/** Default channel names are generated in Chinese; show them in the UI language. Names the user typed pass through. */
export function localizeChannelLabel(label: string, lang: 'zh' | 'en'): string {
  const match = lang === 'en' ? /^OpenAI 兼容(?: (\d+))?$/.exec(label) : null
  return match === null ? label : PROVIDER_ENGLISH_NAMES['openai-compat'] + (match[1] === undefined ? '' : ' ' + match[1])
}

/** Display names for the subscription providers, separate from the BYOK table. */
export const SUBSCRIPTION_PROVIDER_DISPLAY_NAMES: Record<SubscriptionProvider, string> = {
  'chatgpt-sub': 'ChatGPT 订阅',
  'grok-sub': 'Grok 订阅',
  'google-sub': 'Google 订阅',
}

/** One selectable output option exposed by a provider profile. */
export interface StudioOption {
  value: string
  label: string
}

export const STUDIO_WATERMARK_VALUES = ['default', 'off', 'on'] as const
export type StudioWatermark = typeof STUDIO_WATERMARK_VALUES[number]

export interface StudioWatermarkCapability {
  status: 'supported' | 'unknown' | 'unavailable'
  reason?: 'channel-unconfirmed' | 'model-unconfirmed' | 'account-unconfirmed' | 'edit-format' | 'no-api-control'
}

/** Browser-safe provider description. Credentials and endpoints never cross this boundary. */
export interface StudioProviderProfile {
  provider: StudioProvider
  /** OpenAI-compatible channel id; absent for every other provider. */
  channel?: string
  label: string
  model: string
  /** Separate configured edit model; absent preserves the generation model. */
  editModel?: string
  supportsGif?: boolean
  supportsGifEditing?: boolean
  /** Selectable generation models; absent means the single default model. */
  modelOptions?: StudioOption[]
  configured: boolean
  supportsEditing: boolean
  ratioOptions: StudioOption[]
  qualityOptions: StudioOption[]
  defaultRatio: string
  defaultQuality: string
  /** Independent pixel tiers for OpenAI-shaped APIs, keyed by ratio. */
  resolutionOptions?: Record<string, StudioOption[]>
  defaultResolution?: string
  /** Additional quality picker for compatible channels whose legacy quality means resolution. */
  generationQualityOptions?: StudioOption[]
  defaultGenerationQuality?: string
  /** Generation options retained for clients predating operation-specific capabilities. */
  watermarkOptions?: StudioOption[]
  watermarkCapabilities?: Record<'generate' | 'edit', StudioWatermarkCapability>
}

/** A model picker/request must use the same operation-specific default. */
export function studioModelForMode(profile: StudioProviderProfile, mode: 'generate' | 'edit'): string {
  return mode === 'edit' ? profile.editModel ?? profile.model : profile.model
}

export function studioModelOptionsForMode(profile: StudioProviderProfile, mode: 'generate' | 'edit'): StudioOption[] {
  if (mode === 'edit' && profile.editModel !== undefined) {
    return [{ value: profile.editModel, label: profile.editModel }]
  }
  return profile.modelOptions ?? [{ value: profile.model, label: profile.model }]
}

export function studioWatermarkCapability(profile: StudioProviderProfile | undefined, mode: 'generate' | 'edit'): StudioWatermarkCapability {
  return profile?.watermarkCapabilities?.[mode]
    ?? (mode === 'generate' && profile?.watermarkOptions?.length
      ? { status: 'supported' } : { status: 'unknown', reason: 'channel-unconfirmed' })
}

/** Lightweight workspace description exposed to the client for scoping. */
export interface StudioWorkspaceInfo {
  workspaceId: string
  path: string
  title: string
  sessionIds: string[]
}

/** Read model and capability state for the workbench without exposing secrets. */
export interface StudioConfigResponse {
  providers: StudioProviderProfile[]
  activeProvider: StudioProvider
  activeChannel?: string
  modelDiscoveryPending?: boolean
  workspaceRoot?: string | undefined
  workspaces?: StudioWorkspaceInfo[] | undefined
  /** Public tldraw SDK license key for the infinite canvas; absent when unset. */
  tldrawLicenseKey?: string | undefined
}

/** A browser-uploaded reference image used for one editing request. */
export interface StudioEncodedReference {
  mediaType: ImageMediaType
  data: string
  name?: string
}

/** A durable image reference selected from the existing gallery. */
export interface StudioAttachmentReference {
  attachment: ImageAttachmentRef
}

export type StudioReference = StudioEncodedReference | StudioAttachmentReference

/** Animated output for OpenAI-shaped providers; the frame ranges follow the GIF_FRAME_* constants. */
export interface GifOutputRequest {
  format: 'gif'
  frameCount?: number
  frameDurationMs?: number
  /** Single-frame size (`WIDTHxHEIGHT`); absent leaves it to the provider, never to the still-image table. */
  size?: string
}

/** One browser workbench generation or editing request. */
export interface StudioGenerateRequest {
  mode: 'generate' | 'edit'
  provider: StudioProvider
  channel?: string
  model: string
  prompt: string
  ratio: string
  quality: string
  /** Optional independent resolution; older clients continue using the legacy quality field. */
  resolution?: string
  generationQuality?: string
  watermark?: StudioWatermark
  /** Animated output; absent keeps the still-image request unchanged. */
  output?: GifOutputRequest
  reference?: StudioReference
  references?: StudioReference[]
  count?: number | undefined
  workspaceRoot?: string | undefined
}

/** One individual generated image item in a workbench batch. */
export interface StudioGeneratedItem {
  gifReturnedStill?: boolean
  attachment: ImageAttachmentRef
  output: string
  savedTo?: string | undefined
  /** Raw bytes kept in the vault when the attachment layer normalized an animated result. */
  original?: { key: string; bytes: number; mediaType: ImageMediaType } | undefined
}

/** One completed workbench request. */
export interface StudioGenerateResponse extends StudioGeneratedItem {
  provider: StudioProvider
  channel?: string
  model: string
  prompt: string
  createdAt: number
  elapsedMs: number
  items?: StudioGeneratedItem[] | undefined
  requestedCount?: number | undefined
  failedCount?: number | undefined
  errors?: Array<{ index: number; message: string }> | undefined
}

/** Default endpoints and base URLs. */
export const DEFAULT_GOOGLE_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions'
export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1'
export const DEFAULT_SEEDREAM_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'
export const DEFAULT_DASHSCOPE_ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1'
export const DEFAULT_XAI_BASE_URL = 'https://api.x.ai/v1'
export const DEFAULT_ZHIPU_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4'
export const DEFAULT_COMFYUI_BASE_URL = 'http://127.0.0.1:8188'
export const DEFAULT_COMFYUI_TIMEOUT_MS = 300_000
export const DEFAULT_COMFYUI_WORKFLOW_LABEL = 'API workflow'
export const MAX_COMFYUI_WORKFLOW_BYTES = 5 * 1024 * 1024

/** Content types Ark's Seedream endpoint can return. */
export const ARK_OUTPUT_FORMATS = ['png', 'jpeg'] as const
/** Whether Ark stamps an "AI generated" watermark on the result. */
export const ARK_BACKGROUND_MODES = ['opaque', 'transparent'] as const
export type ArkOutputFormat = typeof ARK_OUTPUT_FORMATS[number]
export type ArkBackgroundMode = typeof ARK_BACKGROUND_MODES[number]

/**
 * Ark (Seedream) output controls, shared by the generate and edit paths.
 *
 * Every field mirrors an Ark request-body field of the same meaning, and every
 * default below reproduces Ark's own default — so an untouched configuration
 * sends exactly what it sent before these options existed.
 */
export interface ArkOutputOptions {
  /** `output_format`. Ark defaults to `jpeg`; `png` is lossless and keeps an alpha channel. */
  outputFormat?: ArkOutputFormat
  /** `watermark`. Ark defaults to `true`, which bakes an "AI generated" mark into the image. */
  watermark?: boolean
  /** `background`. Ark defaults to `opaque`, or `auto` on Seedream 5.5. */
  background?: ArkBackgroundMode
}

/**
 * Map the Ark output controls onto request-body fields.
 *
 * `background` is opt-in per call site because text-to-image transparency
 * depends on the model. Seedream 5.5 accepts it; 5.0 pro / flash restrict
 * `transparent` to image-to-image with a single alpha-bearing reference and
 * reject the whole request otherwise:
 *
 *   text-to-image + transparent → 400 InvalidParameter
 *     "transparent background requires exactly one input image"
 *
 * The generation caller enables it via `seedreamGeneratesTransparent`.
 * Seedream 5.5 needs an explicit opaque selection because Ark defaults to auto.
 */
export function arkOutputBody(
  options: ArkOutputOptions | undefined,
  { background = true, explicitOpaque = false }: { background?: boolean; explicitOpaque?: boolean } = {},
): Record<string, unknown> {
  if (options === undefined) return {}
  const body: Record<string, unknown> = {}
  if (options.outputFormat !== undefined) body.output_format = options.outputFormat
  if (options.watermark !== undefined) body.watermark = options.watermark
  if (background && (options.background === 'transparent' || (explicitOpaque && options.background === 'opaque'))) body.background = options.background
  return body
}

/** Whether text-to-image accepts `background: transparent`: Seedream 5.5 only. */
export function seedreamGeneratesTransparent(model: string): boolean {
  return /seedream-5-5(?:-\d+)?$/.test(model)
}

/** Default model names. */
export const DEFAULT_GOOGLE_MODEL = 'gemini-3.1-flash-image'
export const DEFAULT_OPENAI_MODEL = 'gpt-image-2.6-flare'
export const DEFAULT_SEEDREAM_MODEL = 'doubao-seedream-5-0-pro-260628'

/**
 * Seedream models Volcano Ark retires on 2026-11-24 (batch 10), mapped to the
 * model that takes their requests. A saved settings value naming one of them
 * (the plugin's own former default among them) would start failing that day.
 */
const RETIRED_SEEDREAM_MODELS: Readonly<Record<string, string>> = {
  'doubao-seedream-5-0-260128': DEFAULT_SEEDREAM_MODEL,
  'doubao-seedream-5-0-lite-260128': DEFAULT_SEEDREAM_MODEL,
  'doubao-seedream-4-5-251128': DEFAULT_SEEDREAM_MODEL,
}

/** The Seedream model a request should use: a retired one is replaced, anything else is kept. */
export function currentSeedreamModel(model: string | undefined): string {
  const trimmed = model?.trim()
  if (trimmed === undefined || trimmed.length === 0) return DEFAULT_SEEDREAM_MODEL
  return RETIRED_SEEDREAM_MODELS[trimmed] ?? trimmed
}
export const DEFAULT_DASHSCOPE_MODEL = 'qwen-image-3.0'
export const DEFAULT_XAI_MODEL = 'grok-imagine-image-2.0'
export const DEFAULT_ZHIPU_MODEL = 'glm-image'

/** One named ComfyUI API-format workflow imported through settings. */
export interface ComfyUIWorkflowEntry {
  /** Unique human-readable label; used as the result model and by tool calls. */
  name: string
  /** API-format workflow JSON with {{prompt}} / {{seed}} and optional {{image}} placeholders. */
  json: string
  /** Optional preset prepended to the user prompt on every call of this workflow. */
  presetPrompt?: string
}

/** Raw ComfyUI workflow fields as persisted through DSH Settings. */
export interface ComfyUIWorkflowSource {
  /** Named workflows managed by the Web settings page. */
  comfyuiWorkflows?: readonly ComfyUIWorkflowEntry[]
  /** Name of the entry ComfyUI calls use by default. */
  comfyuiActiveWorkflow?: string
  /** Legacy single-workflow storage; synced to the active entry for downgrades. */
  comfyuiWorkflowJson?: string
  comfyuiWorkflowName?: string
}

/** Named workflows, falling back to the legacy single-workflow fields when the list is empty. */
export function resolveComfyUIWorkflows(source: ComfyUIWorkflowSource): ComfyUIWorkflowEntry[] {
  const named: ComfyUIWorkflowEntry[] = []
  for (const entry of source.comfyuiWorkflows ?? []) {
    const name = typeof entry?.name === 'string' ? entry.name.trim() : ''
    const json = typeof entry?.json === 'string' ? entry.json : ''
    if (name.length > 0 && json.trim().length > 0) {
      const presetPrompt = typeof entry.presetPrompt === 'string' ? entry.presetPrompt.trim() : ''
      named.push(presetPrompt.length > 0 ? { name, json, presetPrompt } : { name, json })
    }
  }
  if (named.length > 0) return named
  const legacyJson = typeof source.comfyuiWorkflowJson === 'string' ? source.comfyuiWorkflowJson : ''
  if (legacyJson.trim().length === 0) return []
  const legacyName = typeof source.comfyuiWorkflowName === 'string' ? source.comfyuiWorkflowName.trim() : ''
  return [{ name: legacyName.length > 0 ? legacyName : DEFAULT_COMFYUI_WORKFLOW_LABEL, json: legacyJson }]
}

/** The workflow ComfyUI calls use by default: the configured active name, else the first entry. */
export function activeComfyUIWorkflow(source: ComfyUIWorkflowSource): ComfyUIWorkflowEntry | undefined {
  const workflows = resolveComfyUIWorkflows(source)
  if (workflows.length === 0) return undefined
  const activeName = typeof source.comfyuiActiveWorkflow === 'string' ? source.comfyuiActiveWorkflow.trim() : ''
  return workflows.find(workflow => workflow.name === activeName) ?? workflows[0]
}

/** Derive a workflow label that does not collide with the given existing names. */
export function uniqueComfyUIWorkflowName(name: string, existing: readonly string[]): string {
  const base = name.trim().length > 0 ? name.trim() : DEFAULT_COMFYUI_WORKFLOW_LABEL
  if (!existing.includes(base)) return base
  for (let index = 2; ; index += 1) {
    const candidate = `${base} (${index})`
    if (!existing.includes(candidate)) return candidate
  }
}

/**
 * Combine a workflow's preset with the user prompt: preset first, user second,
 * joined by one comma — never doubled when the preset already ends in a
 * separator, and reduced to the non-empty side when the other is blank.
 */
export function mergeComfyUIPrompt(preset: string | undefined, user: string): string {
  const presetText = typeof preset === 'string' ? preset.trim().replace(/[,;\s]+$/, '') : ''
  const userText = user.trim()
  if (presetText.length === 0) return userText
  if (userText.length === 0) return presetText
  return `${presetText}, ${userText}`
}

/** Default models for the subscription channels; fixed by the bridge protocol. */
export const DEFAULT_SUBSCRIPTION_MODELS: Record<SubscriptionProvider, string> = {
  'chatgpt-sub': 'gpt-image-2.6-flare',
  'grok-sub': 'grok-imagine-image-2.0',
  'google-sub': 'gemini-3.1-flash-image',
}

export const DEFAULT_MODELS: Record<ImageProvider, string> = {
  google: DEFAULT_GOOGLE_MODEL,
  openai: DEFAULT_OPENAI_MODEL,
  // Relays expose arbitrary model ids; there is no sensible default to offer.
  'openai-compat': '',
  seedream: DEFAULT_SEEDREAM_MODEL,
  dashscope: DEFAULT_DASHSCOPE_MODEL,
  xai: DEFAULT_XAI_MODEL,
  zhipu: DEFAULT_ZHIPU_MODEL,
  comfyui: DEFAULT_COMFYUI_WORKFLOW_LABEL,
  'chatgpt-sub': DEFAULT_SUBSCRIPTION_MODELS['chatgpt-sub'],
  'grok-sub': DEFAULT_SUBSCRIPTION_MODELS['grok-sub'],
  'google-sub': DEFAULT_SUBSCRIPTION_MODELS['google-sub'],
}

/**
 * Official consoles where each API-key provider issues keys, linked next to
 * the key field (#109). Relays (openai-compat), ComfyUI and the subscription
 * channels have no single place to get one.
 */
export const API_KEY_CONSOLE_URLS: Partial<Record<ImageProvider, string>> = {
  google: 'https://aistudio.google.com/apikey',
  openai: 'https://platform.openai.com/api-keys',
  seedream: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
  dashscope: 'https://bailian.console.aliyun.com/',
  xai: 'https://console.x.ai/team/default/api-keys',
  zhipu: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
}

export const DEFAULT_BASE_URLS: Record<ImageProvider, string> = {
  google: DEFAULT_GOOGLE_ENDPOINT,
  openai: DEFAULT_OPENAI_BASE_URL,
  // Relay addresses are user-specific; empty until the compat row is filled in.
  'openai-compat': '',
  seedream: DEFAULT_SEEDREAM_BASE_URL,
  dashscope: DEFAULT_DASHSCOPE_ENDPOINT,
  xai: DEFAULT_XAI_BASE_URL,
  zhipu: DEFAULT_ZHIPU_BASE_URL,
  comfyui: DEFAULT_COMFYUI_BASE_URL,
  // Subscription channels call an in-process service, never a URL.
  'chatgpt-sub': '',
  'grok-sub': '',
  'google-sub': '',
}
