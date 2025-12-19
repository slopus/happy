import axios from 'axios'
import { logger } from '@/ui/logger'
import type { AgentState, CreateSessionResponse, Metadata, Session, Machine, MachineMetadata, DaemonState } from '@/api/types'
import { ApiSessionClient } from './apiSession';
import { ApiMachineClient } from './apiMachine';
import { decodeBase64, encodeBase64, getRandomBytes, encrypt, decrypt, libsodiumEncryptForPublicKey } from './encryption';
import { PushNotificationClient } from './pushNotifications';
import { configuration } from '@/configuration';
import chalk from 'chalk';
import { Credentials } from '@/persistence';

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
  }): Promise<Session> {

    // Resolve encryption key
    let dataEncryptionKey: Uint8Array | null = null;
    let encryptionKey: Uint8Array;
    let encryptionVariant: 'legacy' | 'dataKey';
    if (this.credential.encryption.type === 'dataKey') {

      // Generate new encryption key
      encryptionKey = getRandomBytes(32);
      encryptionVariant = 'dataKey';

      // Derive and encrypt data encryption key
      // const contentDataKey = await deriveKey(this.secret, 'Happy EnCoder', ['content']);
      // const publicKey = libsodiumPublicKeyFromSecretKey(contentDataKey);
      let encryptedDataKey = libsodiumEncryptForPublicKey(encryptionKey, this.credential.encryption.publicKey);
      dataEncryptionKey = new Uint8Array(encryptedDataKey.length + 1);
      dataEncryptionKey.set([0], 0); // Version byte
      dataEncryptionKey.set(encryptedDataKey, 1); // Data key
    } else {
      encryptionKey = this.credential.encryption.secret;
      encryptionVariant = 'legacy';
    }

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

    // Resolve encryption key
    let dataEncryptionKey: Uint8Array | null = null;
    let encryptionKey: Uint8Array;
    let encryptionVariant: 'legacy' | 'dataKey';
    if (this.credential.encryption.type === 'dataKey') {
      // Encrypt data encryption key
      encryptionVariant = 'dataKey';
      encryptionKey = this.credential.encryption.machineKey;
      let encryptedDataKey = libsodiumEncryptForPublicKey(this.credential.encryption.machineKey, this.credential.encryption.publicKey);
      dataEncryptionKey = new Uint8Array(encryptedDataKey.length + 1);
      dataEncryptionKey.set([0], 0); // Version byte
      dataEncryptionKey.set(encryptedDataKey, 1); // Data key
    } else {
      // Legacy encryption
      encryptionKey = this.credential.encryption.secret;
      encryptionVariant = 'legacy';
    }

    // Create machine
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
      encryptionKey: encryptionKey,
      encryptionVariant: encryptionVariant,
      metadata: raw.metadata ? decrypt(encryptionKey, encryptionVariant, decodeBase64(raw.metadata)) : null,
      metadataVersion: raw.metadataVersion || 0,
      daemonState: raw.daemonState ? decrypt(encryptionKey, encryptionVariant, decodeBase64(raw.daemonState)) : null,
      daemonStateVersion: raw.daemonStateVersion || 0,
    };
    return machine;
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
