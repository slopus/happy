import { readFileSync } from "node:fs";
import type {
  AdapterContext,
  CommandRequest,
  ComputerRef,
  ProcessEvent,
} from "@rakazo/adapter-kit";
import { computerObservation, FakeSandboxProvider } from "@rakazo/adapters";
import type { ComputerScript } from "./scripted-shell.js";
import { scriptedShell } from "./scripted-shell.js";

const SHELL_UNAVAILABLE = "Shell execution is unavailable in this offline eval sandbox.";

/** A model must not receive successful shell results for commands the fixture never ran. */
export class EvalSandboxProvider extends FakeSandboxProvider {
  readonly harnessIssues: string[] = [];
  private readonly screenImage?: Uint8Array;

  constructor(private readonly script?: ComputerScript) {
    super();
    if (script) this.screenImage = browserScreen(script.screen.dark);
  }

  override async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    if (request.argv[3] === "rakazo-background-launch") {
      const command = request.argv.at(-1) ?? "";
      const result = this.script && scriptedShell(this.script, command);
      if (result) {
        if (result.stdout) yield { type: "stdout", data: `${result.stdout}\n` };
        if (result.stderr) yield { type: "stderr", data: `${result.stderr}\n` };
        yield { type: "exit", code: result.code };
        return;
      }
      if (!this.harnessIssues.includes(SHELL_UNAVAILABLE))
        this.harnessIssues.push(SHELL_UNAVAILABLE);
      yield { type: "stderr", data: SHELL_UNAVAILABLE };
      yield { type: "exit", code: 127 };
      return;
    }
    yield* super.execute(computer, request, context);
  }

  override async observe(computer: ComputerRef, context: AdapterContext) {
    if (!this.script || !this.screenImage) return super.observe(computer, context);
    return computerObservation(this.screenImage, {
      mimeType: "image/png",
      width: SCREEN.width,
      height: SCREEN.height,
      activeWindow: { id: "browser", title: this.script.screen.title },
    });
  }
}

const SCREEN = { width: 1280, height: 800 };

/**
 * The browser window a screenshot shows: Chromium on example.com, the page darkened as a
 * dark-mode extension renders it, or as the site ships it. Real text, so a bot can read it.
 */
export function browserScreen(dark: boolean): Uint8Array {
  return new Uint8Array(
    readFileSync(new URL(`./fixtures/example-${dark ? "dark" : "light"}.png`, import.meta.url)),
  );
}
