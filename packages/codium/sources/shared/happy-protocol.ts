export type HappyAuthStatus =
    | 'starting'
    | 'unconfigured'
    | 'authenticating'
    | 'authenticated'
    | 'error'

export type HappyAuthMethod = 'link-device' | 'create-account' | 'restore-secret'

export interface HappyAuthFlowSnapshot {
    method: HappyAuthMethod
    authUrl?: string
    publicKey?: string
    startedAt: number
}

export interface HappyStateSnapshot {
    status: HappyAuthStatus
    serverUrl: string
    webappUrl: string
    clientReady: boolean
    accountId?: string
    tokenExpiresAt?: number
    authFlow?: HappyAuthFlowSnapshot
    error?: string
    updatedAt: number
}

export interface HappyAuthenticatedClientStatus {
    ready: boolean
    serverUrl: string
    accountId?: string
    anonId?: string
    contentPublicKey?: string
}

export type HappyWorkerRequest =
    | { kind: 'getState' }
    | { kind: 'createAccount' }
    | { kind: 'startLinkDevice' }
    | { kind: 'restoreSecret'; secretKey: string }
    | { kind: 'cancelAuth' }
    | { kind: 'logout' }
    | { kind: 'clientStatus' }

export type HappyWorkerRequestWithId = HappyWorkerRequest & { requestId: string }

export type HappyWorkerResponse =
    | {
          kind: 'response'
          requestId: string
          ok: true
          state: HappyStateSnapshot
          value?: unknown
      }
    | {
          kind: 'response'
          requestId: string
          ok: false
          state: HappyStateSnapshot
          error: string
      }

export type HappyWorkerStateMessage = {
    kind: 'state'
    state: HappyStateSnapshot
}

export type HappyWorkerFatalMessage = {
    kind: 'fatal'
    error: string
}

export type HappyWorkerMessage =
    | HappyWorkerResponse
    | HappyWorkerStateMessage
    | HappyWorkerFatalMessage
