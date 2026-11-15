import type { ASTNode } from "@ronradtke/react-native-markdown-display";
import { remoteMarkdownImage } from "../markdown";

export function soleRemoteImage(node: ASTNode):
  | {
      remote: { href: string; host: string };
      alt?: string;
      title?: string;
    }
  | undefined {
  const parts = node.children.filter(
    (child) => child.type !== "text" || child.content.trim() !== "",
  );
  const only = parts.length === 1 && parts[0]?.type === "image" ? parts[0] : undefined;
  if (!only) return undefined;
  const remote = remoteMarkdownImage(only.attributes.src ?? "");
  if (!remote) return undefined;
  return { remote, alt: only.attributes.alt, title: only.attributes.title };
}

/** The label when it is plain text, the only kind that can be a bare URL. */
export function astText(node: ASTNode): string | undefined {
  if (!node.children.every((child) => child.type === "text")) return undefined;
  return node.children.map((child) => child.content).join("");
}

export function astHasImage(node: ASTNode): boolean {
  return node.children.some((child) => child.type === "image" || astHasImage(child));
}

export function enclosingLink(parents: readonly ASTNode[]) {
  return parents.find((parent) => parent.type === "link" || parent.type === "blocklink");
}

export function cellPlainText(node: ASTNode): string {
  if (node.type === "text" || node.type === "code_inline") return node.content;
  if (node.type === "softbreak" || node.type === "hardbreak") return " ";
  return node.children.map(cellPlainText).join("");
}
