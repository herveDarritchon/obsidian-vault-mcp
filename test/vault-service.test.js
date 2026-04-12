import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RefusalError } from "../src/errors.js";
import { VaultService } from "../src/vault-service.js";
const policyPath = new URL("../config/vault-access-policy.example.yaml", import.meta.url);
async function createVaultFixture() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-vault-fixture-"));
    await fs.mkdir(path.join(root, "02-Work/TOR2e/specs"), { recursive: true });
    await fs.mkdir(path.join(root, "02-Work/Drafts"), { recursive: true });
    await fs.mkdir(path.join(root, "Secrets"), { recursive: true });
    await fs.writeFile(path.join(root, "02-Work/TOR2e/specs/community.md"), "# Community\n\n## Chronicle tab\nInitial content.\n", "utf8");
    await fs.writeFile(path.join(root, "02-Work/Drafts/launch-post.md"), "# Launch post\n\nDraft text.\n", "utf8");
    await fs.writeFile(path.join(root, "Secrets/token.md"), "super-secret\n", "utf8");
    return root;
}
function makeConfig(vaultRepoRoot, overrides = {}) {
    return {
        port: 3000,
        host: "127.0.0.1",
        mcpPath: "/mcp",
        mcpAuthToken: undefined,
        vaultRepoRoot,
        vaultPolicyFile: policyPath.pathname,
        githubOwner: "example",
        githubRepo: "vault",
        githubToken: "test-token",
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
    await assert.rejects(() => service.readNote("Secrets/token.md"), (error) => error instanceof RefusalError && /Read denied by policy/.test(error.message));
});
test("search_notes refuses an explicit blacklisted root", async () => {
    const vaultRepoRoot = await createVaultFixture();
    const service = await VaultService.create(makeConfig(vaultRepoRoot));
    await assert.rejects(() => service.searchNotes("secret", ["Secrets"], 10), (error) => error instanceof RefusalError && /Search denied by policy/.test(error.message));
});
test("propose_change refuses changes spanning multiple scope buckets", async () => {
    const vaultRepoRoot = await createVaultFixture();
    const service = await VaultService.create(makeConfig(vaultRepoRoot));
    await assert.rejects(() => service.proposeChange({
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
    }), (error) => error instanceof RefusalError && /single scope bucket/.test(error.message));
});
test("propose_change enforces branch, commit, and line-delta limits before git", async () => {
    const vaultRepoRoot = await createVaultFixture();
    const service = await VaultService.create(makeConfig(vaultRepoRoot, {
        maxTotalLineDelta: 1
    }));
    await assert.rejects(() => service.proposeChange({
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
    }), (error) => error instanceof RefusalError && /Branch must follow the convention/.test(error.message));
});
//# sourceMappingURL=vault-service.test.js.map