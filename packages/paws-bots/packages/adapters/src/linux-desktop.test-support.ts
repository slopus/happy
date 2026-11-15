/** SDK translation fixture; shell allocation and fencing are exercised in core runtime tests. */
export function desktopCommandResponder() {
  const slots = new Map<string, number>();
  return (command: string): { exitCode: number; stdout: string; stderr: string } | undefined => {
    const key = command.match(/slot="\$dir\/([a-f0-9]+)\.slot"/)?.[1];
    if (key && command.includes("RAKAZO_DESKTOP=")) {
      let index = slots.get(key);
      if (index === undefined) {
        const used = new Set(slots.values());
        index = 0;
        while (used.has(index)) index++;
        slots.set(key, index);
      }
      return { exitCode: 0, stdout: `RAKAZO_DESKTOP=${index}:view-${key}\n`, stderr: "" };
    }
    if (key && command.includes("RAKAZO_DESKTOP_RELEASED=")) {
      slots.delete(key);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (command.includes("base64") && command.includes("CURSOR"))
      return { exitCode: 0, stdout: "AQID\nCURSOR X=10 Y=20\n", stderr: "" };
    return undefined;
  };
}

/** `env [NAME=value...] [-u NAME...] [--] command`, then `echo` and `printenv`. */
export function simpleCommand(
  argv: string[],
  inherited: Record<string, string>,
): { exitCode?: number; stdout?: string } {
  const env: Record<string, string | undefined> = { ...inherited };
  let rest = argv;
  while (rest[0] === "env") {
    rest = rest.slice(1);
    while (rest.length) {
      const [first, second] = rest;
      if (first === "-u" && second) {
        delete env[second];
        rest = rest.slice(2);
      } else if (first === "--") {
        rest = rest.slice(1);
        break;
      } else if (first?.includes("=")) {
        const [name, ...value] = first.split("=");
        env[name!] = value.join("=");
        rest = rest.slice(1);
      } else break;
    }
  }
  // onBotScreen's wrapper: no fake computer has a screen slot, so the inherited DISPLAY stays.
  if (rest[0] === "sh" && rest[1] === "-c" && rest[2]?.endsWith('exec "$@"')) rest = rest.slice(4);
  const [program, ...args] = rest;
  if (program === "echo") return { stdout: `${args.join(" ")}\n` };
  if (program === "printenv") {
    const value = env[args[0] ?? ""];
    return value === undefined ? { exitCode: 1 } : { stdout: `${value}\n` };
  }
  return {};
}
