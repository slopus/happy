import axios from 'axios'
import { logger } from '@/ui/logger'
import type { AgentState, CreateSessionResponse, Metadata, Session, Machine, MachineMetadata, DaemonState } from '@/api/types'
import { ApiSessionClient } from './apiSession';
import { ApiMachineClient } from './apiMachine';
import { decodeBase64, decrypt, encodeBase64, encrypt } from './encryption';
import { PushNotificationClient } from './pushNotifications';
import { configuration } from '@/configuration';
import chalk from 'chalk';

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
   * Returns the current machine state from the server with decrypted metadata and daemonState
   */
  async getMachine(machineId: string): Promise<Machine | null> {
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

    // Decrypt metadata and daemonState like we do for sessions
    const machine: Machine = {
      id: raw.id,
      metadata: raw.metadata ? decrypt(decodeBase64(raw.metadata), this.secret) : null,
      metadataVersion: raw.metadataVersion || 0,
      daemonState: raw.daemonState ? decrypt(decodeBase64(raw.daemonState), this.secret) : null,
      daemonStateVersion: raw.daemonStateVersion || 0,
      active: raw.active,
      activeAt: raw.activeAt,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt
    };
    return machine;
  }

  /**
   * Register or update machine with the server
   * Returns the current machine state from the server with decrypted metadata and daemonState
   */
  async createMachineOrGetExistingAsIs(opts: {
    machineId: string,
    metadata: MachineMetadata,
    daemonState?: DaemonState
  }): Promise<Machine> {
    const response = await axios.post(
      `${configuration.serverUrl}/v1/machines`,
      {
        id: opts.machineId,
        metadata: encodeBase64(encrypt(opts.metadata, this.secret)),
        daemonState: opts.daemonState ? encodeBase64(encrypt(opts.daemonState, this.secret)) : undefined
      },
      {
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json'
        },
        timeout: 5000
      }
    );

    if (response.status !== 200) {
      console.error(chalk.red(`[API] Failed to create machine: ${response.statusText}`));
      console.log(chalk.yellow(`[API] Failed to create machine: ${response.statusText}, most likely you have re-authenticated, but you still have a machine associated with the old account. Now we are trying to re-associate the machine with the new account. That is not allowed. Please run 'happy doctor clean' to clean up your happy state, and try your original command again. Please create an issue on github if this is causing you problems. We apologize for the inconvenience.`));
      process.exit(1);
    }

    const raw = response.data.machine;
    logger.debug(`[API] Machine ${opts.machineId} registered/updated with server`);

    // Return decrypted machine like we do for sessions
    const machine: Machine = {
      id: raw.id,
      metadata: raw.metadata ? decrypt(decodeBase64(raw.metadata), this.secret) : null,
      metadataVersion: raw.metadataVersion || 0,
      daemonState: raw.daemonState ? decrypt(decodeBase64(raw.daemonState), this.secret) : null,
      daemonStateVersion: raw.daemonStateVersion || 0,
      active: raw.active,
      activeAt: raw.activeAt,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt
    };
    return machine;
  }

  sessionSyncClient(session: Session): ApiSessionClient {
    return new ApiSessionClient(this.token, this.secret, session);
  }

  machineSyncClient(machine: Machine): ApiMachineClient {
    return new ApiMachineClient(this.token, this.secret, machine);
  }

  push(): PushNotificationClient {
    return this.pushClient;
  }

  /**
   * Register a vendor API token with the server
   * The token is sent as a JSON string - server handles encryption
   */
  async registerVendorToken(vendor: 'openai' | 'anthropic' | 'gemini', apiKey: any): Promise<void> {
    try {
      const response = await axios.post(
        `${configuration.serverUrl}/v1/connect/${vendor}/register`,
        {
          token: JSON.stringify(apiKey)
        },
        {
          headers: {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json'
          },
          timeout: 5000
        }
      );

      if (response.status !== 200 && response.status !== 201) {
        throw new Error(`Server returned status ${response.status}`);
      }

      logger.debug(`[API] Vendor token for ${vendor} registered successfully`);
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to register vendor token:`, error);
      throw new Error(`Failed to register vendor token: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}
