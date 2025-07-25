import { z } from 'zod';
import { Alert } from 'react-native';
import { Audio } from 'expo-av';
import InCallManager from 'react-native-incall-manager';
import {
  mediaDevices,
  RTCPeerConnection,
  MediaStream,
  RTCView,
} from 'react-native-webrtc';

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
}

interface SessionControls {
  end: () => void;
  toggleMute: () => void;
  isActive: boolean;
  isMuted: boolean;
  transcript: string;
}

export async function createRealtimeSession(config: SessionConfig): Promise<SessionControls> {
  const EPHEMERAL_KEY = process.env.EXPO_PUBLIC_OPENAI_API_KEY;
  if (!EPHEMERAL_KEY) {
    throw new Error('EXPO_PUBLIC_OPENAI_API_KEY is not set');
  }

  let peerConnection: RTCPeerConnection | null = null;
  let dataChannel: any | null = null;
  let localMediaStream: MediaStream | null = null;
  let isActive = false;
  let isMuted = false;
  let transcript = '';
  let updateCallback: (() => void) | null = null;

  // Enable audio
  await Audio.setAudioModeAsync({ playsInSilentModeIOS: true });
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
  const model = 'gpt-4o-realtime-preview-2024-12-17';
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

  // Return control functions
  const controls: SessionControls = {
    end: () => {
      InCallManager.stop();
      if (dataChannel) dataChannel.close();
      if (peerConnection) peerConnection.close();
      if (localMediaStream) {
        localMediaStream.getTracks().forEach(track => track.stop());
      }
      isActive = false;
      updateCallback?.();
    },
    toggleMute: () => {
      if (localMediaStream) {
        const audioTrack = localMediaStream.getAudioTracks()[0];
        if (audioTrack) {
          audioTrack.enabled = !audioTrack.enabled;
          isMuted = !audioTrack.enabled;
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

  return controls;
}