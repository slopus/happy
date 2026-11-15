import type {
  AdapterContext,
  CommandRequest,
  ComputerActionRequest,
  ComputerInput,
  ComputerRef,
  ControlLeaseRef,
  PortableFile,
  ProcessEvent,
  SandboxProvider,
  ScreenRequest,
} from "@rakazo/adapter-kit";

export const NO_SANDBOX_MESSAGE =
  "Computers unavailable. Set SANDBOX_PROVIDER=docker with SANDBOX_SUPERVISOR_TOKEN, or use e2b, novita, daytona, or boat with its API key.";

/** Boots the API without a computer host. Provision and runtime calls fail closed. */
export class NoneSandboxProvider implements SandboxProvider {
  constructor(private readonly message = NO_SANDBOX_MESSAGE) {}

  describe() {
    return {
      id: "none",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        graphical: false,
        pty: false,
        snapshots: false,
        takeover: false,
        persistentHome: false,
        multiScreen: false,
      },
    };
  }

  private fail(): never {
    throw new Error(this.message);
  }

  async provision(
    _request: {
      botId: string;
      homePath: string;
      providerRef?: string;
      providerKind?: ComputerRef["kind"];
    },
    _context: AdapterContext,
  ): Promise<ComputerRef> {
    this.fail();
  }

  async prepare(_computer: ComputerRef, _context: AdapterContext): Promise<void> {
    this.fail();
  }

  execute(
    _computer: ComputerRef,
    _request: CommandRequest,
    _context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    this.fail();
  }

  async connectScreen(
    _computer: ComputerRef,
    _request: ScreenRequest,
    _context: AdapterContext,
  ): Promise<never> {
    this.fail();
  }

  async sendInput(
    _computer: ComputerRef,
    _input: ComputerInput,
    _lease: ControlLeaseRef,
    _context: AdapterContext,
  ): Promise<void> {
    this.fail();
  }

  async observe(_computer: ComputerRef, _context: AdapterContext): Promise<never> {
    this.fail();
  }

  async act(
    _computer: ComputerRef,
    _request: ComputerActionRequest,
    _context: AdapterContext,
  ): Promise<never> {
    this.fail();
  }

  async listFiles(_computer: ComputerRef, _path: string, _context: AdapterContext): Promise<never> {
    this.fail();
  }

  async readFile(
    _computer: ComputerRef,
    _path: string,
    _context: AdapterContext,
    _options?: { maxBytes?: number },
  ): Promise<never> {
    this.fail();
  }

  async writeFile(
    _computer: ComputerRef,
    _file: PortableFile,
    _context: AdapterContext,
  ): Promise<void> {
    this.fail();
  }

  exportWorkspace(_computer: ComputerRef, _context: AdapterContext): AsyncIterable<PortableFile> {
    this.fail();
  }

  async importWorkspace(
    _computer: ComputerRef,
    _files: AsyncIterable<PortableFile>,
    _context: AdapterContext,
  ): Promise<void> {
    this.fail();
  }

  async snapshot(_computer: ComputerRef, _context: AdapterContext): Promise<never> {
    this.fail();
  }

  async stop(_computer: ComputerRef, _context: AdapterContext): Promise<void> {
    this.fail();
  }

  async destroy(_computer: ComputerRef, _context: AdapterContext): Promise<void> {
    this.fail();
  }
}
