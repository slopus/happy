import { useStreamingAsrProvider } from '@/features/voice-input';

interface UseCustomASRProps {
    onTextUpdate?: (text: string) => void;
    sessionId?: string;
}

export function useCustomASR({ onTextUpdate, sessionId }: UseCustomASRProps) {
    return useStreamingAsrProvider({ onTextUpdate, sessionId });
}
