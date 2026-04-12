import type { ChangeMode, DraftDiffSummary, NoteChange } from "./types.js";

interface NoteExcerptOptions {
  maxExcerptChars: number;
  maxSummaryChars: number;
  maxHeadings: number;
}

interface NoteExcerpt {
  summary: string;
  excerpt: string;
  headings: string[];
}

function countLines(value: string): number {
  return value === "" ? 0 : value.split(/\r?\n/).length;
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateAtWord(value: string, maxChars: number): string {
  const normalized = collapseWhitespace(value);

  if (normalized.length <= maxChars) {
    return normalized;
  }

  const sliced = normalized.slice(0, Math.max(0, maxChars - 1));
  const lastSpace = sliced.lastIndexOf(" ");
  const truncated = lastSpace >= Math.floor(maxChars * 0.6) ? sliced.slice(0, lastSpace) : sliced;
  return `${truncated.trimEnd()}…`;
}

function normalizeInlineMarkdown(value: string): string {
  return value
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`~]+/g, "");
}

function extractHeadings(fullText: string, maxHeadings: number): string[] {
  if (maxHeadings <= 0) {
    return [];
  }

  return fullText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(#+)\s+/.test(line))
    .slice(0, maxHeadings);
}

function extractTextBlocks(fullText: string): string[] {
  const lines = fullText.split(/\r?\n/);
  const blocks: string[] = [];
  let buffer: string[] = [];
  let inCodeFence = false;

  const flushBuffer = () => {
    const block = collapseWhitespace(buffer.join(" "));

    if (block) {
      blocks.push(block);
    }

    buffer = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      flushBuffer();
      inCodeFence = !inCodeFence;
      continue;
    }

    if (inCodeFence) {
      continue;
    }

    if (!trimmed) {
      flushBuffer();
      continue;
    }

    if (/^(#+)\s+/.test(trimmed)) {
      flushBuffer();
      continue;
    }

    const normalized = normalizeInlineMarkdown(trimmed)
      .replace(/^[-*+]\s+/, "")
      .replace(/^\d+\.\s+/, "");

    if (normalized) {
      buffer.push(normalized);
    }
  }

  flushBuffer();
  return blocks;
}

export function buildNoteExcerpt(fullText: string, options: NoteExcerptOptions): NoteExcerpt {
  const headings = extractHeadings(fullText, options.maxHeadings);
  const blocks = extractTextBlocks(fullText);
  const excerptSource = blocks.slice(0, 3).join(" ");
  const summarySource = blocks.slice(0, 2).join(" ");
  const fallback = headings.slice(0, 3).join(" | ");

  return {
    summary: truncateAtWord(summarySource || fallback || "No summary available.", options.maxSummaryChars),
    excerpt: truncateAtWord(excerptSource || summarySource || fallback || "No excerpt available.", options.maxExcerptChars),
    headings
  };
}

function headingDepth(heading: string): number {
  const match = /^(#+)\s+/.exec(heading.trim());

  if (!match) {
    throw new Error(`Invalid ATX heading: ${heading}`);
  }

  return match[1]!.length;
}

function findSectionRange(lines: string[], heading: string): { startIndex: number; endIndex: number; target: string } {
  const target = heading.trim();
  const startIndex = lines.findIndex((line) => line.trim() === target);

  if (startIndex < 0) {
    throw new Error(`Section not found: ${heading}`);
  }

  const targetDepth = headingDepth(target);
  let endIndex = lines.length;

  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = (lines[index] ?? "").trim();
    const match = /^(#+)\s+/.exec(line);

    if (match && match[1]!.length <= targetDepth) {
      endIndex = index;
      break;
    }
  }

  return {
    startIndex,
    endIndex,
    target
  };
}

export function extractSection(fullText: string, heading: string): string {
  const lines = fullText.split(/\r?\n/);
  const { startIndex, endIndex } = findSectionRange(lines, heading);

  return ensureTrailingNewline(lines.slice(startIndex, endIndex).join("\n").trimEnd());
}

function replaceSection(fullText: string, heading: string, replacement: string): string {
  const lines = fullText.split(/\r?\n/);
  const { startIndex, endIndex } = findSectionRange(lines, heading);

  const replacementLines = ensureTrailingNewline(replacement.trimEnd()).split(/\r?\n/);
  const nextLines = [
    ...lines.slice(0, startIndex),
    ...replacementLines,
    ...lines.slice(endIndex)
  ];

  return ensureTrailingNewline(nextLines.join("\n").replace(/\n{3,}/g, "\n\n"));
}

export function applyChange(current: string, change: Pick<NoteChange, "mode" | "content" | "section_heading">): string {
  const normalizedCurrent = current;

  switch (change.mode) {
    case "replace_full":
      return ensureTrailingNewline(change.content.trimEnd());
    case "append":
      if (normalizedCurrent.trim().length === 0) {
        return ensureTrailingNewline(change.content.trim());
      }

      return `${normalizedCurrent.trimEnd()}\n\n${change.content.trim()}\n`;
    case "replace_section":
      if (!change.section_heading) {
        throw new Error("section_heading is required for replace_section mode.");
      }

      return replaceSection(normalizedCurrent, change.section_heading, change.content);
    default: {
      const exhaustiveCheck: never = change.mode;
      throw new Error(`Unsupported change mode: ${String(exhaustiveCheck)}`);
    }
  }
}

export function buildDiffSummary(
  current: string,
  next: string,
  change: Pick<NoteChange, "mode" | "section_heading">
): DraftDiffSummary {
  const lineDelta = countLines(next) - countLines(current);

  switch (change.mode) {
    case "replace_section":
      return {
        changed_sections: change.section_heading ? [change.section_heading] : [],
        line_delta: lineDelta
      };
    case "append":
      return {
        changed_sections: ["__append__"],
        line_delta: lineDelta
      };
    case "replace_full":
      return {
        changed_sections: ["__full__"],
        line_delta: lineDelta
      };
    default: {
      const exhaustiveCheck: never = change.mode;
      throw new Error(`Unsupported change mode: ${String(exhaustiveCheck)}`);
    }
  }
}
