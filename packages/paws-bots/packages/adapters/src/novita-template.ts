import type { Novita } from "novita-sandbox";

export const NOVITA_COMPUTER_TEMPLATE = "rakazo-computer";

/** Build in the account that runs the computers; never fall back to the larger stock image. */
export async function buildNovitaComputerTemplate(
  apiKey: string,
  options: {
    template?: string;
    client?: Pick<Novita, "template">;
    onBuildLogs?: (line: string) => void;
  } = {},
) {
  const client = options.client ?? new (await import("novita-sandbox")).Novita({ apiKey });
  return client.template.build(
    client.template.new().fromTemplate("desktop"),
    options.template?.trim() || NOVITA_COMPUTER_TEMPLATE,
    {
      cpuCount: 2,
      memoryMB: 4096,
      ...(options.onBuildLogs
        ? { onBuildLogs: (entry) => options.onBuildLogs?.(entry.toString()) }
        : {}),
    },
  );
}
