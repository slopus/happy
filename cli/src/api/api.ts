import axios from 'axios'
import { logger } from '@/ui/logger'
import type { AgentState, CreateSessionResponse, Metadata, Session } from '@/api/types'
import { ApiSessionClient } from './apiSession';
import { decodeBase64, decrypt, encodeBase64, encrypt } from './encryption';
import { PushNotificationClient } from './pushNotifications';
import { configuration } from '@/configuration';

export class ApiClient {
  private readonly token: string;
  private readonly secret: Uint8Array;
  private readonly pushClient: PushNotificationClient;

  constructor(token: string, secret: Uint8Array) {
    this.token = token
    this.secret = secret
    this.pushClient = new PushNotificationClient(token)
  }

  /**
   * Create a new session or load existing one with the given tag
   */
  async getOrCreateSession(opts: { tag: string, metadata: Metadata, state: AgentState | null }): Promise<Session> {
    try {
      const response = await axios.post<CreateSessionResponse>(
        `${configuration.serverUrl}/v1/sessions`,
        {
          tag: opts.tag,
          metadata: encodeBase64(encrypt(opts.metadata, this.secret)),
          agentState: opts.state ? encodeBase64(encrypt(opts.state, this.secret)) : null
        },
        {
          headers: {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json'
          }
        }
      )

      logger.info(`Session created/loaded: ${response.data.session.id} (tag: ${opts.tag})`)
      let raw = response.data.session;
      let session: Session = {
        id: raw.id,
        createdAt: raw.createdAt,
        updatedAt: raw.updatedAt,
        seq: raw.seq,
        metadata: decrypt(decodeBase64(raw.metadata), this.secret),
        metadataVersion: raw.metadataVersion,
        agentState: raw.agentState ? decrypt(decodeBase64(raw.agentState), this.secret) : null,
        agentStateVersion: raw.agentStateVersion
      }
      return session;
    } catch (error) {
      logger.debug('[API] [ERROR] Failed to get or create session:', error);
      throw new Error(`Failed to get or create session: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Start realtime session client
   * @param id - Session ID
   * @returns Session client
   */
  session(session: Session): ApiSessionClient {
    return new ApiSessionClient(this.token, this.secret, session);
  }

  /**
   * Get push notification client
   * @returns Push notification client
   */
  push(): PushNotificationClient {
    return this.pushClient;
  }
}