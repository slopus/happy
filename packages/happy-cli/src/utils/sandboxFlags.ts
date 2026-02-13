export function extractNoSandboxFlag(args: string[]): { noSandbox: boolean; args: string[] } {
    let noSandbox = false;
    const remainingArgs: string[] = [];

    for (const arg of args) {
        if (arg === '--no-sandbox') {
            noSandbox = true;
        } else {
            remainingArgs.push(arg);
        }
    }

    return {
        noSandbox,
        args: remainingArgs,
    };
}
