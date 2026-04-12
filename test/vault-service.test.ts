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

test("read_section returns only the requested section content", async () => {
  const vaultRepoRoot = await createVaultFixture();
  const service = await VaultService.create(makeConfig(vaultRepoRoot));

  const output = await service.readSection("02-Work/TOR2e/specs/community.md", "## Chronicle tab");

  assert.equal(output.path, "02-Work/TOR2e/specs/community.md");
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

  assert.equal(output.path, "02-Work/TOR2e/specs/community.md");
  assert.ok(output.note_sha256.length > 0);
  assert.match(output.summary, /Initial content/);
  assert.match(output.excerpt, /Nested detail/);
  assert.deepEqual(output.headings, ["# Community", "## Chronicle tab", "### Timeline", "## Social tab"]);
  assert.ok(output.summary.length <= 80);
  assert.ok(output.excerpt.length <= 120);
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
  assert.deepEqual(output.results.map((item) => item.path), [
    "02-Work/Drafts/launch-post.md",
    "02-Work/TOR2e/specs/community.md"
  ]);
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
  assert.ok((output.metadata.sha256 ?? "").length > 0);
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
