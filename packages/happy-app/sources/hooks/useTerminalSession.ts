import { useCallback, useEffect, useRef, useState } from 'react';
import {
    TerminalStream,
    TerminalStreamStatus,
    TerminalWriterState,
} from '@/sync/terminalClient';
import type { TerminalAttachResult } from '@/sync/terminalTypes';

export interface TerminalSessionCallbacks {
    onAttach(result: TerminalAttachResult): void;
    onOutput(data: string): void;
    onExit(exitCode: number): void;
    onError(message: string): void;
    onWriter(state: TerminalWriterState): void;
}

export function useTerminalSession(
    machineId: string,
    terminalId: string,
    callbacks: TerminalSessionCallbacks,
) {
    const callbacksRef = useRef(callbacks);
    callbacksRef.current = callbacks;

    const [status, setStatus] = useState<TerminalStreamStatus>('connecting');
    const [writerSocketId, setWriterSocketId] = useState<string | null>(null);
    const [isWriter, setIsWriter] = useState(false);
    const [exitCode, setExitCode] = useState<number | undefined>();
    const [error, setError] = useState<string | null>(null);
    const [epochReset, setEpochReset] = useState(false);
    const [controlReset, setControlReset] = useState(false);
    const streamRef = useRef<TerminalStream | null>(null);

    useEffect(() => {
        setEpochReset(false);
        setControlReset(false);
        const stream = new TerminalStream(machineId, terminalId, {
            onAttach: (result) => callbacksRef.current.onAttach(result),
            onOutput: (data) => callbacksRef.current.onOutput(data),
            onExit: (code) => {
                setExitCode(code);
                callbacksRef.current.onExit(code);
            },
            onError: (message) => {
                setError(message);
                callbacksRef.current.onError(message);
            },
            onWriter: (writerState) => {
                setWriterSocketId(writerState.writerSocketId);
                setIsWriter(writerState.isWriter);
                callbacksRef.current.onWriter(writerState);
            },
            onEpochReset: () => setEpochReset(true),
            onControlReset: () => setControlReset(true),
            onStatusChange: setStatus,
        });
        streamRef.current = stream;

        void stream.attach().catch((attachError) => {
            if (streamRef.current !== stream) {
                return;
            }
            const message = attachError instanceof Error ? attachError.message : String(attachError);
            setError(message);
            setStatus('error');
        });

        return () => {
            streamRef.current = null;
            stream.detach();
        };
    }, [machineId, terminalId]);

    const sendInput = useCallback((data: string) => {
        void streamRef.current?.sendInput(data);
    }, []);

    const sendResize = useCallback((cols: number, rows: number) => {
        void streamRef.current?.sendResize(cols, rows);
    }, []);

    const sendSignal = useCallback((signal: string) => {
        void streamRef.current?.sendSignal(signal);
    }, []);

    const takeControl = useCallback(async () => {
        await streamRef.current?.takeControl();
    }, []);

    const refresh = useCallback(() => {
        void streamRef.current?.attach();
    }, []);

    return {
        status,
        writerSocketId,
        isWriter,
        exitCode,
        error,
        epochReset,
        controlReset,
        sendInput,
        sendResize,
        sendSignal,
        takeControl,
        refresh,
    };
}
