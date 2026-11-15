import type {
  AdapterContext,
  ConnectorCall,
  ConnectorEvent,
  ConnectorProvider,
  ConnectorTool,
} from "@rakazo/adapter-kit";

export interface DestinationRecord {
  id: string;
  collection: string;
  title: string;
  body: string;
}

/**
 * Test-only consequential connector. Production never registers it; tests and
 * the e2e harness pass it to `createApp({ connectors })` explicitly.
 */
export class DestinationEmulator implements ConnectorProvider {
  readonly records: DestinationRecord[] = [];

  describe() {
    return {
      id: "destination",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { discover: true, oauth: false, secretsBrokered: false },
    };
  }

  async discoverTools(_context: AdapterContext): Promise<ConnectorTool[]> {
    return [
      {
        name: "destination.write",
        description: "Write a record to the connected destination",
        inputSchema: {
          type: "object",
          properties: {
            collection: { type: "string" },
            title: { type: "string" },
            body: { type: "string" },
          },
        },
        route: { connectorId: "destination", toolName: "destination.write" },
      },
    ];
  }

  async *execute(call: ConnectorCall, _context: AdapterContext): AsyncIterable<ConnectorEvent> {
    if (call.tool !== "destination.write") {
      yield { type: "error", message: `unknown tool ${call.tool}` };
      return;
    }
    const record: DestinationRecord = {
      id: `rec-${this.records.length + 1}`,
      collection: String(call.args.collection ?? "notes"),
      title: String(call.args.title ?? ""),
      body: String(call.args.body ?? ""),
    };
    this.records.push(record);
    yield { type: "result", data: { id: record.id, written: true } };
  }
}
