import assert from "node:assert/strict";
import type {
  AdapterContext,
  BrowserActRequest,
  BrowserNavigateRequest,
  BrowserSnapshotRequest,
  BrowserSnapshotResult,
  ComputerRef,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { FakeBrowserProvider, pageBrowserSessionKey } from "@rakazo/adapters";

export const CONTACTS_CSV =
  "name,email\nAlex Example,alex@example.test\nSam Example,sam@example.test\n";
export const CONTACTS_PATH = "Downloads/contacts.csv";
export const EXPORT_RECEIPT_PATH = "results/export-count.txt";
export const EXPORT_FIXTURE_URL = "http://127.0.0.1:8765/";
const contactsPage = "<title>Contacts</title><h1>Contacts</h1><button>Export contacts</button>";
const dialogPage =
  "<title>Contacts</title><h1>Export format</h1><button>Download CSV</button><button>Cancel</button>";
const completePage = "<title>Export complete</title><h1>Export complete</h1>";

/** Hand-authored scenario, not a captured real-model trace. Only valid UI actions cause effects. */
export class ContactsBrowserFixture extends FakeBrowserProvider {
  private readonly observed = new Map<string, BrowserSnapshotResult>();

  constructor(
    private readonly sandbox: SandboxProvider,
    private readonly faults: { downloadFailures?: number } = {},
  ) {
    super({ pages: { [EXPORT_FIXTURE_URL]: { html: contactsPage } } });
  }

  override async navigate(
    computer: ComputerRef,
    request: BrowserNavigateRequest,
    context: AdapterContext,
  ) {
    // Never let a fixture accidentally navigate to an external service.
    assert.equal(request.url, EXPORT_FIXTURE_URL, "Unexpected fixture URL");
    return super.navigate(computer, request, context);
  }

  override async act(computer: ComputerRef, request: BrowserActRequest, context: AdapterContext) {
    if (!request.actions?.length) return super.act(computer, request, context);
    const session = this.sessions.get(pageBrowserSessionKey(computer, context));
    let completed = 0;
    for (const action of request.actions) {
      const target = this.observed
        .get(pageBrowserSessionKey(computer, context))
        ?.elements.find((node) => node.ref === action.ref);
      const result = await super.act(computer, { actions: [action] }, context);
      if (result.elements && result.tree !== undefined) {
        this.observed.set(pageBrowserSessionKey(computer, context), {
          url: result.url,
          title: result.title,
          tree: result.tree,
          elements: result.elements,
        });
      }
      if (!result.ok) return { ...result, completed };
      completed += 1;
      if (action.kind !== "click") continue;
      if (target?.name === "Export contacts") session.load(EXPORT_FIXTURE_URL, dialogPage);
      if (target?.name === "Cancel") session.load(EXPORT_FIXTURE_URL, contactsPage);
      if (target?.name === "Download CSV") {
        if ((this.faults.downloadFailures ?? 0) > 0) {
          this.faults.downloadFailures! -= 1;
          return {
            ...result,
            ok: false,
            completed: completed - 1,
            error: "Download temporarily unavailable",
          };
        }
        const previousReceipt = await this.sandbox
          .readFile(computer, EXPORT_RECEIPT_PATH, context)
          .catch(() => new TextEncoder().encode("0"));
        const count = Number(new TextDecoder().decode(previousReceipt)) + 1;
        await this.sandbox.writeFile(
          computer,
          {
            path: CONTACTS_PATH,
            content: new TextEncoder().encode(CONTACTS_CSV),
          },
          context,
        );
        await this.sandbox.writeFile(
          computer,
          {
            path: EXPORT_RECEIPT_PATH,
            content: new TextEncoder().encode(String(count)),
          },
          context,
        );
        session.load(EXPORT_FIXTURE_URL, completePage);
      }
    }
    return { ok: true, completed, ...(await this.snapshot(computer, {}, context)) };
  }

  override async snapshot(
    computer: ComputerRef,
    request: BrowserSnapshotRequest,
    context: AdapterContext,
  ) {
    const result = await super.snapshot(computer, request, context);
    this.observed.set(pageBrowserSessionKey(computer, context), result);
    return result;
  }

  close() {
    this.sessions.clear();
    this.observed.clear();
  }
}

/** Local controlled website served inside the Docker computer. Browser writes the download. */
export async function installContactsFixture(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  context: AdapterContext,
) {
  const page = `${contactsPage}<script>
document.querySelector('button').onclick = () => {
  document.body.innerHTML = '<h1>Export format</h1><button id="download">Download CSV</button><button id="cancel">Cancel</button>';
  document.querySelector('#cancel').onclick = () => location.reload();
  document.querySelector('#download').onclick = async () => {
    const response = await fetch('/export', {method:'POST'});
    const link = document.createElement('a');
    link.href = URL.createObjectURL(await response.blob()); link.download = 'contacts.csv';
    document.body.append(link); link.click();
    document.title = 'Export complete'; document.body.innerHTML = '<h1>Export complete</h1>';
  };
};
</script>`;
  const source = `from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
PAGE = ${JSON.stringify(page)}.encode()
CSV = ${JSON.stringify(CONTACTS_CSV)}.encode()
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        self.send_response(200); self.send_header('Content-Type','text/html'); self.end_headers(); self.wfile.write(PAGE)
    def do_POST(self):
        if self.path != '/export':
            self.send_error(404); return
        receipt = Path('${EXPORT_RECEIPT_PATH}')
        receipt.parent.mkdir(exist_ok=True)
        receipt.write_text(str(int(receipt.read_text()) + 1 if receipt.exists() else 1))
        self.send_response(200); self.send_header('Content-Type','text/csv'); self.end_headers(); self.wfile.write(CSV)
HTTPServer(('127.0.0.1',8765),Handler).serve_forever()
`;
  await sandbox.writeFile(
    computer,
    { path: "contacts_server.py", content: new TextEncoder().encode(source) },
    context,
  );
  await executeChecked(
    sandbox,
    computer,
    context,
    "mkdir -p Downloads results; setsid -f python3 contacts_server.py > contacts-server.log 2>&1 < /dev/null",
  );
  let readinessError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await executeChecked(
        sandbox,
        computer,
        context,
        `python3 -c 'import urllib.request; urllib.request.urlopen("${EXPORT_FIXTURE_URL}", timeout=1).read()'`,
      );
      return;
    } catch (error) {
      readinessError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  const log = await sandbox
    .readFile(computer, "contacts-server.log", context)
    .catch(() => new Uint8Array());
  throw new Error(
    `Contacts fixture did not become ready: ${new TextDecoder().decode(log).slice(0, 1000)} (${String(readinessError)})`,
  );
}

async function executeChecked(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  context: AdapterContext,
  command: string,
) {
  let code: number | undefined;
  let stderr = "";
  for await (const event of sandbox.execute(computer, { argv: ["bash", "-c", command] }, context)) {
    if (event.type === "exit") code = event.code;
    if (event.type === "stderr") stderr += event.data;
  }
  assert.equal(code, 0, `Fixture command failed: ${stderr.slice(0, 1000)}`);
}
