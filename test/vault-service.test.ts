import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { VaultTargetConfig } from "../src/config.js";
import { RefusalError } from "../src/errors.js";
import { VaultService } from "../src/vault-service.js";

const policyPath = fileURLToPath(new URL("../config/vault-access-policy.example.yaml", import.meta.url));

async function createVaultFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-vault-fixture-"));

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

  return root;
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
  assert.match(output.results[0]?.excerpt ?? "", /Initial content/);
  assert.match(output.results[0]?.text ?? "", /Initial content/);
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
  assert.match(output.content, /## Chronicle tab/);
  assert.match(output.text, /## Chronicle tab/);
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
