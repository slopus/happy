import { logger } from '@/ui/logger'
import { EventEmitter } from 'node:events'
import { io, Socket } from 'socket.io-client'
import { ClientToServerEvents, MessageContent, ServerToClientEvents, Update, UserMessage } from './types'
import { decodeBase64, decrypt, encodeBase64, encrypt } from './encryption';

export class ApiSessionClient extends EventEmitter {
  private readonly token: string;
  private readonly secret: Uint8Array;
  private readonly sessionId: string;
  private socket: Socket<ServerToClientEvents, ClientToServerEvents>;

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
      logger.debug('Received update:', data);
    });

    //
    // Connect (after short delay to give a time to add handlers)
    //

    setTimeout(() => this.socket.connect(), 100);
  }

  onMessage(callback: (data: UserMessage) => void) {
    this.socket.on('update', (data: Update) => {
      logger.debug('Received update:', data);
      if (data.body.t === 'new-message' && data.body.c.t === 'encrypted') {
        const body = decrypt(decodeBase64(data.body.c.c), this.secret);
        if (body.role === 'user') {
          callback(body);
        }
      }
    });
  }

  /**
   * Send message to session
   * @param body - Message body
   */
  sendMessage(body: any) {
    let content: MessageContent = {
      role: 'agent',
      body
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
}