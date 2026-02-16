/**
 * StepFun Audio Recorder for Web
 * Uses Web Audio API with AudioWorklet for real-time audio capture
 * Outputs base64 encoded PCM16 audio chunks
 */

import { STEPFUN_CONSTANTS } from './constants';

export interface AudioRecorderCallbacks {
    onAudioData: (base64Audio: string) => void;
    onError: (error: Error) => void;
}

export class StepFunAudioRecorder {
    private audioContext: AudioContext | null = null;
    private isRecording: boolean = false;
    private isPaused: boolean = false;
    private isMuted: boolean = false;
    private callbacks: AudioRecorderCallbacks;
    private mediaStream: MediaStream | null = null;
    private workletNode: AudioWorkletNode | null = null;
    private sourceNode: MediaStreamAudioSourceNode | null = null;

    constructor(callbacks: AudioRecorderCallbacks) {
        this.callbacks = callbacks;
    }

    async start(): Promise<void> {
        if (this.isRecording) {
            console.warn('[StepFunAudioRecorder] Already recording');
            return;
        }

        try {
            console.log('[StepFunAudioRecorder] Starting recording...');

            // Create audio context with target sample rate
            this.audioContext = new AudioContext({
                sampleRate: STEPFUN_CONSTANTS.AUDIO.SAMPLE_RATE,
            });

            // Load AudioWorklet processor
            await this.audioContext.audioWorklet.addModule(
                this.createWorkletProcessorURL()
            );

            // Get microphone stream
            this.mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    sampleRate: STEPFUN_CONSTANTS.AUDIO.SAMPLE_RATE,
                    channelCount: STEPFUN_CONSTANTS.AUDIO.CHANNELS,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                },
            });

            // Create source from microphone
            this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);

            // Create worklet node
            this.workletNode = new AudioWorkletNode(this.audioContext, 'stepfun-pcm16-processor');

            this.workletNode.port.onmessage = (event: MessageEvent) => {
                if (!this.isRecording || this.isPaused || this.isMuted) return;

                const pcm16Data = event.data as Uint8Array;
                const base64Audio = this.uint8ArrayToBase64(pcm16Data);
                this.callbacks.onAudioData(base64Audio);
            };

            // Connect pipeline
            this.sourceNode.connect(this.workletNode);
            // Note: We don't connect to destination to avoid echo
            // this.workletNode.connect(this.audioContext.destination);

            this.isRecording = true;
            console.log('[StepFunAudioRecorder] Recording started');
        } catch (error) {
            console.error('[StepFunAudioRecorder] Failed to start recording:', error);
            this.callbacks.onError(error as Error);
            this.cleanup();
        }
    }

    stop(): void {
        if (!this.isRecording) {
            return;
        }

        console.log('[StepFunAudioRecorder] Stopping recording...');
        this.isRecording = false;
        this.cleanup();
        console.log('[StepFunAudioRecorder] Recording stopped');
    }

    /**
     * Pause sending audio data (recorder keeps running to avoid restart latency)
     */
    pause(): void {
        if (this.isPaused) return;
        console.log('[StepFunAudioRecorder] Pausing audio capture');
        this.isPaused = true;
    }

    /**
     * Resume sending audio data
     */
    resume(): void {
        if (!this.isPaused) return;
        console.log('[StepFunAudioRecorder] Resuming audio capture');
        this.isPaused = false;
    }

    /**
     * Set user mute state (independent of AI pause)
     */
    setMuted(muted: boolean): void {
        console.log(`[StepFunAudioRecorder] Setting muted: ${muted}`);
        this.isMuted = muted;
    }

    getIsMuted(): boolean {
        return this.isMuted;
    }

    private cleanup(): void {
        if (this.workletNode) {
            this.workletNode.disconnect();
            this.workletNode.port.onmessage = null;
            this.workletNode = null;
        }

        if (this.sourceNode) {
            this.sourceNode.disconnect();
            this.sourceNode = null;
        }

        if (this.mediaStream) {
            this.mediaStream.getTracks().forEach(track => track.stop());
            this.mediaStream = null;
        }

        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
    }

    /**
     * Create inline AudioWorklet processor as Blob URL
     */
    private createWorkletProcessorURL(): string {
        const bufferSize = STEPFUN_CONSTANTS.AUDIO.FRAME_SIZE;
        const processorCode = `
            class StepFunPCM16Processor extends AudioWorkletProcessor {
                constructor() {
                    super();
                    this.buffer = new Float32Array(${bufferSize});
                    this.bufferIndex = 0;
                }

                process(inputs, outputs, parameters) {
                    const input = inputs[0];
                    if (!input || input.length === 0) return true;

                    const channelData = input[0];
                    if (!channelData) return true;

                    for (let i = 0; i < channelData.length; i++) {
                        this.buffer[this.bufferIndex++] = channelData[i];

                        if (this.bufferIndex >= this.buffer.length) {
                            // Convert to PCM16
                            const pcm16 = new Int16Array(this.buffer.length);
                            for (let j = 0; j < this.buffer.length; j++) {
                                const s = Math.max(-1, Math.min(1, this.buffer[j]));
                                pcm16[j] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                            }

                            // Send to main thread
                            this.port.postMessage(new Uint8Array(pcm16.buffer));
                            this.bufferIndex = 0;
                        }
                    }

                    return true;
                }
            }

            registerProcessor('stepfun-pcm16-processor', StepFunPCM16Processor);
        `;

        const blob = new Blob([processorCode], { type: 'application/javascript' });
        return URL.createObjectURL(blob);
    }

    /**
     * Convert Uint8Array to base64 string
     */
    private uint8ArrayToBase64(uint8Array: Uint8Array): string {
        let binary = '';
        const len = uint8Array.byteLength;
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(uint8Array[i]);
        }
        return btoa(binary);
    }

    getIsRecording(): boolean {
        return this.isRecording;
    }
}
