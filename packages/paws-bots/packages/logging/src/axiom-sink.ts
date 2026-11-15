import { guardedFlush, guardedWrite, reportSinkError } from "./sink-guard.js";
import type { LogEvent, LogSink } from "./types.js";

// The vendor SDK loads only when a sink is built, so unconfigured installs never import it;
// a dynamic import of this module alone would not keep it lazy, because the server bundle
// inlines this file.

export interface AxiomIngestClient {
  ingest(dataset: string, events: object[]): void;
  flush(): Promise<void>;
}

export interface AxiomSinkOptions {
  dataset: string;
  token?: string;
  edge?: string;
  edgeUrl?: string;
  client?: AxiomIngestClient;
}

export async function createAxiomSink(options: AxiomSinkOptions): Promise<LogSink> {
  const { Axiom } = await import("@axiomhq/js");
  const client =
    options.client ??
    new Axiom({
      token: options.token ?? "",
      ...(options.edge ? { edge: options.edge } : {}),
      ...(options.edgeUrl ? { edgeUrl: options.edgeUrl } : {}),
      onError: reportSinkError,
    });
  const dataset = options.dataset;
  return {
    write(event: LogEvent) {
      guardedWrite(() => {
        client.ingest(dataset, [event]);
      });
    },
    flush() {
      return guardedFlush(() => client.flush());
    },
  };
}
