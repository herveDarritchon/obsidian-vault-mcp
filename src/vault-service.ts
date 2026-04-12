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
import { applyChange, buildDiffSummary } from "./markdown.js";
import { VaultPolicyEngine } from "./policy.js";
import type {
  ListNotesResult,
  NoteChange,
  ProposeChangeResult,
  ReadNoteResult,
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

function scoreContent(query: string, content: string): number {
  const lowerQuery = query.toLowerCase();
  const lowerContent = content.toLowerCase();
  let position = 0;
  let matches = 0;

  while (position >= 0) {
    position = lowerContent.indexOf(lowerQuery, position);

    if (position >= 0) {
      matches += 1;
      position += lowerQuery.length;
    }
  }

  return matches;
}

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

  async listNotes(root: string | undefined, limit: number): Promise<ListNotesResult> {
    const [resolvedRoot] = await this.resolveSearchRoots(root ? [root] : ["."]);
    const results: Array<{ path: string }> = [];

    if (resolvedRoot?.stats.isFile()) {
      const relativePath = toVaultRelativePath(this.config.vaultRepoRoot, resolvedRoot.absolutePath);
      const access = this.policy.accessForPath(relativePath);

      if (access.read && isMarkdownFile(relativePath)) {
        results.push({ path: relativePath });
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

    if (ripgrepResults) {
      return { results: ripgrepResults.slice(0, limit) };
    }

    const results: SearchResult[] = [];

    for (const root of requestedRoots) {
      if (root.stats.isFile()) {
        const relativePath = toVaultRelativePath(this.config.vaultRepoRoot, root.absolutePath);
        await this.searchFile(relativePath, trimmedQuery, results);
      } else {
        await this.searchDirectory(root.absolutePath, trimmedQuery, results, limit);
      }

      if (results.length >= limit) {
        break;
      }
    }

    results.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
    return { results: results.slice(0, limit) };
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

    return {
      path: safePath,
      sha256: sha256(content),
      content,
      policy: access
    };
  }

  private async searchDirectory(
    absoluteRoot: string,
    query: string,
    results: SearchResult[],
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
        await this.searchDirectory(absolutePath, query, results, limit);
        continue;
      }

      if (!entry.isFile() || !isMarkdownFile(entry.name)) {
        continue;
      }

      const relativePath = toVaultRelativePath(this.config.vaultRepoRoot, absolutePath);
      await this.searchFile(relativePath, query, results);
    }
  }

  private async listDirectory(
    absoluteRoot: string,
    results: Array<{ path: string }>,
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

      results.push({ path: relativePath });
    }
  }

  private async searchFile(relativePath: string, query: string, results: SearchResult[]): Promise<void> {
    const access = this.policy.accessForPath(relativePath);

    if (!access.read) {
      return;
    }

    const absolutePath = resolveVaultPath(this.config.vaultRepoRoot, relativePath);
    const content = await fs.readFile(absolutePath, "utf8");
    const score = scoreContent(query, content);

    if (score === 0) {
      return;
    }

    results.push({
      path: relativePath,
      snippet: buildSnippet(content, query),
      score: score + scorePath(query, relativePath)
    });
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
  ): Promise<SearchResult[] | null> {
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

  private parseRipgrepResults(stdout: string, query: string): SearchResult[] {
    const aggregated = new Map<string, SearchResult>();

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
