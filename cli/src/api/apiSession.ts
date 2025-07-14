import { logger } from '@/ui/logger'
import { EventEmitter } from 'node:events'
import { io, Socket } from 'socket.io-client'
import { ClientToServerEvents, MessageContent, ServerToClientEvents, Update, UserMessage, UserMessageSchema } from './types'
import { decodeBase64, decrypt, encodeBase64, encrypt } from './encryption';

export class ApiSessionClient extends EventEmitter {
  private readonly token: string;
  private readonly secret: Uint8Array;
  private readonly sessionId: string;
  private socket: Socket<ServerToClientEvents, ClientToServerEvents>;
  private receivedMessages = new Set<string>();
  private pendingMessages: UserMessage[] = [];
  private pendingMessageCallback: ((message: UserMessage) => void) | null = null;

  constructor(token: string, secret: Uint8Array, sessionId: string) {
    super()
    this.token = token;
    this.secret = secret;
    this.sessionId = sessionId;

    //
    // Create socket
    //

    this.socket = io('https://handy-api.korshakov.org', {
      auth: {
        token: this.token
      },
      path: '/v1/updates',
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      transports: ['websocket'],
      withCredentials: true,
      autoConnect: false
    });

    //
    // Handlers
    //

    this.socket.on('connect', () => {
      logger.info('Socket connected successfully');
    })

    this.socket.on('disconnect', (reason) => {
      logger.warn('Socket disconnected:', reason);
    })

    this.socket.on('connect_error', (error) => {
      logger.error('Socket connection error:', error.message);
    })

    // Server events
    this.socket.on('update', (data: Update) => {
      if (data.body.t === 'new-message' && data.body.message.content.t === 'encrypted') {
        const body = decrypt(decodeBase64(data.body.message.content.c), this.secret);
        
        // Try to parse as user message first
        const userResult = UserMessageSchema.safeParse(body);
        if (userResult.success) {
          if (!this.receivedMessages.has(data.body.message.id)) {
            this.receivedMessages.add(data.body.message.id);
            if (this.pendingMessageCallback) {
              this.pendingMessageCallback(userResult.data);
            } else {
              this.pendingMessages.push(userResult.data);
            }
          }
        } else {
          // If not a user message, it might be a permission response or other message type
          this.emit('message', body);
        }
      }
    });

    //
    // Connect (after short delay to give a time to add handlers)
    //

    this.socket.connect();
  }

  onUserMessage(callback: (data: UserMessage) => void) {
    this.pendingMessageCallback = callback;
    while (this.pendingMessages.length > 0) {
      callback(this.pendingMessages.shift()!);
    }
  }

  /**
   * Send message to session
   * @param body - Message body
   */
  sendMessage(body: any) {
    let content: MessageContent = {
      role: 'agent',
      content: body
    };
    const encrypted = encodeBase64(encrypt(content, this.secret));
    this.socket.emit('message', {
      sid: this.sessionId,
      message: encrypted
    });
  }

  /**
   * Send a ping message to keep the connection alive
   */
  keepAlive(thinking: boolean) {
    this.socket.volatile.emit('session-alive', { sid: this.sessionId, time: Date.now(), thinking });
  }

  /**
   * Send session death message
   */
  sendSessionDeath() {
    this.socket.emit('session-end', { sid: this.sessionId, time: Date.now() });
  }

  /**
   * Wait for socket buffer to flush
   */
  async flush(): Promise<void> {
    if (!this.socket.connected) {
      return;
    }
    return new Promise((resolve) => {
      this.socket.emitWithAck('ping', () => {
        resolve();
      });
      setTimeout(() => {
        resolve();
      }, 10000);
    });
  }

  async close() {
    this.socket.close();
  }
}