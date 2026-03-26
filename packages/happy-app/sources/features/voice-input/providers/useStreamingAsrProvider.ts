import { useState, useRef, useCallback, useEffect } from 'react';
import { Platform } from 'react-native';
import { apiSocket } from '@/sync/apiSocket';
import { requestMicrophonePermission, showMicrophonePermissionDeniedAlert } from '@/utils/microphonePermissions';
import { encodeBase64 } from '@/encryption/base64';

export interface StreamingAsrProviderProps {
    onTextUpdate?: (text: string) => void;
    sessionId?: string;
}

export function useStreamingAsrProvider({ onTextUpdate, sessionId }: StreamingAsrProviderProps) {
    const [isListening, setIsListening] = useState(false);
    const audioContextRef = useRef<any>(null);
    const mediaStreamSourceRef = useRef<any>(null);
    const scriptProcessorRef = useRef<any>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const chunkCountRef = useRef<number>(0);
    const nativeRecorderRef = useRef<any>(null);
    const resultTextArrayRef = useRef<string[]>([]);
    const onTextUpdateRef = useRef(onTextUpdate);

    useEffect(() => {
        onTextUpdateRef.current = onTextUpdate;
    }, [onTextUpdate]);

    const toPcmBase64 = useCallback((pcmData: Int16Array) => {
        return encodeBase64(new Uint8Array(pcmData.buffer));
    }, []);

    const cleanupLegacyRecorder = useCallback(() => {
        if (nativeRecorderRef.current) {
            try {
                if (nativeRecorderRef.current.markAsStopped) {
                    nativeRecorderRef.current.markAsStopped();
                }
                nativeRecorderRef.current.stop();
                console.log('[ASR Frontend] Native Audio Recorder stopped');
                if (typeof nativeRecorderRef.current.disconnect === 'function') {
                    nativeRecorderRef.current.disconnect();
                    console.log('[ASR Frontend] Native Audio Recorder disconnected');
                }
            } catch (e) {
                console.warn('[ASR Frontend] Error stopping native recorder:', e);
            }
            nativeRecorderRef.current = null;
        }
    }, []);

    const cleanupBrowserAudio = useCallback(() => {
        if (scriptProcessorRef.current) {
            scriptProcessorRef.current.disconnect();
            scriptProcessorRef.current = null;
        }
        if (mediaStreamSourceRef.current) {
            mediaStreamSourceRef.current.disconnect();
            mediaStreamSourceRef.current = null;
        }
        if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
            audioContextRef.current.close();
            audioContextRef.current = null;
        }
        if (streamRef.current) {
            streamRef.current.getTracks().forEach(track => track.stop());
            streamRef.current = null;
        }
    }, []);

    const stopListening = useCallback(async (options?: { skipNativeStop?: boolean; skipBackendStop?: boolean }) => {
        console.log('[ASR Frontend] stopListening() 被调用，准备清理资源');
        setIsListening(false);
        chunkCountRef.current = 0;

        cleanupLegacyRecorder();
        cleanupBrowserAudio();

        if (!options?.skipBackendStop) {
            console.log('[ASR Frontend] 发送 asr_stop 到后端');
            apiSocket.send('asr_stop', { sessionId });
        }
    }, [cleanupBrowserAudio, cleanupLegacyRecorder, sessionId]);

    const startLegacyStreaming = useCallback(async () => {
        setIsListening(true);
        console.log('[ASR Frontend] 发送 asr_start 到后端');
        apiSocket.send('asr_start', { sessionId });

        if (Platform.OS === 'web') {
            console.log('[ASR Frontend] 正在获取 Web 麦克风音频流...');
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            console.log('[ASR Frontend] 麦克风权限已获取，获得音频流:', stream.id);
            streamRef.current = stream;

            const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
            audioContextRef.current = new AudioContextClass({
                sampleRate: 16000
            });
            console.log(`[ASR Frontend] AudioContext 初始化完成, 采样率: ${audioContextRef.current.sampleRate}`);

            mediaStreamSourceRef.current = audioContextRef.current.createMediaStreamSource(stream);
            scriptProcessorRef.current = audioContextRef.current.createScriptProcessor(1024, 1, 1);

            mediaStreamSourceRef.current.connect(scriptProcessorRef.current);
            scriptProcessorRef.current.connect(audioContextRef.current.destination);

            scriptProcessorRef.current.onaudioprocess = (e: any) => {
                const inputData = e.inputBuffer.getChannelData(0);
                const pcmData = new Int16Array(inputData.length);
                for (let i = 0; i < inputData.length; i++) {
                    const s = Math.max(-1, Math.min(1, inputData[i]));
                    pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                }

                chunkCountRef.current++;
                if (chunkCountRef.current % 50 === 1) {
                    console.log(`[ASR Frontend] Web: 正在持续发送音频数据块... 当前第 ${chunkCountRef.current} 块, 大小: ${pcmData.buffer.byteLength} bytes`);
                }

                apiSocket.send('asr_audio_chunk', {
                    audioBase64: toPcmBase64(pcmData),
                    chunkByteLength: pcmData.buffer.byteLength,
                    sessionId
                });
            };
            return;
        }

        console.log('[ASR Frontend] 正在初始化 Native 麦克风录音...');
        const { AudioRecorder } = require('react-native-audio-api');
        const recorder = new AudioRecorder({
            sampleRate: 16000,
            bufferLengthInSamples: 1024
        });

        let isAudioStopped = false;

        recorder.onAudioReady((event: any) => {
            if (isAudioStopped) {
                return;
            }

            const inputData = event.buffer.getChannelData(0);
            const pcmData = new Int16Array(inputData.length);
            for (let i = 0; i < inputData.length; i++) {
                const s = Math.max(-1, Math.min(1, inputData[i]));
                pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            }

            chunkCountRef.current++;
            if (chunkCountRef.current % 50 === 1) {
                console.log(`[ASR Frontend] Native: 正在持续发送音频数据块... 当前第 ${chunkCountRef.current} 块, 大小: ${pcmData.buffer.byteLength} bytes`);
            }

            apiSocket.send('asr_audio_chunk', {
                audioBase64: toPcmBase64(pcmData),
                chunkByteLength: pcmData.buffer.byteLength,
                sessionId
            });
        });

        nativeRecorderRef.current = recorder;
        nativeRecorderRef.current.markAsStopped = () => {
            isAudioStopped = true;
        };
        recorder.start();
        console.log('[ASR Frontend] Native Audio Recorder 已启动');
    }, [sessionId, toPcmBase64]);

    useEffect(() => {
        const cleanupText = apiSocket.onMessage('asr_text', (data: any) => {
            console.log('[ASR Frontend] 收到后端发来的 asr_text:', data);
            if (data && data.text) {
                let joinedText = '';
                if (data.pgs === 'rpl') {
                    joinedText = data.text;
                    resultTextArrayRef.current = [joinedText];
                } else {
                    resultTextArrayRef.current.push(data.text);
                    joinedText = resultTextArrayRef.current.join('');
                }
                console.log(`[ASR Frontend] 准备调用 onTextUpdate (sn:${data.sn}, pgs:${data.pgs}), 文本: "${joinedText}", onTextUpdate 是否存在: ${!!onTextUpdateRef.current}`);
                if (onTextUpdateRef.current) {
                    onTextUpdateRef.current(joinedText);
                }
            }
        });

        const cleanupEnd = apiSocket.onMessage('asr_end', () => {
            console.log('[ASR Frontend] 收到后端发来的 asr_end，停止录音');
            void stopListening({ skipBackendStop: true });
        });

        const cleanupError = apiSocket.onMessage('asr_error', (err: any) => {
            console.error('[ASR Frontend] 收到后端发来的 asr_error:', err);
            void stopListening({ skipBackendStop: true });
        });

        return () => {
            cleanupText();
            cleanupEnd();
            cleanupError();
        };
    }, [stopListening]);

    const startListening = useCallback(async () => {
        console.log('[ASR Frontend] startListening() 被调用');

        try {
            const permissionResult = await requestMicrophonePermission();
            if (!permissionResult.granted) {
                showMicrophonePermissionDeniedAlert(permissionResult.canAskAgain);
                return;
            }

            resultTextArrayRef.current = [];
            chunkCountRef.current = 0;
            if (onTextUpdate) {
                console.log('[ASR Frontend] 清空输入框');
                onTextUpdate('');
            } else {
                console.warn('[ASR Frontend] 警告: onTextUpdate 回调函数未传入！');
            }

            await startLegacyStreaming();

        } catch (error) {
            console.error('[ASR Frontend] Failed to start recording:', error);
            setIsListening(false);
            void stopListening();
        }
    }, [onTextUpdate, startLegacyStreaming, stopListening]);

    return {
        isListening,
        startListening,
        stopListening
    };
}
