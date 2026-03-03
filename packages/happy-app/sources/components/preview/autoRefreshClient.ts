/**
 * Client-side AutoRefreshManager for the Preview Panel.
 * Debounces file-change signals from tool-call messages into refresh callbacks.
 */

type RefreshType = 'css' | 'full';
type RefreshCallback = (type: RefreshType) => void;

const CSS_EXTENSIONS = /\.(css|scss|sass|less)$/i;

const FILE_MUTATING_COMMANDS = [
    'mv', 'cp', 'rm', 'mkdir', 'touch', 'tee', 'sed', 'awk',
    'perl', 'python', 'python3', 'node', 'npx', 'yarn', 'pnpm', 'npm',
];

function shouldTriggerReload(toolName: string, toolArgs?: string): boolean {
    const name = toolName.toLowerCase();
    if (name === 'edit' || name === 'write') return true;
    if (name === 'bash' || name === 'run_command') {
        if (!toolArgs) return false;
        const firstToken = toolArgs.trim().split(/\s+/)[0]?.toLowerCase();
        return FILE_MUTATING_COMMANDS.includes(firstToken || '');
    }
    return false;
}

function detectCssOnly(toolName: string, filePath?: string): boolean {
    if (!filePath) return false;
    const name = toolName.toLowerCase();
    if (name !== 'edit' && name !== 'write') return false;
    return CSS_EXTENSIONS.test(filePath);
}

export class AutoRefreshManager {
    private timer: ReturnType<typeof setTimeout> | null = null;
    private pendingType: RefreshType = 'css';
    private debounceMs: number;

    constructor(private onRefresh: RefreshCallback, debounceMs = 500) {
        this.debounceMs = debounceMs;
    }

    handleToolCallEnd(toolName: string, toolArgs?: string, filePath?: string): void {
        if (!shouldTriggerReload(toolName, toolArgs)) return;

        if (!detectCssOnly(toolName, filePath)) {
            this.pendingType = 'full';
        }

        this.scheduleRefresh();
    }

    destroy(): void {
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    private scheduleRefresh(): void {
        if (this.timer !== null) {
            clearTimeout(this.timer);
        }
        this.timer = setTimeout(() => {
            this.timer = null;
            const type = this.pendingType;
            this.pendingType = 'css';
            this.onRefresh(type);
        }, this.debounceMs);
    }
}
