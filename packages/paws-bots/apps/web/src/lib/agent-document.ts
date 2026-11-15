import { AGENT_IMPORT_MAX_FILE_LENGTH } from "@rakazo/contracts";

/** Up to four UTF-8 bytes per allowed character. */
export const AGENT_DOCUMENT_MAX_BYTES = AGENT_IMPORT_MAX_FILE_LENGTH * 4;

/** Null, without reading the file, when it is too large to import. */
export async function readAgentDocument(file: Pick<File, "size" | "text">): Promise<string | null> {
  if (file.size > AGENT_DOCUMENT_MAX_BYTES) return null;
  return file.text();
}
