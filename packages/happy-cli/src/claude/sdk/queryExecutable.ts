const executables = new WeakMap<object, string>();
export const rememberClaudeQueryExecutable = (query: object, executable: string) => executables.set(query, executable);
export const getClaudeQueryExecutable = (query: object) => executables.get(query);
