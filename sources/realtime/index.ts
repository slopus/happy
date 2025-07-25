import { z } from 'zod';
import { Alert } from 'react-native';
import * as Audio from 'expo-audio';
import InCallManager from 'react-native-incall-manager';
import {
  mediaDevices,
  RTCPeerConnection,
  MediaStream,
  RTCView,
} from 'react-native-webrtc';
import { Settings } from '@/sync/settings';

// Helper to convert Zod schema to OpenAI function schema
export function zodToOpenAIFunction<T extends z.ZodType>(
  name: string,
  description: string,
  parameters: T,
  fn: (args: z.infer<T>) => Promise<any>
): Tool {
  return {
    definition: {
      type: 'function' as const,
      name,
      description,
      parameters: {
        type: 'object',
        properties: parameters instanceof z.ZodObject 
          ? Object.fromEntries(
              Object.entries(parameters.shape).map(([key, schema]: [string, any]) => {
                const baseSchema: any = { type: getZodType(schema) };
                if (schema._def.description) {
                  baseSchema.description = schema._def.description;
                }
                if (schema instanceof z.ZodEnum) {
                  baseSchema.enum = (schema as any)._def.values;
                }
                return [key, baseSchema];
              })
            )
          : {},
        required: parameters instanceof z.ZodObject
          ? Object.keys(parameters.shape).filter(key => 
              !(parameters.shape[key] instanceof z.ZodOptional)
            )
          : []
      }
    },
    function: fn
  };
}

function getZodType(schema: z.ZodType): string {
  if (schema instanceof z.ZodString) return 'string';
  if (schema instanceof z.ZodNumber) return 'number';
  if (schema instanceof z.ZodBoolean) return 'boolean';
  if (schema instanceof z.ZodEnum) return 'string';
  if (schema instanceof z.ZodOptional) return getZodType((schema as any)._def.innerType);
  return 'string';
}

export type Tool = {
  definition: {
    type: 'function';
    name: string;
    description: string;
    parameters: {
      type: string;
      properties: Record<string, any>;
      required: string[];
    };
  };
  function: (args: any) => Promise<any>;
};
export type Tools = Record<string, Tool>;

interface SessionConfig {
  context: string;
  tools: Tools;
  settings: Settings
}

interface SessionControls {
  end: () => void;
  pushContent: (content: string) => void;
  toggleMute: () => void;
  isActive: boolean;
  isMuted: boolean;
  transcript: string;
}

// Global reference to ensure only one session at a time
// Fallback, should not be used
let globalActiveSession: SessionControls | null = null;

export async function createRealtimeSession(config: SessionConfig): Promise<SessionControls> {
  // Check for API key in environment variable first, then in secure storage
  let EPHEMERAL_KEY = process.env.EXPO_PUBLIC_OPENAI_API_KEY;
  
  if (!EPHEMERAL_KEY) {
    // Try to get from secure storage
    const storedKey = config.settings.inferenceOpenAIKey;
    if (storedKey) {
      EPHEMERAL_KEY = storedKey;
    }
  }
  
  if (!EPHEMERAL_KEY) {
    Alert.alert(
      'OpenAI API Key Required',
      'Please set your OpenAI API key in Settings to use voice control.',
      [{ text: 'OK' }]
    );
    throw new Error('OpenAI API key not configured');
  }
  
  // If there's already an active session, end it first
  if (globalActiveSession && globalActiveSession.isActive) {
    console.warn('Ending existing realtime session before creating a new one');
    globalActiveSession.end();
    globalActiveSession = null;
  }

  let peerConnection: RTCPeerConnection | null = null;
  let dataChannel: any | null = null;
  let localMediaStream: MediaStream | null = null;
  let isActive = false;
  let isMuted = false;
  let transcript = '';
  let updateCallback: (() => void) | null = null;
  let muteTimeout: ReturnType<typeof setTimeout> | null = null;

  // Enable audio
  await Audio.setAudioModeAsync({ playsInSilentMode: true, interruptionMode: 'doNotMix' });
  // Start InCallManager and force speaker
  InCallManager.start({ media: 'audio' });
  InCallManager.setForceSpeakerphoneOn(true);

  // Create a peer connection
  const pc = new RTCPeerConnection();
  
  // Set up event listeners
  (pc as any).onconnectionstatechange = () => {
    console.log('connectionstatechange', pc.connectionState);
  };

  // Add local audio track for microphone input
  const ms = await mediaDevices.getUserMedia({
    audio: true,
    video: false,
  });
  
  localMediaStream = ms;
  pc.addTrack(ms.getTracks()[0]);

  // Set up data channel for sending and receiving events
  const dc = pc.createDataChannel('oai-events');
  dataChannel = dc;

  // Attach event listeners to the data channel
  (dc as any).onmessage = async (e: any) => {
    const data = JSON.parse(e.data);
    console.log('dataChannel message', data);
    
    // Get transcript
    if (data.type === 'response.audio_transcript.done') {
      transcript = data.transcript;
      updateCallback?.();
    }
    
    // Handle function calls
    if (data.type === 'response.function_call_arguments.done') {
      const toolName = data.name;
      const tool = config.tools[toolName];
      
      if (tool) {
        console.log(`Calling function ${data.name} with ${data.arguments}`);
        const args = JSON.parse(data.arguments);
        const result = await tool.function(args);
        
        // Send function output back to OpenAI
        const event = {
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: data.call_id,
            output: JSON.stringify(result),
          },
        };
        dc.send(JSON.stringify(event));
        
        // Force a response
        dc.send(JSON.stringify({ type: 'response.create' }));
      }
    }
  };

  // Configure session when data channel opens
  (dc as any).onopen = () => {
    isActive = true;
    updateCallback?.();
    
    // Configure the session with tools
    const event = {
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        instructions: config.context,
        tools: Object.values(config.tools).map(tool => tool.definition),
      },
    };
    dc.send(JSON.stringify(event));
  };

  // Start the session using SDP
  const offer = await pc.createOffer({});
  await pc.setLocalDescription(offer);

  const baseUrl = 'https://api.openai.com/v1/realtime';
  const model = 'gpt-4o-realtime-preview-2025-06-03';
  const sdpResponse = await fetch(`${baseUrl}?model=${model}`, {
    method: 'POST',
    body: offer.sdp,
    headers: {
      Authorization: `Bearer ${EPHEMERAL_KEY}`,
      'Content-Type': 'application/sdp',
    },
  });

  const answer = {
    type: 'answer' as const,
    sdp: await sdpResponse.text(),
  };
  await pc.setRemoteDescription(answer);

  peerConnection = pc;

  // Helper function to end session
  const endSession = () => {
    if (muteTimeout) {
      clearTimeout(muteTimeout);
      muteTimeout = null;
    }
    InCallManager.stop();
    if (dataChannel) dataChannel.close();
    if (peerConnection) peerConnection.close();
    if (localMediaStream) {
      localMediaStream.getTracks().forEach(track => track.stop());
    }
    isActive = false;
    // Clear global reference
    if (globalActiveSession === controls) {
      globalActiveSession = null;
    }
    updateCallback?.();
  };

  // Return control functions
  const controls: SessionControls = {
    end: endSession,
    pushContent: (content: string) => {
      const event = {
        type: 'conversation.item.create',
        item: {
          type: 'message',
          // Assume its claude's response
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: content,
            }
          ],
        },
      };
      dc.send(JSON.stringify(event));
    },
    toggleMute: () => {
      if (localMediaStream) {
        const audioTrack = localMediaStream.getAudioTracks()[0];
        if (audioTrack) {
          audioTrack.enabled = !audioTrack.enabled;
          isMuted = !audioTrack.enabled;
          
          // Handle mute timeout
          if (isMuted) {
            // Start 1 minute timeout when muted
            muteTimeout = setTimeout(() => {
              console.log('Auto-disconnecting due to 1 minute mute timeout');
              endSession();
            }, 60 * 1000); // 1 minute
          } else {
            // Clear timeout when unmuted
            if (muteTimeout) {
              clearTimeout(muteTimeout);
              muteTimeout = null;
            }
          }
          
          updateCallback?.();
        }
      }
    },
    get isActive() { return isActive; },
    get isMuted() { return isMuted; },
    get transcript() { return transcript; },
  };

  // Hack to trigger re-renders when state changes
  (controls as any)._setUpdateCallback = (cb: () => void) => {
    updateCallback = cb;
  };

  // Set as the global active session
  globalActiveSession = controls;

  return controls;
}