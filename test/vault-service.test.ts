import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { VaultTargetConfig } from "../src/config.js";
import { RefusalError } from "../src/errors.js";
import { VaultService } from "../src/vault-service.js";

const policyPath = fileURLToPath(new URL("../config/vault-access-policy.example.yaml", import.meta.url));
const execFileAsync = promisify(execFile);

async function createVaultFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-vault-fixture-"));

  await git(["init", "-b", "main"], root);
  await git(["config", "user.name", "Test Bot"], root);
  await git(["config", "user.email", "bot@example.com"], root);

  await fs.mkdir(path.join(root, "02-Work/TOR2e/specs"), { recursive: true });
  await fs.mkdir(path.join(root, "02-Work/Drafts"), { recursive: true });
  await fs.mkdir(path.join(root, "03-Knowledge/Concepts"), { recursive: true });
  await fs.mkdir(path.join(root, "Secrets"), { recursive: true });

  await fs.writeFile(
    path.join(root, "02-Work/TOR2e/specs/community.md"),
    "# Community\n\n## Chronicle tab\nInitial content.\n\n### Timeline\nNested detail.\n\n## Social tab\nOther content.\n",
    "utf8"
  );
  await fs.writeFile(
    path.join(root, "02-Work/Drafts/launch-post.md"),
    "# Launch post\n\nDraft text.\n",
    "utf8"
  );
  await fs.writeFile(
    path.join(root, "03-Knowledge/Concepts/memory.md"),
    "# Memory\n\nReference material.\n",
    "utf8"
  );
  await fs.writeFile(
    path.join(root, "03-Knowledge/Concepts/fellowship-memory.md"),
    [
      "---",
      "title: Fellowship Memory",
      "aliases:",
      "  - Shared Chronicle",
      "tags:",
      "  - memory",
      "  - campaign/lore",
      "actors:",
      "  - Bilbo",
      "status: active",
      "---",
      "",
      "# Memory Archive",
      "",
      "## Session Memory",
      "This note tracks fellowship chronicles and recall rituals.",
      "",
      "## Recall Signals",
      "Use this when the table needs a quick memory refresh.",
      ""
    ].join("\n"),
    "utf8"
  );
  await fs.writeFile(path.join(root, "Secrets/token.md"), "super-secret\n", "utf8");
  await git(["add", "."], root);
  await git(["commit", "-m", "Initial fixture"], root);

  return root;
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function gitShow(gitDirectory: string, revisionPath: string): Promise<string> {
  const { stdout } = await execFileAsync("git", [`--git-dir=${gitDirectory}`, "show", revisionPath]);
  return stdout.trim();
}

async function gitPathExists(gitDirectory: string, revisionPath: string): Promise<boolean> {
  try {
    await execFileAsync("git", [`--git-dir=${gitDirectory}`, "cat-file", "-e", revisionPath]);
    return true;
  } catch {
    return false;
  }
}

function mockGitHubPullRequests(): () => void {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    if (url.includes("/pulls?")) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    if (url.endsWith("/pulls") && (init?.method ?? "GET") === "POST") {
      return new Response(JSON.stringify({ number: 42, html_url: "https://example.test/pr/42" }), {
        status: 201,
        headers: { "content-type": "application/json" }
      });
    }

    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  return () => {
    globalThis.fetch = originalFetch;
  };
}

async function createNestedGitVaultFixture() {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-vault-nested-"));
  const originPath = path.join(workspaceRoot, "origin.git");
  const repoRoot = path.join(workspaceRoot, "repo");
  const vaultRepoRoot = path.join(repoRoot, "vaults/personal");

  await git(["init", "--bare", originPath], workspaceRoot);
  await fs.mkdir(repoRoot, { recursive: true });
  await git(["init", "-b", "main"], repoRoot);
  await git(["config", "user.name", "Test Bot"], repoRoot);
  await git(["config", "user.email", "bot@example.com"], repoRoot);

  await fs.mkdir(path.join(vaultRepoRoot, "02-Work/TOR2e/specs"), { recursive: true });
  await fs.mkdir(path.join(vaultRepoRoot, "02-Work/Drafts"), { recursive: true });
  await fs.mkdir(path.join(vaultRepoRoot, "03-Knowledge/Concepts"), { recursive: true });

  await fs.writeFile(
    path.join(vaultRepoRoot, "02-Work/TOR2e/specs/community.md"),
    "# Community\n\nInitial content.\n",
    "utf8"
  );
  await fs.writeFile(
    path.join(vaultRepoRoot, "02-Work/Drafts/launch-post.md"),
    "# Launch post\n\nDraft text.\n",
    "utf8"
  );
  await fs.writeFile(
    path.join(vaultRepoRoot, "03-Knowledge/Concepts/memory.md"),
    "# Memory\n\nReference material.\n",
    "utf8"
  );
  await fs.writeFile(path.join(repoRoot, "outside-root.md"), "# Outside root\n", "utf8");

  await git(["add", "."], repoRoot);
  await git(["commit", "-m", "Initial commit"], repoRoot);
  await git(["remote", "add", "origin", originPath], repoRoot);
  await git(["push", "-u", "origin", "main"], repoRoot);

  return {
    originPath,
    repoRoot,
    vaultRepoRoot
  };
}

function makeConfig(vaultRepoRoot: string, overrides: Partial<VaultTargetConfig> = {}): VaultTargetConfig {
  return {
    name: "test",
    vaultRepoRoot,
    vaultPolicyFile: policyPath,
    githubOwner: "example",
    githubRepo: "vault",
    githubToken: "test-token",
    githubDefaultBranch: "main",
    githubApiBaseUrl: "https://api.github.com",
    gitAuthorName: "Test Bot",
    gitAuthorEmail: "bot@example.com",
    maxChangeFiles: 5,
    maxTotalLineDelta: 20,
    ...overrides
  };
}

test("read_note refuses blacklisted paths", async () => {
  const vaultRepoRoot = await createVaultFixture();
  const service = await VaultService.create(makeConfig(vaultRepoRoot));

  await assert.rejects(
    () => service.readNote("Secrets/token.md"),
    (error: unknown) => error instanceof RefusalError && /Read denied by policy/.test(error.message)
  );
});

test("read_note returns stable document metadata alongside content", async () => {
  const vaultRepoRoot = await createVaultFixture();
  const service = await VaultService.create(makeConfig(vaultRepoRoot));

  const output = await service.readNote("02-Work/TOR2e/specs/community.md");

  assert.match(output.id, /^obsidian-vault:v1:test:[A-Za-z0-9_-]+$/);
  assert.equal(output.title, "Community");
  assert.equal(output.path, "02-Work/TOR2e/specs/community.md");
  assert.equal(
    output.url,
    "https://github.com/example/vault/blob/main/02-Work/TOR2e/specs/community.md"
  );
  assert.match(output.content, /^# Community/m);
  assert.ok(output.sha256.length > 0);
});

test("read_note prefers the frontmatter title when present", async () => {
  const vaultRepoRoot = await createVaultFixture();
  const service = await VaultService.create(makeConfig(vaultRepoRoot));

  const output = await service.readNote("03-Knowledge/Concepts/fellowship-memory.md");

  assert.equal(output.title, "Fellowship Memory");
  assert.match(output.content, /^---/m);
});

test("read_section returns only the requested section content", async () => {
  const vaultRepoRoot = await createVaultFixture();
  const service = await VaultService.create(makeConfig(vaultRepoRoot));

  const output = await service.readSection("02-Work/TOR2e/specs/community.md", "## Chronicle tab");

  assert.match(output.id, /^obsidian-vault:v1:test:[A-Za-z0-9_-]+$/);
  assert.equal(output.title, "Community");
  assert.equal(output.path, "02-Work/TOR2e/specs/community.md");
  assert.equal(
    output.url,
    "https://github.com/example/vault/blob/main/02-Work/TOR2e/specs/community.md"
  );
  assert.equal(output.section_heading, "## Chronicle tab");
  assert.match(output.content, /^## Chronicle tab/m);
  assert.match(output.content, /Initial content\./);
  assert.match(output.content, /### Timeline/);
  assert.doesNotMatch(output.content, /## Social tab/);
});

test("read_section refuses blacklisted paths", async () => {
  const vaultRepoRoot = await createVaultFixture();
  const service = await VaultService.create(makeConfig(vaultRepoRoot));

  await assert.rejects(
    () => service.readSection("Secrets/token.md", "## Anything"),
    (error: unknown) => error instanceof RefusalError && /Read denied by policy/.test(error.message)
  );
});

test("read_note_excerpt returns a compact summary, excerpt, and headings", async () => {
  const vaultRepoRoot = await createVaultFixture();
  const service = await VaultService.create(makeConfig(vaultRepoRoot));

  const output = await service.readNoteExcerpt("02-Work/TOR2e/specs/community.md", {
    maxExcerptChars: 120,
    maxSummaryChars: 80,
    maxHeadings: 4
  });

  assert.match(output.id, /^obsidian-vault:v1:test:[A-Za-z0-9_-]+$/);
  assert.equal(output.title, "Community");
  assert.equal(output.path, "02-Work/TOR2e/specs/community.md");
  assert.equal(
    output.url,
    "https://github.com/example/vault/blob/main/02-Work/TOR2e/specs/community.md"
  );
  assert.ok(output.note_sha256.length > 0);
  assert.match(output.summary, /Initial content/);
  assert.match(output.excerpt, /Nested detail/);
  assert.deepEqual(output.headings, ["# Community", "## Chronicle tab", "### Timeline", "## Social tab"]);
  assert.ok(output.summary.length <= 80);
  assert.ok(output.excerpt.length <= 120);
});

test("read_note_excerpt ignores frontmatter when building summary and excerpt", async () => {
  const vaultRepoRoot = await createVaultFixture();
  const service = await VaultService.create(makeConfig(vaultRepoRoot));

  const output = await service.readNoteExcerpt("03-Knowledge/Concepts/fellowship-memory.md", {
    maxExcerptChars: 120,
    maxSummaryChars: 80,
    maxHeadings: 4
  });

  assert.equal(output.title, "Fellowship Memory");
  assert.match(output.summary, /fellowship chronicles/i);
  assert.doesNotMatch(output.summary, /Shared Chronicle/);
  assert.deepEqual(output.headings, ["# Memory Archive", "## Session Memory", "## Recall Signals"]);
});

test("read_note_excerpt refuses blacklisted paths", async () => {
  const vaultRepoRoot = await createVaultFixture();
  const service = await VaultService.create(makeConfig(vaultRepoRoot));

  await assert.rejects(
    () =>
      service.readNoteExcerpt("Secrets/token.md", {
        maxExcerptChars: 200,
        maxSummaryChars: 120,
        maxHeadings: 3
      }),
    (error: unknown) => error instanceof RefusalError && /Read denied by policy/.test(error.message)
  );
});

test("search_notes refuses an explicit blacklisted root", async () => {
  const vaultRepoRoot = await createVaultFixture();
  const service = await VaultService.create(makeConfig(vaultRepoRoot));

  await assert.rejects(
    () => service.searchNotes("secret", ["Secrets"], 10),
    (error: unknown) => error instanceof RefusalError && /Search denied by policy/.test(error.message)
  );
});

test("list_notes returns readable markdown notes under a root and skips denied paths", async () => {
  const vaultRepoRoot = await createVaultFixture();
  const service = await VaultService.create(makeConfig(vaultRepoRoot));

  const output = await service.listNotes("02-Work", 20);

  assert.equal(output.root, "02-Work");
  assert.deepEqual(
    output.results.map((item) => ({
      id: item.id,
      title: item.title,
      path: item.path,
      url: item.url
    })),
    [
      {
        id: "obsidian-vault:v1:test:MDItV29yay9EcmFmdHMvbGF1bmNoLXBvc3QubWQ",
        title: "Launch post",
        path: "02-Work/Drafts/launch-post.md",
        url: "https://github.com/example/vault/blob/main/02-Work/Drafts/launch-post.md"
      },
      {
        id: "obsidian-vault:v1:test:MDItV29yay9UT1IyZS9zcGVjcy9jb21tdW5pdHkubWQ",
        title: "Community",
        path: "02-Work/TOR2e/specs/community.md",
        url: "https://github.com/example/vault/blob/main/02-Work/TOR2e/specs/community.md"
      }
    ]
  );
});

test("list_notes refuses an explicit blacklisted root", async () => {
  const vaultRepoRoot = await createVaultFixture();
  const service = await VaultService.create(makeConfig(vaultRepoRoot));

  await assert.rejects(
    () => service.listNotes("Secrets", 10),
    (error: unknown) => error instanceof RefusalError && /Search denied by policy/.test(error.message)
  );
});

test("searchOpenAI returns OpenAI-compatible document results", async () => {
  const vaultRepoRoot = await createVaultFixture();
  const service = await VaultService.create(makeConfig(vaultRepoRoot));

  const output = await service.searchOpenAI("Initial content", 5);

  assert.equal(output.results.length, 1);
  assert.match(
    output.results[0]?.id ?? "",
    /^obsidian-vault:v1:test:[A-Za-z0-9_-]+$/
  );
  assert.equal(output.results[0]?.title, "Community");
  assert.equal(output.results[0]?.path, "02-Work/TOR2e/specs/community.md");
  assert.match(output.results[0]?.text ?? "", /Initial content/);
  assert.equal("excerpt" in (output.results[0] ?? {}), false);
  assert.equal(
    output.results[0]?.url,
    "https://github.com/example/vault/blob/main/02-Work/TOR2e/specs/community.md"
  );
});

test("searchNotes returns id, title, path, and url in addition to snippet and score", async () => {
  const vaultRepoRoot = await createVaultFixture();
  const service = await VaultService.create(makeConfig(vaultRepoRoot));

  const output = await service.searchNotes("Initial content", undefined, 5);

  assert.equal(output.results.length, 1);
  assert.match(output.results[0]?.id ?? "", /^obsidian-vault:v1:test:[A-Za-z0-9_-]+$/);
  assert.equal(output.results[0]?.title, "Community");
  assert.equal(output.results[0]?.path, "02-Work/TOR2e/specs/community.md");
  assert.equal(
    output.results[0]?.url,
    "https://github.com/example/vault/blob/main/02-Work/TOR2e/specs/community.md"
  );
  assert.match(output.results[0]?.snippet ?? "", /Initial content/);
  assert.equal(typeof output.results[0]?.score, "number");
});

test("searchNotes ranks aliases, headings, tags, and frontmatter fields", async () => {
  const vaultRepoRoot = await createVaultFixture();
  const service = await VaultService.create(makeConfig(vaultRepoRoot));

  const aliasResult = await service.searchNotes("Shared Chronicle", undefined, 5);
  assert.equal(aliasResult.results[0]?.path, "03-Knowledge/Concepts/fellowship-memory.md");
  assert.equal(aliasResult.results[0]?.title, "Fellowship Memory");
  assert.equal(aliasResult.results[0]?.snippet, "Alias: Shared Chronicle");

  const headingResult = await service.searchNotes("Session Memory", undefined, 5);
  assert.equal(headingResult.results[0]?.path, "03-Knowledge/Concepts/fellowship-memory.md");
  assert.equal(headingResult.results[0]?.snippet, "Heading: ## Session Memory");

  const tagResult = await service.searchNotes("campaign/lore", undefined, 5);
  assert.equal(tagResult.results[0]?.path, "03-Knowledge/Concepts/fellowship-memory.md");
  assert.equal(tagResult.results[0]?.snippet, "Tag: #campaign/lore");

  const frontmatterResult = await service.searchNotes("Bilbo", undefined, 5);
  assert.equal(frontmatterResult.results[0]?.path, "03-Knowledge/Concepts/fellowship-memory.md");
  assert.equal(frontmatterResult.results[0]?.snippet, "Frontmatter: actors: Bilbo");
});

test("searchNotes supports lightweight hybrid matching on inflected terms", async () => {
  const vaultRepoRoot = await createVaultFixture();
  const service = await VaultService.create(makeConfig(vaultRepoRoot));

  const output = await service.searchNotes("shared chronicles", undefined, 5);

  assert.equal(output.results[0]?.path, "03-Knowledge/Concepts/fellowship-memory.md");
  assert.equal(output.results[0]?.title, "Fellowship Memory");
});

test("fetchOpenAI returns full note contents and metadata", async () => {
  const vaultRepoRoot = await createVaultFixture();
  const service = await VaultService.create(makeConfig(vaultRepoRoot));

  const output = await service.fetchOpenAI("02-Work/TOR2e/specs/community.md");

  assert.match(output.id, /^obsidian-vault:v1:test:[A-Za-z0-9_-]+$/);
  assert.equal(output.title, "Community");
  assert.equal(output.path, "02-Work/TOR2e/specs/community.md");
  assert.match(output.text, /## Chronicle tab/);
  assert.equal("content" in output, false);
  assert.equal(
    output.url,
    "https://github.com/example/vault/blob/main/02-Work/TOR2e/specs/community.md"
  );
  assert.equal(output.metadata.target, "test");
  assert.equal(output.metadata.path, "02-Work/TOR2e/specs/community.md");
  assert.equal(typeof output.metadata.sha256, "string");
  assert.ok((output.metadata.sha256 as string).length > 0);
});

test("fetchOpenAI returns structured retrieval metadata for the note", async () => {
  const vaultRepoRoot = await createVaultFixture();
  const service = await VaultService.create(makeConfig(vaultRepoRoot));

  const output = await service.fetchOpenAI("03-Knowledge/Concepts/fellowship-memory.md");

  assert.equal(output.title, "Fellowship Memory");
  assert.deepEqual(output.metadata.aliases, ["Shared Chronicle"]);
  assert.deepEqual(output.metadata.tags, ["memory", "campaign/lore"]);
  assert.deepEqual(output.metadata.headings, ["# Memory Archive", "## Session Memory", "## Recall Signals"]);
  assert.deepEqual(output.metadata.frontmatter, {
    title: "Fellowship Memory",
    aliases: ["Shared Chronicle"],
    tags: ["memory", "campaign/lore"],
    actors: ["Bilbo"],
    status: "active"
  });
});

test("fetchOpenAI accepts a GitHub blob URL returned by search", async () => {
  const vaultRepoRoot = await createVaultFixture();
  const service = await VaultService.create(makeConfig(vaultRepoRoot));

  const output = await service.fetchOpenAI(
    "https://github.com/example/vault/blob/main/02-Work/TOR2e/specs/community.md"
  );

  assert.match(output.id, /^obsidian-vault:v1:test:[A-Za-z0-9_-]+$/);
  assert.equal(output.title, "Community");
  assert.equal(output.path, "02-Work/TOR2e/specs/community.md");
});

test("fetchOpenAI accepts a stable document id returned by search", async () => {
  const vaultRepoRoot = await createVaultFixture();
  const service = await VaultService.create(makeConfig(vaultRepoRoot));

  const searchResult = await service.searchOpenAI("Initial content", 5);
  const stableId = searchResult.results[0]?.id;

  assert.ok(stableId);

  const output = await service.fetchOpenAI(stableId!);

  assert.equal(output.path, "02-Work/TOR2e/specs/community.md");
  assert.equal(output.id, stableId);
});

test("resolveReadReference accepts either a stable id or a raw path", async () => {
  const vaultRepoRoot = await createVaultFixture();
  const service = await VaultService.create(makeConfig(vaultRepoRoot));

  const note = await service.readNote("02-Work/TOR2e/specs/community.md");

  assert.equal(
    service.resolveReadReference({ id: note.id }),
    "02-Work/TOR2e/specs/community.md"
  );
  assert.equal(
    service.resolveReadReference({ path: "02-Work/TOR2e/specs/community.md" }),
    "02-Work/TOR2e/specs/community.md"
  );
});

test("move_note refuses moving a note into the same directory", async () => {
  const vaultRepoRoot = await createVaultFixture();
  const service = await VaultService.create(makeConfig(vaultRepoRoot));

  await assert.rejects(
    () =>
      service.moveNote({
        path: "02-Work/TOR2e/specs/community.md",
        destination_dir: "02-Work/TOR2e/specs"
      }),
    (error: unknown) => error instanceof RefusalError && /identical/.test(error.message)
  );
});

test("move_note refuses a destination outside write-enabled policy", async () => {
  const vaultRepoRoot = await createVaultFixture();
  const service = await VaultService.create(makeConfig(vaultRepoRoot));

  await assert.rejects(
    () =>
      service.moveNote({
        path: "02-Work/TOR2e/specs/community.md",
        destination_dir: "03-Knowledge/Concepts"
      }),
    (error: unknown) =>
      error instanceof RefusalError && /destination path/.test(error.message)
  );
});

test("move_note refuses when the destination note already exists", async () => {
  const vaultRepoRoot = await createVaultFixture();
  await fs.writeFile(
    path.join(vaultRepoRoot, "02-Work/Drafts/community.md"),
    "# Existing community\n",
    "utf8"
  );
  const service = await VaultService.create(makeConfig(vaultRepoRoot));

  await assert.rejects(
    () =>
      service.moveNote({
        path: "02-Work/TOR2e/specs/community.md",
        destination_dir: "02-Work/Drafts"
      }),
    (error: unknown) => error instanceof RefusalError && /already exists/.test(error.message)
  );
});

test("rename_note refuses an identical destination path", async () => {
  const vaultRepoRoot = await createVaultFixture();
  const service = await VaultService.create(makeConfig(vaultRepoRoot));

  await assert.rejects(
    () =>
      service.renameNote({
        path: "02-Work/TOR2e/specs/community.md",
        destination_path: "02-Work/TOR2e/specs/community.md"
      }),
    (error: unknown) => error instanceof RefusalError && /identical/.test(error.message)
  );
});

test("rename_note refuses a destination outside write-enabled policy", async () => {
  const vaultRepoRoot = await createVaultFixture();
  const service = await VaultService.create(makeConfig(vaultRepoRoot));

  await assert.rejects(
    () =>
      service.renameNote({
        path: "02-Work/TOR2e/specs/community.md",
        destination_path: "03-Knowledge/Concepts/community-renamed.md"
      }),
    (error: unknown) =>
      error instanceof RefusalError && /destination path/.test(error.message)
  );
});

test("rename_note refuses when the destination path already exists", async () => {
  const vaultRepoRoot = await createVaultFixture();
  await fs.writeFile(
    path.join(vaultRepoRoot, "02-Work/Drafts/community-renamed.md"),
    "# Existing renamed community\n",
    "utf8"
  );
  const service = await VaultService.create(makeConfig(vaultRepoRoot));

  await assert.rejects(
    () =>
      service.renameNote({
        path: "02-Work/TOR2e/specs/community.md",
        destination_path: "02-Work/Drafts/community-renamed.md"
      }),
    (error: unknown) => error instanceof RefusalError && /already exists/.test(error.message)
  );
});

test("create_folder refuses a path outside write-enabled policy", async () => {
  const vaultRepoRoot = await createVaultFixture();
  const service = await VaultService.create(makeConfig(vaultRepoRoot));

  await assert.rejects(
    () =>
      service.createFolder({
        path: "03-Knowledge/Concepts/New Folder"
      }),
    (error: unknown) => error instanceof RefusalError && /Create folder denied by policy/.test(error.message)
  );
});

test("create_folder refuses when the folder already exists", async () => {
  const vaultRepoRoot = await createVaultFixture();
  await fs.mkdir(path.join(vaultRepoRoot, "02-Work/Drafts/Existing Folder"), { recursive: true });
  const service = await VaultService.create(makeConfig(vaultRepoRoot));

  await assert.rejects(
    () =>
      service.createFolder({
        path: "02-Work/Drafts/Existing Folder"
      }),
    (error: unknown) => error instanceof RefusalError && /Folder already exists/.test(error.message)
  );
});

test("propose_change refuses changes spanning multiple scope buckets", async () => {
  const vaultRepoRoot = await createVaultFixture();
  const service = await VaultService.create(makeConfig(vaultRepoRoot));

  await assert.rejects(
    () =>
      service.proposeChange({
        title: "Mixed scope",
        base_branch: "main",
        branch_name: "ai/tor2e/mixed-scope",
        commit_message: "ai(tor2e): attempt mixed scope update",
        pr_body: "Testing",
        changes: [
          {
            path: "02-Work/TOR2e/specs/community.md",
            mode: "append",
            content: "Extra line.\n"
          },
          {
            path: "02-Work/Drafts/launch-post.md",
            mode: "append",
            content: "Another extra line.\n"
          }
        ]
      }),
    (error: unknown) =>
      error instanceof RefusalError && /single scope bucket/.test(error.message)
  );
});

test("propose_change enforces branch, commit, and line-delta limits before git", async () => {
  const vaultRepoRoot = await createVaultFixture();
  const service = await VaultService.create(
    makeConfig(vaultRepoRoot, {
      maxTotalLineDelta: 1
    })
  );

  await assert.rejects(
    () =>
      service.proposeChange({
        title: "Too large",
        base_branch: "main",
        branch_name: "feature/tor2e/too-large",
        commit_message: "feat: invalid convention",
        pr_body: "Testing",
        changes: [
          {
            path: "02-Work/TOR2e/specs/community.md",
            mode: "append",
            content: "One\nTwo\nThree\n"
          }
        ]
      }),
    (error: unknown) =>
      error instanceof RefusalError && /Branch must follow the convention/.test(error.message)
  );
});

test("propose-only paths allow draft generation but refuse propose_change", async () => {
  const vaultRepoRoot = await createVaultFixture();
  const service = await VaultService.create(makeConfig(vaultRepoRoot));

  const draft = await service.updateNoteDraft({
    path: "03-Knowledge/Concepts/memory.md",
    mode: "append",
    content: "Additional reference note.\n"
  });

  assert.equal(draft.policy.read, true);
  assert.equal(draft.policy.write, false);
  assert.equal(draft.policy.proposePatch, true);
  assert.equal(draft.warnings.length, 1);
  assert.match(draft.warnings[0] ?? "", /propose-only/i);
  assert.match(draft.draft_content, /Additional reference note/);

  await assert.rejects(
    () =>
      service.proposeChange({
        title: "Attempt propose-only write",
        base_branch: "main",
        branch_name: "ai/knowledge/propose-only-write",
        commit_message: "ai(knowledge): attempt propose-only write",
        pr_body: "Testing",
        changes: [
          {
            path: "03-Knowledge/Concepts/memory.md",
            mode: "append",
            content: "Additional reference note.\n"
          }
        ]
      }),
    (error: unknown) => error instanceof RefusalError && /Write denied by policy/.test(error.message)
  );
});

test("propose_change keeps content writes inside a nested vault root", async () => {
  const restoreFetch = mockGitHubPullRequests();

  try {
    const fixture = await createNestedGitVaultFixture();
    const service = await VaultService.create(
      makeConfig(fixture.vaultRepoRoot, {
        githubApiBaseUrl: "https://example.test/api/v3"
      })
    );

    const output = await service.proposeChange({
      title: "Update nested draft",
      base_branch: "main",
      branch_name: "ai/vault/update-nested-draft",
      commit_message: "ai(vault): update nested draft",
      pr_body: "Testing nested vault confinement.",
      changes: [
        {
          path: "02-Work/Drafts/launch-post.md",
          mode: "append",
          content: "Added from nested vault.\n"
        }
      ]
    });

    assert.deepEqual(output.changed_files, ["02-Work/Drafts/launch-post.md"]);
    assert.match(
      await gitShow(
        fixture.originPath,
        `${output.branch}:vaults/personal/02-Work/Drafts/launch-post.md`
      ),
      /Added from nested vault\./
    );
    assert.equal(
      await gitPathExists(fixture.originPath, `${output.branch}:02-Work/Drafts/launch-post.md`),
      false
    );
  } finally {
    restoreFetch();
  }
});

test("create_folder keeps placeholder creation inside a nested vault root", async () => {
  const restoreFetch = mockGitHubPullRequests();

  try {
    const fixture = await createNestedGitVaultFixture();
    const service = await VaultService.create(
      makeConfig(fixture.vaultRepoRoot, {
        githubApiBaseUrl: "https://example.test/api/v3"
      })
    );

    const output = await service.createFolder({
      path: "02-Work/Drafts/New Folder",
      title: "Create nested folder",
      base_branch: "main",
      branch_name: "ai/vault/create-nested-folder",
      commit_message: "ai(vault): create folder 02-Work/Drafts/New Folder",
      pr_body: "Testing nested vault confinement."
    });

    assert.equal(output.placeholder_path, "02-Work/Drafts/New Folder/.gitkeep");
    assert.equal(
      await gitPathExists(
        fixture.originPath,
        `${output.branch}:vaults/personal/02-Work/Drafts/New Folder/.gitkeep`
      ),
      true
    );
    assert.equal(
      await gitPathExists(
        fixture.originPath,
        `${output.branch}:02-Work/Drafts/New Folder/.gitkeep`
      ),
      false
    );
  } finally {
    restoreFetch();
  }
});

test("rename_note keeps relocations inside a nested vault root", async () => {
  const restoreFetch = mockGitHubPullRequests();

  try {
    const fixture = await createNestedGitVaultFixture();
    const service = await VaultService.create(
      makeConfig(fixture.vaultRepoRoot, {
        githubApiBaseUrl: "https://example.test/api/v3"
      })
    );

    const output = await service.renameNote({
      path: "02-Work/TOR2e/specs/community.md",
      destination_path: "02-Work/Drafts/community-renamed.md",
      title: "Rename nested note",
      base_branch: "main",
      branch_name: "ai/vault/rename-nested-note",
      commit_message: "ai(vault): rename nested note",
      pr_body: "Testing nested vault confinement."
    });

    assert.equal(output.path, "02-Work/Drafts/community-renamed.md");
    assert.equal(
      await gitPathExists(
        fixture.originPath,
        `${output.branch}:vaults/personal/02-Work/Drafts/community-renamed.md`
      ),
      true
    );
    assert.equal(
      await gitPathExists(
        fixture.originPath,
        `${output.branch}:vaults/personal/02-Work/TOR2e/specs/community.md`
      ),
      false
    );
    assert.equal(
      await gitPathExists(
        fixture.originPath,
        `${output.branch}:02-Work/Drafts/community-renamed.md`
      ),
      false
    );
  } finally {
    restoreFetch();
  }
});
