/**
 * Core line parser utility for processing git command output
 * Based on simple-git's LineParser implementation
 */

export type LineParseHandler<T> = (target: T, matches: (string | undefined)[], lines: string[], index: number) => void;

/**
 * Generic line parser that processes lines using regular expressions
 * 
 * @template T The type of object being built by the parser
 */
export class LineParser<T> {
    private readonly regexes: readonly RegExp[];
    private readonly handler: LineParseHandler<T>;

    constructor(regexes: RegExp | RegExp[], handler: LineParseHandler<T>) {
        this.regexes = Array.isArray(regexes) ? regexes : [regexes];
        this.handler = handler;
    }

    /**
     * Parse lines and populate the target object
     */
    parse(target: T, lines: string[]): T {
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            for (const regex of this.regexes) {
                const match = regex.exec(line);
                if (match) {
                    this.handler(target, match, lines, i);
                    break;
                }
            }
        }
        return target;
    }
}

/**
 * Specialized parser for remote messages (lines starting with "remote:")
 */
export class RemoteLineParser<T> extends LineParser<T> {
    constructor(regexes: RegExp | RegExp[], handler: LineParseHandler<T>) {
        super(regexes, (target, matches, lines, index) => {
            const line = lines[index];
            if (line.startsWith('remote:')) {
                handler(target, matches, lines, index);
            }
        });
    }
}

/**
 * Helper function to create a simple line parser
 */
export function createLineParser<T>(
    regex: RegExp | RegExp[],
    handler: LineParseHandler<T>
): LineParser<T> {
    return new LineParser(regex, handler);
}