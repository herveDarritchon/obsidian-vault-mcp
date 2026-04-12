import assert from "node:assert/strict";
import test from "node:test";
import { VaultPolicyEngine } from "../src/policy.js";
const policyPath = new URL("../config/vault-access-policy.example.yaml", import.meta.url);
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
//# sourceMappingURL=policy.test.js.map