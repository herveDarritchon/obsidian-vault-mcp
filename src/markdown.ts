import yaml from "js-yaml";

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

export interface NoteRetrievalMetadata {
  frontmatter: Record<string, unknown>;
  contentWithoutFrontmatter: string;
  title: string | undefined;
  aliases: string[];
  tags: string[];
  headings: string[];
  frontmatterFields: Array<{ key: string; value: string }>;
  bodyText: string;
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

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const results: string[] = [];

  for (const value of values.map((entry) => collapseWhitespace(String(entry))).filter(Boolean)) {
    const key = value.toLowerCase();

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    results.push(value);
  }

  return results;
}

function normalizeScalarList(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => normalizeScalarList(entry));
  }

  if (typeof value === "string") {
    const trimmed = value.trim();

    if (!trimmed) {
      return [];
    }

    if (trimmed.includes(",")) {
      return trimmed.split(",").map((entry) => entry.trim()).filter(Boolean);
    }

    return [trimmed];
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }

  return [];
}

function normalizeTagList(value: unknown): string[] {
  return uniqueStrings(
    normalizeScalarList(value).map((entry) => entry.replace(/^#+/, "").trim()).filter(Boolean)
  );
}

function extractInlineTags(fullText: string): string[] {
  const matches = fullText.match(/(^|[^\w])#([A-Za-z][\w/-]*)/g) ?? [];
  return uniqueStrings(
    matches
      .map((entry) => /#([A-Za-z][\w/-]*)/.exec(entry)?.[1] ?? "")
      .map((entry) => entry.replace(/^#+/, "").trim())
      .filter(Boolean)
  );
}

function splitFrontmatter(fullText: string): { frontmatter: Record<string, unknown>; contentWithoutFrontmatter: string } {
  const lines = fullText.split(/\r?\n/);

  if ((lines[0] ?? "").trim() !== "---") {
    return {
      frontmatter: {},
      contentWithoutFrontmatter: fullText
    };
  }

  let closingIndex = -1;

  for (let index = 1; index < lines.length; index += 1) {
    if (/^(---|\.{3})\s*$/.test(lines[index] ?? "")) {
      closingIndex = index;
      break;
    }
  }

  if (closingIndex < 0) {
    return {
      frontmatter: {},
      contentWithoutFrontmatter: fullText
    };
  }

  const rawFrontmatter = lines.slice(1, closingIndex).join("\n");
  let frontmatter: Record<string, unknown> = {};

  try {
    const parsed = yaml.load(rawFrontmatter);
    frontmatter =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
  } catch {
    frontmatter = {};
  }

  return {
    frontmatter,
    contentWithoutFrontmatter: lines.slice(closingIndex + 1).join("\n")
  };
}

function collectFrontmatterFields(
  value: unknown,
  key: string,
  results: Array<{ key: string; value: string }>
): void {
  if (value === undefined || value === null) {
    return;
  }

  if (Array.isArray(value)) {
    const scalarValues = normalizeScalarList(value);

    if (scalarValues.length > 0) {
      for (const scalarValue of scalarValues) {
        results.push({ key, value: scalarValue });
      }
      return;
    }

    for (const entry of value) {
      collectFrontmatterFields(entry, key, results);
    }
    return;
  }

  if (typeof value === "object") {
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      collectFrontmatterFields(childValue, `${key}.${childKey}`, results);
    }
    return;
  }

  results.push({ key, value: String(value) });
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
  const metadata = extractNoteRetrievalMetadata(fullText);
  const headings = metadata.headings.slice(0, options.maxHeadings);
  const blocks = extractTextBlocks(metadata.contentWithoutFrontmatter);
  const excerptSource = blocks.slice(0, 3).join(" ");
  const summarySource = blocks.slice(0, 2).join(" ");
  const fallback = headings.slice(0, 3).join(" | ");

  return {
    summary: truncateAtWord(summarySource || fallback || "No summary available.", options.maxSummaryChars),
    excerpt: truncateAtWord(excerptSource || summarySource || fallback || "No excerpt available.", options.maxExcerptChars),
    headings
  };
}

export function extractNoteRetrievalMetadata(fullText: string): NoteRetrievalMetadata {
  const { frontmatter, contentWithoutFrontmatter } = splitFrontmatter(fullText);
  const headings = extractHeadings(contentWithoutFrontmatter, Number.MAX_SAFE_INTEGER);
  const aliases = uniqueStrings(
    normalizeScalarList(frontmatter.aliases ?? frontmatter.alias)
  );
  const tags = uniqueStrings([
    ...normalizeTagList(frontmatter.tags ?? frontmatter.tag),
    ...extractInlineTags(contentWithoutFrontmatter)
  ]);
  const title = normalizeScalarList(frontmatter.title)[0];
  const frontmatterFields: Array<{ key: string; value: string }> = [];

  for (const [key, value] of Object.entries(frontmatter)) {
    if (["title", "alias", "aliases", "tag", "tags"].includes(key)) {
      continue;
    }

    collectFrontmatterFields(value, key, frontmatterFields);
  }

  return {
    frontmatter,
    contentWithoutFrontmatter,
    title,
    aliases,
    tags,
    headings,
    frontmatterFields: uniqueStrings(
      frontmatterFields.map((entry) => `${entry.key}\u0000${entry.value}`)
    ).map((entry) => {
      const [key, value] = entry.split("\u0000");
      return { key: key ?? "", value: value ?? "" };
    }),
    bodyText: extractTextBlocks(contentWithoutFrontmatter).join("\n\n")
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
