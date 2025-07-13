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
        const result = UserMessageSchema.safeParse(body);
        if (result.success) {
          if (!this.receivedMessages.has(data.body.message.id)) {
            this.receivedMessages.add(data.body.message.id);
            if (this.pendingMessageCallback) {
              this.pendingMessageCallback(result.data);
            } else {
              this.pendingMessages.push(result.data);
            }
          }
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
      message: {
        c: encrypted,
        t: 'encrypted'
      }
    });
  }

  async close() {
    this.socket.close();
  }
}