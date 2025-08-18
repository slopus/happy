import axios from 'axios'
import { logger } from '@/ui/logger'
import type { AgentState, CreateSessionResponse, Metadata, Session, MachineMetadata, MachineResponse } from '@/api/types'
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
          },
          timeout: 5000 // 5 second timeout
        }
      )

      logger.debug(`Session created/loaded: ${response.data.session.id} (tag: ${opts.tag})`)
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
   * Get machine by ID from the server
   * Returns the current machine state from the server with decrypted metadata
   */
  async getMachine(machineId: string): Promise<{
    id: string;
    metadata: MachineMetadata | null;
    metadataVersion: number;
    seq: number;
    active: boolean;
    lastActiveAt: number;
    createdAt: number;
    updatedAt: number;
  } | null> {
    const response = await axios.get(`${configuration.serverUrl}/v1/machines/${machineId}`, {
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      timeout: 2000
    });

    const raw = response.data.machine;
    if (!raw) {
      return null;
    }

    logger.debug(`[API] Machine ${machineId} fetched from server`);

    // Decrypt metadata like we do for sessions
    const machine = {
      id: raw.id,
      metadata: raw.metadata ? decrypt(decodeBase64(raw.metadata), this.secret) : null,
      metadataVersion: raw.metadataVersion,
      seq: raw.seq,
      active: raw.active,
      lastActiveAt: raw.lastActiveAt,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt
    };
    return machine;
  }

  /**
   * Register or update machine with the server
   * Returns the current machine state from the server with decrypted metadata
   */
  async createOrUpdateMachine(machineId: string, metadata: MachineMetadata): Promise<{
    id: string;
    metadata: MachineMetadata | null;
    metadataVersion: number;
    seq: number;
    active: boolean;
    lastActiveAt: number;
    createdAt: number;
    updatedAt: number;
  }> {
    const response = await axios.post(
      `${configuration.serverUrl}/v1/machines`,
      {
        id: machineId,
        metadata: encodeBase64(encrypt(metadata, this.secret))
      },
      {
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json'
        },
        timeout: 5000
      }
    );

    const raw = response.data.machine;
    logger.debug(`[API] Machine ${machineId} registered/updated with server`);

    // Return decrypted machine like we do for sessions
    const machine = {
      id: raw.id,
      metadata: raw.metadata ? decrypt(decodeBase64(raw.metadata), this.secret) : null,
      metadataVersion: raw.metadataVersion,
      seq: raw.seq,
      active: raw.active,
      lastActiveAt: raw.lastActiveAt,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt
    };
    return machine;
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
