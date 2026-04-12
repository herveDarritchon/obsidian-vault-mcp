import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config.js";

async function writeTargetsFixture(contents: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-targets-fixture-"));
  const filePath = path.join(directory, "vault-targets.yaml");
  await fs.writeFile(filePath, contents, "utf8");
  return filePath;
}

async function withEnv<T>(overrides: Record<string, string | undefined>, action: () => Promise<T> | T): Promise<T> {
  const snapshot = new Map<string, string | undefined>();

  for (const key of Object.keys(overrides)) {
    snapshot.set(key, process.env[key]);
    const value = overrides[key];

    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await action();
  } finally {
    for (const [key, value] of snapshot.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("loadConfig supports legacy single-target environment", async () => {
  const config = await withEnv(
    {
      VAULT_TARGETS_FILE: undefined,
      VAULT_TARGET: undefined,
      VAULT_REPO_ROOT: "/tmp/legacy-vault",
      VAULT_POLICY_FILE: "./config/vault-access-policy.example.yaml",
      GITHUB_OWNER: "example-owner",
      GITHUB_REPO: "legacy-vault",
      GITHUB_TOKEN: "legacy-token"
    },
    () => loadConfig()
  );

  assert.equal(config.defaultTarget, "default");
  assert.deepEqual(Object.keys(config.targets), ["default"]);
  assert.equal(config.targets.default?.vaultRepoRoot, "/tmp/legacy-vault");
  assert.equal(config.targets.default?.githubOwner, "example-owner");
  assert.equal(config.targets.default?.githubRepo, "legacy-vault");
  assert.equal(config.targets.default?.githubToken, "legacy-token");
});

test("loadConfig supports a multi-target catalog with a selected default target", async () => {
  const targetsFilePath = await writeTargetsFixture(`
version: 1
defaultTarget: e2e
targets:
  e2e:
    repoRoot: ./fixtures/e2e-vault
    policyFile: ./vault-access-policy.e2e.yaml
    github:
      owner: herveDarritchon
      repo: obsidian-mcp-e2e-vault
  real:
    repoRoot: /vaults/real
    policyFile: /policies/real.yaml
    github:
      owner: herveDarritchon
      repo: obsidian-real-vault
    githubTokenEnv: REAL_VAULT_TOKEN
    maxChangeFiles: 3
`);

  const config = await withEnv(
    {
      VAULT_REPO_ROOT: undefined,
      VAULT_POLICY_FILE: undefined,
      GITHUB_OWNER: undefined,
      GITHUB_REPO: undefined,
      VAULT_TARGETS_FILE: targetsFilePath,
      VAULT_TARGET: "real",
      GITHUB_TOKEN: "shared-token",
      REAL_VAULT_TOKEN: "real-token"
    },
    () => loadConfig()
  );

  assert.equal(config.defaultTarget, "real");
  assert.deepEqual(Object.keys(config.targets).sort(), ["e2e", "real"]);
  assert.equal(
    config.targets.real?.vaultRepoRoot,
    "/vaults/real"
  );
  assert.equal(
    config.targets.e2e?.vaultRepoRoot,
    path.join(path.dirname(targetsFilePath), "fixtures/e2e-vault")
  );
  assert.equal(config.targets.real?.githubToken, "real-token");
  assert.equal(config.targets.e2e?.githubToken, "shared-token");
  assert.equal(config.targets.real?.maxChangeFiles, 3);
  assert.equal(config.targets.e2e?.githubRepo, "obsidian-mcp-e2e-vault");
});
