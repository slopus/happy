import axios from 'axios'
import { logger } from '@/ui/logger'
import type { AgentState, CreateSessionResponse, Metadata, Session, Machine, MachineMetadata, DaemonState } from '@/api/types'
import { ApiSessionClient } from './apiSession';
import { ApiMachineClient } from './apiMachine';
import { decodeBase64, encodeBase64, encrypt, decrypt } from './encryption';
import { PushNotificationClient } from './pushNotifications';
import { configuration } from '@/configuration';
import { Credentials } from '@/persistence';

import { resolveMachineEncryptionContext, resolveSessionEncryptionContext } from './client/encryptionKey';
import {
  shouldReturnMinimalMachineForGetOrCreateMachineError,
  shouldReturnNullForGetOrCreateSessionError,
} from './client/offlineErrors';

export class ApiClient {

  static async create(credential: Credentials) {
    return new ApiClient(credential);
  }

  private readonly credential: Credentials;
  private readonly pushClient: PushNotificationClient;

  private constructor(credential: Credentials) {
    this.credential = credential
    this.pushClient = new PushNotificationClient(credential.token, configuration.serverUrl)
  }

  /**
   * Create a new session or load existing one with the given tag
   */
  async getOrCreateSession(opts: {
    tag: string,
    metadata: Metadata,
    state: AgentState | null
  }): Promise<Session | null> {
    const { encryptionKey, encryptionVariant, dataEncryptionKey } = resolveSessionEncryptionContext(this.credential);

    // Create session
    try {
      const response = await axios.post<CreateSessionResponse>(
        `${configuration.serverUrl}/v1/sessions`,
        {
          tag: opts.tag,
          metadata: encodeBase64(encrypt(encryptionKey, encryptionVariant, opts.metadata)),
          agentState: opts.state ? encodeBase64(encrypt(encryptionKey, encryptionVariant, opts.state)) : null,
          dataEncryptionKey: dataEncryptionKey ? encodeBase64(dataEncryptionKey) : null,
        },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json'
          },
          timeout: 60000 // 1 minute timeout for very bad network connections
        }
      )

      logger.debug(`Session created/loaded: ${response.data.session.id} (tag: ${opts.tag})`)
      let raw = response.data.session;
      let session: Session = {
        id: raw.id,
        seq: raw.seq,
        metadata: decrypt(encryptionKey, encryptionVariant, decodeBase64(raw.metadata)),
        metadataVersion: raw.metadataVersion,
        agentState: raw.agentState ? decrypt(encryptionKey, encryptionVariant, decodeBase64(raw.agentState)) : null,
        agentStateVersion: raw.agentStateVersion,
        encryptionKey: encryptionKey,
        encryptionVariant: encryptionVariant
      }
      return session;
    } catch (error) {
      logger.debug('[API] [ERROR] Failed to get or create session:', error);

      if (shouldReturnNullForGetOrCreateSessionError(error, { url: `${configuration.serverUrl}/v1/sessions` })) {
        return null;
      }

      throw new Error(`Failed to get or create session: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Register or update machine with the server
   * Returns the current machine state from the server with decrypted metadata and daemonState
   */
  async getOrCreateMachine(opts: {
    machineId: string,
    metadata: MachineMetadata,
    daemonState?: DaemonState,
  }): Promise<Machine> {
    const { encryptionKey, encryptionVariant, dataEncryptionKey } = resolveMachineEncryptionContext(this.credential);

    // Helper to create minimal machine object for offline mode (DRY)
    const createMinimalMachine = (): Machine => ({
      id: opts.machineId,
      encryptionKey: encryptionKey,
      encryptionVariant: encryptionVariant,
      metadata: opts.metadata,
      metadataVersion: 0,
      daemonState: opts.daemonState || null,
      daemonStateVersion: 0,
    });

    // Create machine
    try {
      const response = await axios.post(
        `${configuration.serverUrl}/v1/machines`,
        {
          id: opts.machineId,
          metadata: encodeBase64(encrypt(encryptionKey, encryptionVariant, opts.metadata)),
          daemonState: opts.daemonState ? encodeBase64(encrypt(encryptionKey, encryptionVariant, opts.daemonState)) : undefined,
          dataEncryptionKey: dataEncryptionKey ? encodeBase64(dataEncryptionKey) : undefined
        },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json'
          },
          timeout: 60000 // 1 minute timeout for very bad network connections
        }
      );


      const raw = response.data.machine;
      logger.debug(`[API] Machine ${opts.machineId} registered/updated with server`);

      // Return decrypted machine like we do for sessions
      const machine: Machine = {
        id: raw.id,
        encryptionKey: encryptionKey,
        encryptionVariant: encryptionVariant,
        metadata: raw.metadata ? decrypt(encryptionKey, encryptionVariant, decodeBase64(raw.metadata)) : null,
        metadataVersion: raw.metadataVersion || 0,
        daemonState: raw.daemonState ? decrypt(encryptionKey, encryptionVariant, decodeBase64(raw.daemonState)) : null,
        daemonStateVersion: raw.daemonStateVersion || 0,
      };
      return machine;
    } catch (error) {
      if (shouldReturnMinimalMachineForGetOrCreateMachineError(error, { url: `${configuration.serverUrl}/v1/machines` })) {
        return createMinimalMachine();
      }

      // For other errors, rethrow
      throw error;
    }
  }

  sessionSyncClient(session: Session): ApiSessionClient {
    return new ApiSessionClient(this.credential.token, session);
  }

  machineSyncClient(machine: Machine): ApiMachineClient {
    return new ApiMachineClient(this.credential.token, machine);
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
            'Authorization': `Bearer ${this.credential.token}`,
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

  /**
   * Get vendor API token from the server
   * Returns the token if it exists, null otherwise
   */
  async getVendorToken(vendor: 'openai' | 'anthropic' | 'gemini'): Promise<any | null> {
    try {
      const response = await axios.get(
        `${configuration.serverUrl}/v1/connect/${vendor}/token`,
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json'
          },
          timeout: 5000
        }
      );

      if (response.status === 404) {
        logger.debug(`[API] No vendor token found for ${vendor}`);
        return null;
      }

      if (response.status !== 200) {
        throw new Error(`Server returned status ${response.status}`);
      }

      // Log raw response for debugging
      logger.debug(`[API] Raw vendor token response:`, {
        status: response.status,
        dataKeys: Object.keys(response.data || {}),
        hasToken: 'token' in (response.data || {}),
        tokenType: typeof response.data?.token,
      });

      // Token is returned as JSON string, parse it
      let tokenData: any = null;
      if (response.data?.token) {
        if (typeof response.data.token === 'string') {
          try {
            tokenData = JSON.parse(response.data.token);
          } catch (parseError) {
            logger.debug(`[API] Failed to parse token as JSON, using as string:`, parseError);
            tokenData = response.data.token;
          }
        } else if (response.data.token !== null) {
          // Token exists and is not null
          tokenData = response.data.token;
        } else {
          // Token is explicitly null - treat as not found
          logger.debug(`[API] Token is null for ${vendor}, treating as not found`);
          return null;
        }
      } else if (response.data && typeof response.data === 'object') {
        // Maybe the token is directly in response.data
        // But check if it's { token: null } - treat as not found
        if (response.data.token === null && Object.keys(response.data).length === 1) {
          logger.debug(`[API] Response contains only null token for ${vendor}, treating as not found`);
          return null;
        }
        tokenData = response.data;
      }
      
      // Final check: if tokenData is null or { token: null }, return null
      if (tokenData === null || (tokenData && typeof tokenData === 'object' && tokenData.token === null && Object.keys(tokenData).length === 1)) {
        logger.debug(`[API] Token data is null for ${vendor}`);
        return null;
      }
      
      logger.debug(`[API] Vendor token for ${vendor} retrieved successfully`, {
        tokenDataType: typeof tokenData,
        tokenDataKeys: tokenData && typeof tokenData === 'object' ? Object.keys(tokenData) : 'not an object',
      });
      return tokenData;
    } catch (error: any) {
      if (error.response?.status === 404) {
        logger.debug(`[API] No vendor token found for ${vendor}`);
        return null;
      }
      logger.debug(`[API] [ERROR] Failed to get vendor token:`, error);
      return null;
    }
  }
}
