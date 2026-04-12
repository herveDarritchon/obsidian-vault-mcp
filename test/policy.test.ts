import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { VaultPolicyEngine } from "../src/policy.js";

const policyPath = fileURLToPath(new URL("../config/vault-access-policy.example.yaml", import.meta.url));

async function writePolicyFixture(contents: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-policy-fixture-"));
  const filePath = path.join(directory, "policy.yaml");
  await fs.writeFile(filePath, contents, "utf8");
  return filePath;
}

test("policy resolves write, propose-only, and denied paths", async () => {
  const policy = await VaultPolicyEngine.load(policyPath);

  const writable = policy.accessForPath("02-Work/TOR2e/specs/community.md");
  const proposeOnly = policy.accessForPath("03-Knowledge/Concepts/memory.md");
  const denied = policy.accessForPath("Secrets/token.md");

  assert.equal(writable.write, true);
  assert.equal(writable.openPrOrMr, "require");
  assert.equal(proposeOnly.read, true);
  assert.equal(proposeOnly.write, false);
  assert.equal(denied.read, false);
  assert.equal(denied.proposePatch, false);
});

test("policy can decide whether a search root is readable", async () => {
  const policy = await VaultPolicyEngine.load(policyPath);

  assert.equal(policy.allowsReadBelow("02-Work/TOR2e/specs"), true);
  assert.equal(policy.allowsReadBelow("03-Knowledge/Technical"), true);
  assert.equal(policy.allowsReadBelow("Secrets"), false);
  assert.equal(policy.allowsReadBelow("99-System/policy"), false);
});

test("policy falls back to defaults when no rule matches", async () => {
  const policy = await VaultPolicyEngine.load(policyPath);
  const unmatched = policy.accessForPath("05-Inbox/random-note.md");

  assert.equal(unmatched.read, false);
  assert.equal(unmatched.write, false);
  assert.equal(unmatched.proposePatch, false);
  assert.equal(unmatched.openPrOrMr, "deny");
  assert.deepEqual(unmatched.matchedRules, []);
});

test("policy deny rules take precedence over overlapping permissive rules", async () => {
  const customPolicyPath = await writePolicyFixture(`
version: 1
defaults:
  read: false
  write: false
  proposePatch: false
  openPrOrMr: deny
rules:
  - name: allow-workspace
    effect: write_via_pr
    paths:
      - Workspace/**
  - name: deny-private-slice
    effect: deny
    paths:
      - Workspace/Private/**
`);
  const policy = await VaultPolicyEngine.load(customPolicyPath);
  const denied = policy.accessForPath("Workspace/Private/secret.md");

  assert.equal(denied.read, false);
  assert.equal(denied.write, false);
  assert.equal(denied.proposePatch, false);
  assert.equal(denied.openPrOrMr, "deny");
  assert.deepEqual(denied.matchedRules, ["allow-workspace", "deny-private-slice"]);
});

test("policy resolves overlapping non-deny rules using the last matching rule", async () => {
  const customPolicyPath = await writePolicyFixture(`
version: 1
defaults:
  read: false
  write: false
  proposePatch: false
  openPrOrMr: deny
rules:
  - name: allow-specs-write
    effect: write_via_pr
    paths:
      - Workspace/**
  - name: downgrade-references
    effect: propose_only
    paths:
      - Workspace/reference/**
`);
  const policy = await VaultPolicyEngine.load(customPolicyPath);
  const downgraded = policy.accessForPath("Workspace/reference/guide.md");

  assert.equal(downgraded.read, true);
  assert.equal(downgraded.write, false);
  assert.equal(downgraded.proposePatch, true);
  assert.equal(downgraded.openPrOrMr, "deny");
  assert.deepEqual(downgraded.matchedRules, ["allow-specs-write", "downgrade-references"]);
});
