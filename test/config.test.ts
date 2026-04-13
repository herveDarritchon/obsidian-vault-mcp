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

async function writeVaultManifestFixture(
  contents: string,
  options?: { envFileName?: string; envContents?: string }
): Promise<{ manifestPath: string; vaultRoot: string; envFilePath?: string }> {
  const vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-vault-manifest-fixture-"));
  const manifestDirectory = path.join(vaultRoot, ".config", "mcp");
  await fs.mkdir(path.join(vaultRoot, ".git"), { recursive: true });
  await fs.mkdir(manifestDirectory, { recursive: true });
  const manifestPath = path.join(manifestDirectory, "vault-target.yaml");
  await fs.writeFile(manifestPath, contents, "utf8");

  if (options?.envContents) {
    const envFilePath = path.join(manifestDirectory, options.envFileName ?? ".env.local");
    await fs.writeFile(envFilePath, options.envContents, "utf8");
    return { manifestPath, vaultRoot, envFilePath };
  }

  return { manifestPath, vaultRoot };
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
      VAULT_TARGET_MANIFEST_FILE: undefined,
      VAULT_REPO_ROOT: "/tmp/legacy-vault",
      VAULT_POLICY_FILE: "./config/vault-access-policy.example.yaml",
      GITHUB_OWNER: "example-owner",
      GITHUB_REPO: "legacy-vault",
      GITHUB_TOKEN: "legacy-token",
      GITHUB_DEFAULT_BRANCH: "stable"
    },
    () => loadConfig()
  );

  assert.equal(config.defaultTarget, "default");
  assert.deepEqual(Object.keys(config.targets), ["default"]);
  assert.equal(config.targets.default?.vaultRepoRoot, "/tmp/legacy-vault");
  assert.equal(config.targets.default?.githubOwner, "example-owner");
  assert.equal(config.targets.default?.githubRepo, "legacy-vault");
  assert.equal(config.targets.default?.githubToken, "legacy-token");
  assert.equal(config.targets.default?.githubDefaultBranch, "stable");
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
      defaultBranch: trunk
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
  assert.equal(config.targets.real?.githubDefaultBranch, "trunk");
  assert.equal(config.targets.e2e?.githubDefaultBranch, "main");
  assert.equal(config.targets.real?.maxChangeFiles, 3);
  assert.equal(config.targets.e2e?.githubRepo, "obsidian-mcp-e2e-vault");
});

test("loadConfig supports a single target manifest stored inside the vault", async () => {
  const { manifestPath, vaultRoot } = await writeVaultManifestFixture(`
version: 1
policyFile: .config/policy/vault-access-policy.yaml
envFile: .config/mcp/.env.e2e
github:
  owner: herveDarritchon
  repo: tor2e-obsidian-private-vault
  defaultBranch: develop
githubTokenEnv: TOR2E_GITHUB_TOKEN
`, {
    envFileName: ".env.e2e",
    envContents: `
TOR2E_GITHUB_TOKEN=vault-token
GIT_AUTHOR_NAME=Vault Bot
MAX_CHANGE_FILES=4
`
  });

  const config = await withEnv(
    {
      VAULT_TARGETS_FILE: undefined,
      VAULT_REPO_ROOT: undefined,
      VAULT_POLICY_FILE: undefined,
      GITHUB_OWNER: undefined,
      GITHUB_REPO: undefined,
      VAULT_TARGET_MANIFEST_FILE: manifestPath,
      VAULT_TARGET: "tor2e",
      GITHUB_TOKEN: "shared-token",
      TOR2E_GITHUB_TOKEN: undefined
    },
    () => loadConfig()
  );

  assert.equal(config.defaultTarget, "tor2e");
  assert.deepEqual(Object.keys(config.targets), ["tor2e"]);
  assert.equal(config.targets.tor2e?.vaultRepoRoot, vaultRoot);
  assert.equal(
    config.targets.tor2e?.vaultPolicyFile,
    path.join(vaultRoot, ".config/policy/vault-access-policy.yaml")
  );
  assert.equal(config.targets.tor2e?.githubRepo, "tor2e-obsidian-private-vault");
  assert.equal(config.targets.tor2e?.githubToken, "vault-token");
  assert.equal(config.targets.tor2e?.gitAuthorName, "Vault Bot");
  assert.equal(config.targets.tor2e?.githubDefaultBranch, "develop");
  assert.equal(config.targets.tor2e?.maxChangeFiles, 4);
});

test("loadConfig supports a multi-target catalog whose entries point to per-vault manifests", async () => {
  const tor2e = await writeVaultManifestFixture(`
version: 1
policyFile: .config/policy/vault-access-policy.yaml
envFile: .config/mcp/.env.local
github:
  owner: herveDarritchon
  repo: tor2e-obsidian-private-vault
githubTokenEnv: TOR2E_GITHUB_TOKEN
`, {
    envContents: `
TOR2E_GITHUB_TOKEN=tor2e-token
MAX_CHANGE_FILES=4
`
  });
  const atlas = await writeVaultManifestFixture(`
version: 1
policyFile: .config/policy/vault-access-policy.yaml
envFile: .config/mcp/.env.local
github:
  owner: herveDarritchon
  repo: atlas-vault
  defaultBranch: trunk
`, {
    envContents: `
GITHUB_TOKEN=atlas-token
MAX_CHANGE_FILES=2
`
  });
  const targetsFilePath = await writeTargetsFixture(`
version: 1
defaultTarget: tor2e
targets:
  tor2e:
    manifestFile: ${JSON.stringify(tor2e.manifestPath)}
  atlas:
    manifestFile: ${JSON.stringify(atlas.manifestPath)}
`);

  const config = await withEnv(
    {
      VAULT_REPO_ROOT: undefined,
      VAULT_POLICY_FILE: undefined,
      GITHUB_OWNER: undefined,
      GITHUB_REPO: undefined,
      VAULT_TARGET_MANIFEST_FILE: undefined,
      VAULT_TARGETS_FILE: targetsFilePath,
      VAULT_TARGET: undefined,
      GITHUB_TOKEN: "shared-token",
      TOR2E_GITHUB_TOKEN: undefined
    },
    () => loadConfig()
  );

  assert.equal(config.defaultTarget, "tor2e");
  assert.deepEqual(Object.keys(config.targets).sort(), ["atlas", "tor2e"]);
  assert.equal(config.targets.tor2e?.vaultRepoRoot, tor2e.vaultRoot);
  assert.equal(config.targets.atlas?.vaultRepoRoot, atlas.vaultRoot);
  assert.equal(config.targets.tor2e?.githubToken, "tor2e-token");
  assert.equal(config.targets.atlas?.githubToken, "atlas-token");
  assert.equal(config.targets.atlas?.githubDefaultBranch, "trunk");
  assert.equal(config.targets.tor2e?.maxChangeFiles, 4);
  assert.equal(config.targets.atlas?.maxChangeFiles, 2);
});

test("loadConfig defaults toolProfile to full", async () => {
  const config = await withEnv(
    {
      VAULT_TARGETS_FILE: undefined,
      VAULT_TARGET: undefined,
      VAULT_TARGET_MANIFEST_FILE: undefined,
      TOOL_PROFILE: undefined,
      VAULT_REPO_ROOT: "/tmp/legacy-vault",
      VAULT_POLICY_FILE: "./config/vault-access-policy.example.yaml",
      GITHUB_OWNER: "example-owner",
      GITHUB_REPO: "legacy-vault"
    },
    () => loadConfig()
  );

  assert.equal(config.toolProfile, "full");
});

test("loadConfig accepts toolProfile=minimal", async () => {
  const config = await withEnv(
    {
      VAULT_TARGETS_FILE: undefined,
      VAULT_TARGET: undefined,
      VAULT_TARGET_MANIFEST_FILE: undefined,
      TOOL_PROFILE: "minimal",
      VAULT_REPO_ROOT: "/tmp/legacy-vault",
      VAULT_POLICY_FILE: "./config/vault-access-policy.example.yaml",
      GITHUB_OWNER: "example-owner",
      GITHUB_REPO: "legacy-vault"
    },
    () => loadConfig()
  );

  assert.equal(config.toolProfile, "minimal");
});
