import { rpc } from "./rpc";

export type ArtifactTarget = { botId: string } | { groupId: string };

export function decodeArtifactBase64(contentBase64: string): Uint8Array {
  const binary = atob(contentBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export async function fetchArtifactBytes(
  target: ArtifactTarget,
  artifactId: string,
): Promise<Uint8Array> {
  const artifact = await rpc.artifacts.get({ ...target, artifactId });
  return decodeArtifactBase64(artifact.contentBase64);
}

export function downloadArtifactBytes(name: string, mimeType: string, bytes: Uint8Array): void {
  const blob = new Blob([new Uint8Array(bytes)], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function downloadArtifact(
  target: ArtifactTarget,
  artifactId: string,
  name: string,
  mimeType: string,
): Promise<void> {
  const bytes = await fetchArtifactBytes(target, artifactId);
  downloadArtifactBytes(name, mimeType, bytes);
}
