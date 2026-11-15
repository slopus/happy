import type { AgentImportMemory, AgentImportSkill } from "@rakazo/contracts";
import { BOT_NAME_MAX_LENGTH } from "@rakazo/contracts";
import { buildSkillMd } from "../agent-skill.js";
import type { AgentImportParse } from "./shared.js";
import { freeName, memoryItem, skillItem } from "./shared.js";

/**
 * Model-facing text pasted into another product, so it stays in English. Keep its section
 * names in sync with SECTIONS.
 */
export const AGENT_IMPORT_PROMPT = `I am moving you to a new assistant app. Write down everything it needs to carry on where you left off, as one Markdown document in exactly this layout:

# Name
Your name, on one line.

# Instructions
How you work: your role, personality, tone, rules and standing instructions, written as instructions to yourself.

# Memory
Everything you know or remember about me and our work: facts, preferences, people, projects and ongoing tasks. Start each topic with a "## " heading.

# Skills
Repeatable procedures you follow. For each one, a "## skill-name" heading (lowercase words joined with hyphens), then one line saying when to use it, then the steps.

Rules:
- Use only these four "# " headings, in this order. Leave a section empty if you have nothing for it.
- Be complete and specific. Keep details rather than summarising them away.
- Never include passwords, API keys, tokens or other secrets.
- Reply with the whole document in one code block that starts with \`\`\`\`markdown and ends with \`\`\`\`, or as a downloadable .md file.
`;

const SECTIONS = ["name", "instructions", "memory", "skills"] as const;
type Section = (typeof SECTIONS)[number];
const SECTION_HEADING = /^#\s+(name|instructions|memory|skills)\s*$/i;
const SUBSECTION_HEADING = /^##\s+(.+?)(?:\s+#+)?\s*$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

type Block = { heading: string; lines: string[] };

export function isAgentDocument(text: string): boolean {
  const sections = documentSections(text);
  return Boolean(sections && (sections.instructions || sections.memory || sections.skills));
}

export function parseAgentDocument(text: string): AgentImportParse {
  const sections = documentSections(text) ?? {};
  const name = sections.name?.lines.join("\n").trim().split("\n")[0]?.trim() ?? "";
  const instructions = sections.instructions;
  const instructionText = instructions ? markdown(instructions.lines) : "";
  const memory = sections.memory ? memoryDocuments(sections.memory.lines) : [];
  const skills = sections.skills ? skillDocuments(sections.skills) : { skills: [], skipped: [] };
  return {
    suggestedName: name.slice(0, BOT_NAME_MAX_LENGTH),
    suggestedDescription: "",
    instructions:
      instructions && instructionText
        ? [
            {
              id: `instructions:${instructions.heading}`,
              title: instructions.heading,
              content: instructionText,
              role: "working",
              stock: false,
              mentions: [],
            },
          ]
        : [],
    memory,
    ...skills,
  };
}

/** Ignores chatter before the document and after its wrapping fence, if any. */
function documentSections(text: string): Partial<Record<Section, Block>> | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const start = lines.findIndex((line) => SECTION_HEADING.test(line));
  if (start < 0) return null;
  let end = lines.length;
  let before = start - 1;
  while (before >= 0 && !lines[before]!.trim()) before -= 1;
  const opener = before >= 0 ? /^\s*(`{3,}|~{3,})\s*[\w-]*\s*$/.exec(lines[before]!) : null;
  if (opener) {
    const marker = opener[1]!;
    for (let index = lines.length - 1; index > start; index -= 1) {
      const closer = /^\s*(`{3,}|~{3,})\s*$/.exec(lines[index]!)?.[1];
      if (closer && closer[0] === marker[0] && closer.length >= marker.length) {
        end = index;
        break;
      }
    }
  }
  const sections: Partial<Record<Section, Block>> = {};
  let current: Block | null = null;
  for (const line of withFences(lines.slice(start, end))) {
    const heading = line.inFence ? null : SECTION_HEADING.exec(line.text);
    if (heading) {
      const key = heading[1]!.toLowerCase() as Section;
      current = sections[key] ?? { heading: line.text.replace(/^#\s+/, "").trim(), lines: [] };
      sections[key] = current;
    } else {
      current?.lines.push(line.text);
    }
  }
  return sections;
}

function withFences(lines: string[]): { text: string; inFence: boolean }[] {
  let fence: string | null = null;
  return lines.map((text) => {
    const marker = FENCE.exec(text)?.[1];
    const inFence = fence !== null;
    if (marker && fence === null) fence = marker;
    else if (marker && fence && marker[0] === fence[0] && marker.length >= fence.length) {
      fence = null;
    }
    return { text, inFence: inFence || fence !== null };
  });
}

/** Lines before the first `## ` heading form a block with an empty heading. */
function subsections(lines: string[]): Block[] {
  const blocks: Block[] = [{ heading: "", lines: [] }];
  for (const line of withFences(lines)) {
    const heading = line.inFence ? null : SUBSECTION_HEADING.exec(line.text);
    if (heading) blocks.push({ heading: heading[1]!, lines: [] });
    else blocks.at(-1)!.lines.push(line.text);
  }
  return blocks;
}

function memoryDocuments(lines: string[]): AgentImportMemory[] {
  const used = new Set<string>();
  return subsections(lines).flatMap((block) => {
    const body = markdown(block.lines);
    if (!body) return [];
    if (!block.heading) {
      used.add("memory.md");
      return [memoryItem("MEMORY.md", "MEMORY.md", "MEMORY.md", body)];
    }
    const path = freeName(`${slug(block.heading)}.md`, used, ".md");
    return [memoryItem(path, block.heading, path, `# ${block.heading}\n\n${body}`)];
  });
}

function skillDocuments(section: Block): Pick<AgentImportParse, "skills" | "skipped"> {
  const skills: AgentImportSkill[] = [];
  const skipped: AgentImportParse["skipped"] = [];
  const used = new Set<string>();
  for (const block of subsections(section.lines).slice(1)) {
    const [first = "", ...rest] = markdown(block.lines).split("\n");
    const description = first.replace(/^\s*(?:[*_]*description[*_]*\s*:\s*)/i, "").trim();
    let content: string | null = null;
    try {
      content = buildSkillMd({ name: block.heading, description, body: rest.join("\n").trim() });
    } catch {
      content = null;
    }
    const item = content
      ? skillItem(`skills:${freeName(slug(block.heading), used, "")}`, `${content}\n`)
      : null;
    if (item) skills.push(item);
    else skipped.push({ path: `${section.heading}/${block.heading}`, reason: "invalid_skill" });
  }
  return { skills, skipped };
}

function markdown(lines: string[]): string {
  const text = lines.join("\n").trim();
  return text ? `${text}\n` : "";
}

function slug(title: string): string {
  const value = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return value || "note";
}
