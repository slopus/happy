import React, {
    forwardRef,
    useEffect,
    useImperativeHandle,
    useRef,
} from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

export interface TerminalViewHandle {
    write(data: string): void;
    clear(): void;
    focus(): void;
}

export interface TerminalViewProps {
    onData: (data: string) => void;
    onResize: (cols: number, rows: number) => void;
    fontSize?: number;
    dark?: boolean;
}

const DARK_THEME = {
    background: '#0d1117',
    foreground: '#e6edf3',
    cursor: '#e6edf3',
    selectionBackground: '#264f78',
};

const LIGHT_THEME = {
    background: '#ffffff',
    foreground: '#1c1c1c',
    cursor: '#1c1c1c',
    selectionBackground: '#b3d7ff',
};

export const TerminalView = forwardRef<TerminalViewHandle, TerminalViewProps>(
    function TerminalView({ onData, onResize, fontSize = 14, dark = true }, ref) {
        const containerRef = useRef<HTMLDivElement | null>(null);
        const terminalRef = useRef<Terminal | null>(null);
        const fitAddonRef = useRef<FitAddon | null>(null);
        const onDataRef = useRef(onData);
        const onResizeRef = useRef(onResize);
        onDataRef.current = onData;
        onResizeRef.current = onResize;

        useEffect(() => {
            const terminal = new Terminal({
                cursorBlink: true,
                fontSize,
                fontFamily: 'Menlo, Monaco, Consolas, "Liberation Mono", monospace',
                scrollback: 5000,
                theme: dark ? DARK_THEME : LIGHT_THEME,
                allowProposedApi: true,
            });
            const fit = new FitAddon();
            terminal.loadAddon(fit);
            terminal.open(containerRef.current!);
            try {
                fit.fit();
            } catch {
                // Container may not have dimensions yet; the resize listener refits.
            }
            terminal.onData((data) => onDataRef.current(data));
            terminal.onResize(({ cols, rows }) => onResizeRef.current(cols, rows));
            terminalRef.current = terminal;
            fitAddonRef.current = fit;

            const handleWindowResize = () => {
                try {
                    fit.fit();
                } catch {
                    // Ignore transient layout states.
                }
            };
            window.addEventListener('resize', handleWindowResize);

            return () => {
                window.removeEventListener('resize', handleWindowResize);
                terminal.dispose();
                terminalRef.current = null;
                fitAddonRef.current = null;
            };
            // eslint-disable-next-line react-hooks/exhaustive-deps
        }, []);

        useEffect(() => {
            if (terminalRef.current) {
                terminalRef.current.options.fontSize = fontSize;
            }
        }, [fontSize]);

        useEffect(() => {
            if (terminalRef.current) {
                terminalRef.current.options.theme = dark ? DARK_THEME : LIGHT_THEME;
            }
        }, [dark]);

        useImperativeHandle(ref, () => ({
            write: (data) => terminalRef.current?.write(data),
            clear: () => terminalRef.current?.reset(),
            focus: () => terminalRef.current?.focus(),
        }), []);

        return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
    },
);
