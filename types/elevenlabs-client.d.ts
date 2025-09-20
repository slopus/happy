// Type declarations for ElevenLabs client missing modules
declare module '@elevenlabs/client/dist/utils/connection' {
  export interface Connection {
    // Add basic connection interface
    [key: string]: any;
  }

  export const connection: Connection;
}

declare module '@elevenlabs/client/dist/utils/events' {
  export interface EventHandler {
    [key: string]: any;
  }

  export const events: EventHandler;
}

declare module '@elevenlabs/client/dist/utils/input' {
  export interface InputHandler {
    [key: string]: any;
  }

  export const input: InputHandler;
}
