import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { VaultTargetConfig } from "./config.js";
import { RefusalError } from "./errors.js";
import { GitHubClient } from "./github.js";
import { sha256 } from "./lib/hash.js";
import { normalizeVaultPath, resolveVaultPath, toVaultRelativePath } from "./lib/paths.js";
import {
  applyChange,
  buildNoteExcerpt,
  buildDiffSummary,
  extractNoteRetrievalMetadata,
  extractSection,
  type NoteRetrievalMetadata
} from "./markdown.js";
import { VaultPolicyEngine } from "./policy.js";
import type {
  OpenAIFetchResult,
  ListNotesResult,
  NoteChange,
  OpenAISearchResultSet,
  ProposeChangeResult,
  ReadNoteResult,
  ReadNoteExcerptResult,
  ReadSectionResult,
  SearchNotesResult,
  SearchResult,
  UpdateDraftResult
} from "./types.js";

const execFileAsync = promisify(execFile);
const IGNORED_DIRECTORIES = new Set([".git", ".obsidian", "node_modules"]);
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdx"]);

interface GitOptions {
  cwd?: string;
}

interface PreparedChange {
  safePath: string;
  next: string;
  scopeBucket: string;
}

interface DocumentDescriptor {
  id: string;
  title: string;
  path: string;
  url: string;
}

type BasicSearchResult = Pick<SearchResult, "path" | "snippet" | "score">;

interface SearchQueryContext {
  raw: string;
  normalized: string;
  tokens: string[];
}

interface SearchFieldWeights {
  exact: number;
  token: number;
  fullCoverageBonus: number;
  fuzzy: number;
  fuzzyThreshold: number;
}

interface SearchFieldMatch {
  kind: "title" | "alias" | "tag" | "heading" | "frontmatter" | "path" | "body";
  value: string;
  score: number;
  exactMatches: number;
  tokenMatches: number;
  fuzzy: number;
}

const SEARCH_FIELD_WEIGHTS: Record<SearchFieldMatch["kind"], SearchFieldWeights> = {
  title: { exact: 18, token: 10, fullCoverageBonus: 5, fuzzy: 6, fuzzyThreshold: 0.45 },
  alias: { exact: 16, token: 9, fullCoverageBonus: 4, fuzzy: 5, fuzzyThreshold: 0.45 },
  tag: { exact: 14, token: 8, fullCoverageBonus: 4, fuzzy: 4, fuzzyThreshold: 0.4 },
  heading: { exact: 12, token: 7, fullCoverageBonus: 3, fuzzy: 4, fuzzyThreshold: 0.45 },
  frontmatter: { exact: 8, token: 5, fullCoverageBonus: 2, fuzzy: 3, fuzzyThreshold: 0.55 },
  path: { exact: 7, token: 4, fullCoverageBonus: 1, fuzzy: 2, fuzzyThreshold: 0.55 },
  body: { exact: 6, token: 3, fullCoverageBonus: 0, fuzzy: 2, fuzzyThreshold: 0.72 }
};

function buildSnippet(content: string, query: string, maxLength = 220): string {
  const lowerContent = content.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const matchIndex = lowerContent.indexOf(lowerQuery);

  if (matchIndex < 0) {
    return content.trim().slice(0, maxLength);
  }

  const start = Math.max(0, matchIndex - 80);
  const end = Math.min(content.length, matchIndex + query.length + 140);
  return content
    .slice(start, end)
    .replace(/\s+/g, " ")
    .trim();
}

function isMarkdownFile(filePath: string): boolean {
  return MARKDOWN_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function countLines(content: string): number {
  return content === "" ? 0 : content.split(/\r?\n/).length;
}

function deriveScopeBucket(relativePath: string): string {
  const segments = normalizeVaultPath(relativePath).split("/");
  const directorySegments = segments.slice(0, -1);

  if (directorySegments.length <= 2) {
    return directorySegments.join("/");
  }

  return directorySegments.slice(0, 3).join("/");
}

function ensureBranchName(branchName: string): string {
  const trimmed = branchName.trim();

  if (!trimmed) {
    throw new RefusalError("branch_name is required.");
  }

  if (
    trimmed.startsWith("-") ||
    trimmed.startsWith("/") ||
    trimmed.endsWith("/") ||
    trimmed.endsWith(".") ||
    trimmed.endsWith(".lock") ||
    trimmed.includes("..") ||
    trimmed.includes("//") ||
    !/^[A-Za-z0-9._/-]+$/.test(trimmed)
  ) {
    throw new RefusalError(`Invalid git branch name: ${branchName}`);
  }

  if (!/^ai\/[a-z0-9._-]+\/[a-z0-9._/-]+$/.test(trimmed)) {
    throw new RefusalError(`Branch must follow the convention ai/<scope>/<slug>: ${branchName}`);
  }

  return trimmed;
}

function extractBranchScope(branchName: string): string {
  const segments = branchName.split("/");
  return segments[1] ?? "";
}

function ensureCommitMessage(commitMessage: string, expectedScope: string): string {
  const trimmed = commitMessage.trim();
  const match = /^ai\(([a-z0-9._-]+)\): .+$/.exec(trimmed);

  if (!match) {
    throw new RefusalError(
      `Commit message must follow the convention ai(<scope>): <action courte>: ${commitMessage}`
    );
  }

  if (match[1] !== expectedScope) {
    throw new RefusalError(
      `Commit scope must match branch scope (${expectedScope}): ${commitMessage}`
    );
  }

  return trimmed;
}

function buildPullRequestBody(prBody: string, changedFiles: string[]): string {
  const trimmedBody = prBody.trim();
  const fileList = changedFiles.map((filePath) => `- ${filePath}`).join("\n");
  const scopeSection = `\n\nChanged files:\n${fileList}`;

  if (trimmedBody.includes("Changed files:")) {
    return trimmedBody;
  }

  if (!trimmedBody) {
    return `Automated policy-checked change.${scopeSection}`;
  }

  return `${trimmedBody}${scopeSection}`;
}

function scorePath(query: string, filePath: string): number {
  return filePath.toLowerCase().includes(query.toLowerCase()) ? 0.5 : 0;
}

function extractNoteTitle(content: string, relativePath: string): string {
  const metadata = extractNoteRetrievalMetadata(content);

  if (metadata.title) {
    return metadata.title;
  }

  const heading = metadata.headings.find((line) => /^#\s+/.test(line)) ?? metadata.headings[0];

  if (heading) {
    return heading.replace(/^#+\s+/, "").trim();
  }

  return path.basename(relativePath, path.extname(relativePath)).replace(/[-_]+/g, " ");
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}#/_-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalizeSearchToken(value: string): string {
  if (value.length <= 3) {
    return value;
  }

  if (value.endsWith("ies") && value.length > 4) {
    return `${value.slice(0, -3)}y`;
  }

  if (/(ches|shes|xes|zes|ses|oes)$/.test(value) && value.length > 4) {
    return value.slice(0, -2);
  }

  if (value.endsWith("s") && !value.endsWith("ss") && value.length > 3) {
    return value.slice(0, -1);
  }

  if (value.endsWith("ing") && value.length > 5) {
    return value.slice(0, -3);
  }

  if (value.endsWith("ed") && value.length > 4) {
    return value.slice(0, -2);
  }

  return value;
}

function tokenizeSearchText(value: string): string[] {
  const unique = new Set<string>();

  for (const token of normalizeSearchText(value)
    .split(" ")
    .map((entry) => canonicalizeSearchToken(entry.replace(/^#+/, "").trim()))
    .filter(Boolean)) {
    if (token.length >= 2 || /^\d+$/.test(token)) {
      unique.add(token);
    }
  }

  return Array.from(unique);
}

function countExactMatches(query: string, content: string): number {
  if (!query || !content) {
    return 0;
  }

  let position = 0;
  let matches = 0;

  while (position >= 0) {
    position = content.indexOf(query, position);

    if (position >= 0) {
      matches += 1;
      position += query.length;
    }
  }

  return matches;
}

function buildCharacterTrigrams(value: string): Set<string> {
  const compact = value.replace(/\s+/g, "");

  if (!compact) {
    return new Set<string>();
  }

  if (compact.length <= 3) {
    return new Set([compact]);
  }

  const trigrams = new Set<string>();

  for (let index = 0; index <= compact.length - 3; index += 1) {
    trigrams.add(compact.slice(index, index + 3));
  }

  return trigrams;
}

function diceCoefficient(left: string, right: string): number {
  if (!left || !right) {
    return 0;
  }

  if (left === right) {
    return 1;
  }

  const leftTrigrams = buildCharacterTrigrams(left);
  const rightTrigrams = buildCharacterTrigrams(right);

  if (leftTrigrams.size === 0 || rightTrigrams.size === 0) {
    return 0;
  }

  let overlap = 0;

  for (const trigram of leftTrigrams) {
    if (rightTrigrams.has(trigram)) {
      overlap += 1;
    }
  }

  return (2 * overlap) / (leftTrigrams.size + rightTrigrams.size);
}

function evaluateSearchField(
  query: SearchQueryContext,
  kind: SearchFieldMatch["kind"],
  value: string
): SearchFieldMatch | null {
  const normalizedValue = normalizeSearchText(value);

  if (!normalizedValue) {
    return null;
  }

  const weights = SEARCH_FIELD_WEIGHTS[kind];
  const exactMatches = countExactMatches(query.normalized, normalizedValue);
  const fieldTokens = new Set(tokenizeSearchText(normalizedValue));
  const tokenMatches = query.tokens.filter((token) => fieldTokens.has(token)).length;
  const fuzzy = diceCoefficient(query.normalized, normalizedValue);

  if (exactMatches === 0 && tokenMatches === 0 && fuzzy < weights.fuzzyThreshold) {
    return null;
  }

  let score = exactMatches * weights.exact;

  if (query.tokens.length > 0 && tokenMatches > 0) {
    score += (tokenMatches / query.tokens.length) * weights.token;

    if (tokenMatches === query.tokens.length && query.tokens.length > 1) {
      score += weights.fullCoverageBonus;
    }
  }

  if (fuzzy >= weights.fuzzyThreshold) {
    score += fuzzy * weights.fuzzy;
  }

  return {
    kind,
    value,
    score,
    exactMatches,
    tokenMatches,
    fuzzy
  };
}

function buildStructuredSnippet(query: SearchQueryContext, match: SearchFieldMatch): string {
  if (match.kind === "body") {
    return buildSnippet(match.value, query.raw, 220);
  }

  const labelByKind: Record<Exclude<SearchFieldMatch["kind"], "body">, string> = {
    title: "Title",
    alias: "Alias",
    tag: "Tag",
    heading: "Heading",
    frontmatter: "Frontmatter",
    path: "Path"
  };
  const displayValue = match.kind === "tag" ? `#${match.value.replace(/^#+/, "")}` : match.value;
  const labeled = `${labelByKind[match.kind]}: ${displayValue}`;

  return labeled.length <= 220 ? labeled : `${labeled.slice(0, 219).trimEnd()}…`;
}

function buildGitHubRepoWebBase(apiBaseUrl: string): string {
  const parsed = new URL(apiBaseUrl);

  if (parsed.hostname === "api.github.com") {
    return "https://github.com";
  }

  const pathname = parsed.pathname.replace(/\/api\/v3\/?$/, "").replace(/\/$/, "");
  return `${parsed.protocol}//${parsed.host}${pathname}`;
}

function encodePathForUrl(relativePath: string): string {
  return normalizeVaultPath(relativePath)
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function encodeStableDocumentId(targetName: string, relativePath: string): string {
  const encodedTarget = encodeURIComponent(targetName);
  const encodedPath = Buffer.from(normalizeVaultPath(relativePath), "utf8").toString("base64url");
  return `obsidian-vault:v1:${encodedTarget}:${encodedPath}`;
}

function decodeStableDocumentId(
  identifier: string,
  expectedTargetName: string
): string | null {
  const match = /^obsidian-vault:v1:([^:]+):([A-Za-z0-9_-]+)$/.exec(identifier.trim());

  if (!match) {
    return null;
  }

  const targetName = decodeURIComponent(match[1] ?? "");
  if (targetName !== expectedTargetName) {
    return null;
  }

  try {
    const relativePath = Buffer.from(match[2] ?? "", "base64url").toString("utf8");
    return normalizeVaultPath(relativePath);
  } catch {
    return null;
  }
}

function decodeGitHubBlobPath(
  identifier: string,
  options: {
    owner: string;
    repo: string;
    defaultBranch: string;
    apiBaseUrl: string;
  }
): string | null {
  try {
    const parsed = new URL(identifier);
    const webBase = new URL(buildGitHubRepoWebBase(options.apiBaseUrl));

    if (parsed.origin !== webBase.origin) {
      return null;
    }

    const expectedPrefix = `${webBase.pathname.replace(/\/$/, "")}/${options.owner}/${options.repo}/blob/${encodeURIComponent(options.defaultBranch)}/`;
    const normalizedPath = parsed.pathname;

    if (!normalizedPath.startsWith(expectedPrefix)) {
      return null;
    }

    const encodedRelativePath = normalizedPath.slice(expectedPrefix.length);
    const relativePath = encodedRelativePath
      .split("/")
      .map((segment) => decodeURIComponent(segment))
      .join("/");

    return normalizeVaultPath(relativePath);
  } catch {
    return null;
  }
}

export class VaultService {
  private constructor(
    private readonly config: VaultTargetConfig,
    private readonly policy: VaultPolicyEngine,
    private readonly github: GitHubClient
  ) {}

  static async create(config: VaultTargetConfig): Promise<VaultService> {
    const policy = await VaultPolicyEngine.load(config.vaultPolicyFile);
    const github = new GitHubClient({
      apiBaseUrl: config.githubApiBaseUrl,
      owner: config.githubOwner,
      repo: config.githubRepo,
      ...(config.githubToken ? { token: config.githubToken } : {})
    });

    return new VaultService(config, policy, github);
  }

  readNote(relativePath: string): Promise<ReadNoteResult> {
    return this.readNoteFromRoot(this.config.vaultRepoRoot, relativePath);
  }

  async readSection(relativePath: string, sectionHeading: string): Promise<ReadSectionResult> {
    const note = await this.readNote(relativePath);

    return {
      id: note.id,
      title: note.title,
      path: note.path,
      url: note.url,
      section_heading: sectionHeading.trim(),
      note_sha256: note.sha256,
      content: extractSection(note.content, sectionHeading),
      policy: note.policy
    };
  }

  async readNoteExcerpt(
    relativePath: string,
    options: {
      maxExcerptChars: number;
      maxSummaryChars: number;
      maxHeadings: number;
    }
  ): Promise<ReadNoteExcerptResult> {
    const note = await this.readNote(relativePath);
    const excerpt = buildNoteExcerpt(note.content, options);

    return {
      id: note.id,
      title: note.title,
      path: note.path,
      url: note.url,
      note_sha256: note.sha256,
      ...excerpt,
      policy: note.policy
    };
  }

  async listNotes(root: string | undefined, limit: number): Promise<ListNotesResult> {
    const [resolvedRoot] = await this.resolveSearchRoots(root ? [root] : ["."]);
    const results: Array<{ id: string; title: string; path: string; url: string }> = [];

    if (resolvedRoot?.stats.isFile()) {
      const relativePath = toVaultRelativePath(this.config.vaultRepoRoot, resolvedRoot.absolutePath);
      const access = this.policy.accessForPath(relativePath);

      if (access.read && isMarkdownFile(relativePath)) {
        results.push(await this.describeDocument(relativePath));
      }
    } else if (resolvedRoot) {
      await this.listDirectory(resolvedRoot.absolutePath, results, limit);
    }

    results.sort((left, right) => left.path.localeCompare(right.path));
    return {
      root: resolvedRoot?.safeRoot ?? ".",
      results: results.slice(0, limit)
    };
  }

  async searchNotes(query: string, roots: string[] | undefined, limit: number): Promise<SearchNotesResult> {
    const trimmedQuery = query.trim();

    if (!trimmedQuery) {
      throw new RefusalError("query is required.");
    }

    const requestedRoots = await this.resolveSearchRoots(roots);
    const ripgrepResults = await this.searchWithRipgrep(
      requestedRoots.map((root) => root.absolutePath),
      trimmedQuery
    );
    const lexicalScores = new Map<string, number>(
      (ripgrepResults ?? []).map((result) => [result.path, result.score])
    );
    const results: BasicSearchResult[] = [];
    const queryContext: SearchQueryContext = {
      raw: trimmedQuery,
      normalized: normalizeSearchText(trimmedQuery),
      tokens: tokenizeSearchText(trimmedQuery)
    };

    for (const root of requestedRoots) {
      if (root.stats.isFile()) {
        const relativePath = toVaultRelativePath(this.config.vaultRepoRoot, root.absolutePath);
        await this.searchFile(relativePath, queryContext, results, lexicalScores.get(relativePath) ?? 0);
      } else {
        await this.searchDirectory(root.absolutePath, queryContext, lexicalScores, results);
      }
    }

    results.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
    return {
      results: await Promise.all(results.slice(0, limit).map((result) => this.enrichSearchResult(result)))
    };
  }

  async searchOpenAI(query: string, limit: number): Promise<OpenAISearchResultSet> {
    const searchResults = await this.searchNotes(query, undefined, limit);
    const results = await Promise.all(
      searchResults.results.map(async (result) => {
        const note = await this.readNote(result.path);

        return {
          id: note.id,
          title: note.title,
          path: note.path,
          excerpt: result.snippet,
          url: note.url,
          text: result.snippet
        };
      })
    );

    return { results };
  }

  async fetchOpenAI(identifier: string): Promise<OpenAIFetchResult> {
    const safePath = this.resolveOpenAIIdentifier(identifier);
    const note = await this.readNote(safePath);
    const retrieval = extractNoteRetrievalMetadata(note.content);

    return {
      id: note.id,
      title: note.title,
      path: note.path,
      content: note.content,
      text: note.content,
      url: note.url,
      metadata: {
        target: this.config.name,
        path: note.path,
        sha256: note.sha256,
        source: "obsidian-vault",
        aliases: retrieval.aliases,
        tags: retrieval.tags,
        headings: retrieval.headings,
        frontmatter: retrieval.frontmatter
      }
    };
  }

  resolveReadReference(input: { id?: string | undefined; path?: string | undefined }): string {
    const identifier = input.id?.trim();

    if (identifier) {
      return this.resolveOpenAIIdentifier(identifier);
    }

    const pathValue = input.path?.trim();

    if (pathValue) {
      return normalizeVaultPath(pathValue);
    }

    throw new RefusalError("Either id or path is required.");
  }

  async updateNoteDraft(change: NoteChange): Promise<UpdateDraftResult> {
    const safePath = normalizeVaultPath(change.path);
    const access = this.policy.accessForPath(safePath);

    if (!access.read) {
      throw new RefusalError(`Read denied by policy: ${safePath}`);
    }

    if (!access.write && !access.proposePatch) {
      throw new RefusalError(`Draft generation denied by policy: ${safePath}`);
    }

    const absolutePath = resolveVaultPath(this.config.vaultRepoRoot, safePath);
    const current = await fs.readFile(absolutePath, "utf8");
    const currentSha = sha256(current);

    if (change.expected_sha256 && change.expected_sha256 !== currentSha) {
      throw new Error(`expected_sha256 mismatch for ${safePath}`);
    }

    const draft = applyChange(current, change);
    const warnings = access.write
      ? []
      : ["This path is propose-only. propose_change will refuse direct writes here."];

    return {
      path: safePath,
      current_sha256: currentSha,
      draft_sha256: sha256(draft),
      draft_content: draft,
      diff_summary: buildDiffSummary(current, draft, change),
      warnings,
      policy: access
    };
  }

  async proposeChange(input: {
    title: string;
    base_branch: string;
    branch_name: string;
    commit_message: string;
    pr_body: string;
    changes: NoteChange[];
  }): Promise<ProposeChangeResult> {
    if (input.changes.length === 0) {
      throw new RefusalError("changes must contain at least one file.");
    }

    if (input.changes.length > this.config.maxChangeFiles) {
      throw new RefusalError(
        `Change set exceeds the configured file limit (${this.config.maxChangeFiles}).`
      );
    }

    const branchName = ensureBranchName(input.branch_name);
    const commitMessage = ensureCommitMessage(input.commit_message, extractBranchScope(branchName));
    const baseBranch = input.base_branch.trim() || "main";
    const seenPaths = new Set<string>();
    const preparedChanges: PreparedChange[] = [];
    const scopeBuckets = new Set<string>();
    let totalLineDelta = 0;

    for (const change of input.changes) {
      const safePath = normalizeVaultPath(change.path);
      const access = this.policy.accessForPath(safePath);

      if (!access.write) {
        throw new RefusalError(`Write denied by policy: ${safePath}`);
      }

      if (access.openPrOrMr !== "require") {
        throw new RefusalError(`PR-only workflow is not enabled for ${safePath}`);
      }

      if (seenPaths.has(safePath)) {
        throw new RefusalError(`Duplicate path in changes: ${safePath}`);
      }

      seenPaths.add(safePath);

      const absolutePath = resolveVaultPath(this.config.vaultRepoRoot, safePath);
      const current = await fs.readFile(absolutePath, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          throw new Error(`Target note does not exist: ${safePath}`);
        }

        throw error;
      });
      const currentSha = sha256(current);

      if (change.expected_sha256 && change.expected_sha256 !== currentSha) {
        throw new Error(`expected_sha256 mismatch for ${safePath}`);
      }

      const next = applyChange(current, change);
      const lineDelta = Math.abs(countLines(next) - countLines(current));
      totalLineDelta += lineDelta;

      const scopeBucket = deriveScopeBucket(safePath);
      scopeBuckets.add(scopeBucket);
      preparedChanges.push({
        safePath,
        next,
        scopeBucket
      });
    }

    if (scopeBuckets.size > 1) {
      throw new RefusalError(
        `Change set must stay within a single scope bucket. Received: ${Array.from(scopeBuckets).sort().join(", ")}`
      );
    }

    if (totalLineDelta > this.config.maxTotalLineDelta) {
      throw new RefusalError(
        `Change set exceeds the configured line delta limit (${this.config.maxTotalLineDelta}).`
      );
    }

    if (await this.branchExists(branchName)) {
      throw new RefusalError(`Branch already exists locally or remotely: ${branchName}`);
    }

    const worktreePath = await this.createWorktree(baseBranch);

    try {
      await this.git(["checkout", "-b", branchName], { cwd: worktreePath });

      for (const preparedChange of preparedChanges) {
        const absolutePath = resolveVaultPath(worktreePath, preparedChange.safePath);
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.writeFile(absolutePath, preparedChange.next, "utf8");
      }

      const changedFiles = Array.from(seenPaths).sort();
      await this.git(["add", ...changedFiles], { cwd: worktreePath });

      const stagedFiles = await this.git(["diff", "--cached", "--name-only"], { cwd: worktreePath });
      if (!stagedFiles.trim()) {
        throw new RefusalError("No file changes were staged. Refusing to create an empty commit.");
      }

      await this.commit(worktreePath, commitMessage);
      const commitSha = await this.git(["rev-parse", "HEAD"], { cwd: worktreePath });
      await this.git(["push", "-u", "origin", branchName], { cwd: worktreePath });

      const pullRequest = await this.github.createPullRequest({
        title: input.title,
        body: buildPullRequestBody(input.pr_body, changedFiles),
        head: branchName,
        base: baseBranch,
        draft: false
      });

      return {
        branch: branchName,
        commit_sha: commitSha.trim(),
        pull_request: pullRequest,
        changed_files: changedFiles
      };
    } finally {
      await this.removeWorktree(worktreePath);
    }
  }

  private async readNoteFromRoot(root: string, relativePath: string): Promise<ReadNoteResult> {
    const safePath = normalizeVaultPath(relativePath);
    const access = this.policy.accessForPath(safePath);

    if (!access.read) {
      throw new RefusalError(`Read denied by policy: ${safePath}`);
    }

    const absolutePath = resolveVaultPath(root, safePath);
    const content = await fs.readFile(absolutePath, "utf8");
    const descriptor = this.buildDocumentDescriptor(safePath, content);

    return {
      ...descriptor,
      path: safePath,
      sha256: sha256(content),
      content,
      policy: access
    };
  }

  private buildDocumentUrl(relativePath: string): string {
    const webBase = buildGitHubRepoWebBase(this.config.githubApiBaseUrl);
    const encodedPath = encodePathForUrl(relativePath);

    return `${webBase}/${this.config.githubOwner}/${this.config.githubRepo}/blob/${encodeURIComponent(this.config.githubDefaultBranch)}/${encodedPath}`;
  }

  private buildDocumentDescriptor(relativePath: string, content: string): DocumentDescriptor {
    return {
      id: encodeStableDocumentId(this.config.name, relativePath),
      title: extractNoteTitle(content, relativePath),
      path: relativePath,
      url: this.buildDocumentUrl(relativePath)
    };
  }

  private async describeDocument(relativePath: string): Promise<DocumentDescriptor> {
    const absolutePath = resolveVaultPath(this.config.vaultRepoRoot, relativePath);
    const content = await fs.readFile(absolutePath, "utf8");
    return this.buildDocumentDescriptor(relativePath, content);
  }

  private resolveOpenAIIdentifier(identifier: string): string {
    const trimmed = identifier.trim();

    if (!trimmed) {
      throw new RefusalError("id is required.");
    }

    const fromStableId = decodeStableDocumentId(trimmed, this.config.name);
    if (fromStableId) {
      return fromStableId;
    }

    const fromUrl = decodeGitHubBlobPath(trimmed, {
      owner: this.config.githubOwner,
      repo: this.config.githubRepo,
      defaultBranch: this.config.githubDefaultBranch,
      apiBaseUrl: this.config.githubApiBaseUrl
    });

    return fromUrl ?? normalizeVaultPath(trimmed);
  }

  private rankSearchResult(
    query: SearchQueryContext,
    descriptor: DocumentDescriptor,
    metadata: NoteRetrievalMetadata,
    lexicalBoost: number
  ): BasicSearchResult | null {
    const matches: SearchFieldMatch[] = [];
    const pushMatch = (match: SearchFieldMatch | null) => {
      if (match && match.score > 0) {
        matches.push(match);
      }
    };

    pushMatch(evaluateSearchField(query, "title", descriptor.title));
    pushMatch(evaluateSearchField(query, "path", descriptor.path));
    pushMatch(evaluateSearchField(query, "body", metadata.bodyText));

    for (const alias of metadata.aliases) {
      pushMatch(evaluateSearchField(query, "alias", alias));
    }

    for (const tag of metadata.tags) {
      pushMatch(evaluateSearchField(query, "tag", tag));
    }

    for (const heading of metadata.headings) {
      pushMatch(evaluateSearchField(query, "heading", heading));
    }

    for (const field of metadata.frontmatterFields) {
      pushMatch(evaluateSearchField(query, "frontmatter", `${field.key}: ${field.value}`));
    }

    if (matches.length === 0 && lexicalBoost <= 0) {
      return null;
    }

    const combinedTokenMatches = new Set<string>();
    for (const token of query.tokens) {
      if (matches.some((match) => tokenizeSearchText(match.value).includes(token))) {
        combinedTokenMatches.add(token);
      }
    }

    const tokenCoverage = query.tokens.length === 0 ? 1 : combinedTokenMatches.size / query.tokens.length;
    const bestMatch = matches.sort((left, right) => right.score - left.score)[0] ?? null;
    const score =
      matches.reduce((total, match) => total + match.score, 0) +
      lexicalBoost * 4 +
      tokenCoverage * 6;

    if (score < 4) {
      return null;
    }

    if (lexicalBoost === 0 && tokenCoverage < 0.6 && (bestMatch?.fuzzy ?? 0) < 0.82) {
      return null;
    }

    return {
      path: descriptor.path,
      snippet:
        bestMatch
          ? buildStructuredSnippet(query, bestMatch)
          : buildSnippet(metadata.bodyText || metadata.contentWithoutFrontmatter, query.raw, 220),
      score
    };
  }

  private async enrichSearchResult(result: BasicSearchResult): Promise<SearchResult> {
    const descriptor = await this.describeDocument(result.path);

    return {
      ...descriptor,
      snippet: result.snippet,
      score: result.score
    };
  }

  private async searchDirectory(
    absoluteRoot: string,
    query: SearchQueryContext,
    lexicalScores: Map<string, number>,
    results: BasicSearchResult[]
  ): Promise<void> {
    const entries = await fs.readdir(absoluteRoot, { withFileTypes: true });

    for (const entry of entries) {
      if (IGNORED_DIRECTORIES.has(entry.name)) {
        continue;
      }

      const absolutePath = path.join(absoluteRoot, entry.name);

      if (entry.isDirectory()) {
        await this.searchDirectory(absolutePath, query, lexicalScores, results);
        continue;
      }

      if (!entry.isFile() || !isMarkdownFile(entry.name)) {
        continue;
      }

      const relativePath = toVaultRelativePath(this.config.vaultRepoRoot, absolutePath);
      await this.searchFile(relativePath, query, results, lexicalScores.get(relativePath) ?? 0);
    }
  }

  private async listDirectory(
    absoluteRoot: string,
    results: Array<{ id: string; title: string; path: string; url: string }>,
    limit: number
  ): Promise<void> {
    const entries = await fs.readdir(absoluteRoot, { withFileTypes: true });

    for (const entry of entries) {
      if (results.length >= limit) {
        return;
      }

      if (IGNORED_DIRECTORIES.has(entry.name)) {
        continue;
      }

      const absolutePath = path.join(absoluteRoot, entry.name);

      if (entry.isDirectory()) {
        await this.listDirectory(absolutePath, results, limit);
        continue;
      }

      if (!entry.isFile() || !isMarkdownFile(entry.name)) {
        continue;
      }

      const relativePath = toVaultRelativePath(this.config.vaultRepoRoot, absolutePath);
      const access = this.policy.accessForPath(relativePath);

      if (!access.read) {
        continue;
      }

      results.push(await this.describeDocument(relativePath));
    }
  }

  private async searchFile(
    relativePath: string,
    query: SearchQueryContext,
    results: BasicSearchResult[],
    lexicalBoost: number
  ): Promise<void> {
    const access = this.policy.accessForPath(relativePath);

    if (!access.read) {
      return;
    }

    const absolutePath = resolveVaultPath(this.config.vaultRepoRoot, relativePath);
    const content = await fs.readFile(absolutePath, "utf8");
    const metadata = extractNoteRetrievalMetadata(content);
    const descriptor = this.buildDocumentDescriptor(relativePath, content);
    const result = this.rankSearchResult(query, descriptor, metadata, lexicalBoost);

    if (!result) {
      return;
    }

    results.push(result);
  }

  private async resolveSearchRoots(roots: string[] | undefined) {
    const requestedRoots = roots && roots.length > 0 ? roots : ["."];

    return Promise.all(
      requestedRoots.map(async (root) => {
        if (root === ".") {
          const stats = await fs.stat(this.config.vaultRepoRoot);
          return {
            safeRoot: ".",
            absolutePath: this.config.vaultRepoRoot,
            stats
          };
        }

        const safeRoot = normalizeVaultPath(root);

        if (!this.policy.allowsReadBelow(safeRoot)) {
          throw new RefusalError(`Search denied by policy: ${safeRoot}`);
        }

        const absolutePath = resolveVaultPath(this.config.vaultRepoRoot, safeRoot);
        const stats = await fs.stat(absolutePath).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") {
            throw new Error(`Search root does not exist: ${safeRoot}`);
          }

          throw error;
        });

        return {
          safeRoot,
          absolutePath,
          stats
        };
      })
    );
  }

  private async searchWithRipgrep(
    absoluteRoots: string[],
    query: string
  ): Promise<BasicSearchResult[] | null> {
    const args = [
      "--json",
      "--fixed-strings",
      "--ignore-case",
      "--line-number",
      "--glob",
      "*.md",
      "--glob",
      "*.markdown",
      "--glob",
      "*.mdx",
      query,
      ...absoluteRoots
    ];

    try {
      const { stdout } = await execFileAsync("rg", args, {
        cwd: this.config.vaultRepoRoot,
        maxBuffer: 10 * 1024 * 1024
      });

      return this.parseRipgrepResults(stdout, query);
    } catch (error: unknown) {
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;

      if (code === 1) {
        return [];
      }

      if (code === "ENOENT") {
        return null;
      }

      return null;
    }
  }

  private parseRipgrepResults(stdout: string, query: string): BasicSearchResult[] {
    const aggregated = new Map<string, BasicSearchResult>();

    for (const line of stdout.split("\n")) {
      if (!line.trim()) {
        continue;
      }

      const parsed = JSON.parse(line) as {
        type?: string;
        data?: {
          path?: { text?: string };
          lines?: { text?: string };
        };
      };

      if (parsed.type !== "match") {
        continue;
      }

      const absolutePath = parsed.data?.path?.text;
      const lineText = parsed.data?.lines?.text ?? "";

      if (!absolutePath) {
        continue;
      }

      const relativePath = toVaultRelativePath(this.config.vaultRepoRoot, absolutePath);
      if (!isMarkdownFile(relativePath)) {
        continue;
      }

      const access = this.policy.accessForPath(relativePath);
      if (!access.read) {
        continue;
      }

      const existing = aggregated.get(relativePath);
      if (existing) {
        existing.score += 1;
        continue;
      }

      aggregated.set(relativePath, {
        path: relativePath,
        snippet: buildSnippet(lineText, query, 220),
        score: 1 + scorePath(query, relativePath)
      });
    }

    return Array.from(aggregated.values()).sort(
      (left, right) => right.score - left.score || left.path.localeCompare(right.path)
    );
  }

  private async branchExists(branchName: string): Promise<boolean> {
    const local = await this.gitSucceeds(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`]);
    if (local) {
      return true;
    }

    return this.gitSucceeds(["ls-remote", "--exit-code", "--heads", "origin", branchName]);
  }

  private async createWorktree(baseBranch: string): Promise<string> {
    await this.git(["fetch", "origin", baseBranch], { cwd: this.config.vaultRepoRoot });

    const worktreePath = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-vault-mcp-"));

    try {
      await this.git(["worktree", "add", "--detach", worktreePath, `origin/${baseBranch}`], {
        cwd: this.config.vaultRepoRoot
      });
      return worktreePath;
    } catch (error) {
      await fs.rm(worktreePath, { recursive: true, force: true });
      throw error;
    }
  }

  private async removeWorktree(worktreePath: string): Promise<void> {
    try {
      await this.git(["worktree", "remove", "--force", worktreePath], {
        cwd: this.config.vaultRepoRoot
      });
    } finally {
      await fs.rm(worktreePath, { recursive: true, force: true });
    }
  }

  private async commit(worktreePath: string, message: string): Promise<void> {
    const args = ["commit", "-m", message];

    if (this.config.gitAuthorName) {
      args.unshift(`user.name=${this.config.gitAuthorName}`);
      args.unshift("-c");
    }

    if (this.config.gitAuthorEmail) {
      args.unshift(`user.email=${this.config.gitAuthorEmail}`);
      args.unshift("-c");
    }

    await this.git(args, { cwd: worktreePath });
  }

  private async git(args: string[], options?: GitOptions): Promise<string> {
    try {
      const { stdout } = await execFileAsync("git", args, {
        cwd: options?.cwd ?? this.config.vaultRepoRoot
      });
      return stdout.trim();
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`git ${args.join(" ")} failed: ${error.message}`);
      }

      throw error;
    }
  }

  private async gitSucceeds(args: string[]): Promise<boolean> {
    try {
      await execFileAsync("git", args, {
        cwd: this.config.vaultRepoRoot
      });
      return true;
    } catch {
      return false;
    }
  }
}
