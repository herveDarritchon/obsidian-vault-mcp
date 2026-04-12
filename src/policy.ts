import fs from "node:fs/promises";
import { minimatch } from "minimatch";
import yaml from "js-yaml";
import { z } from "zod";

import type { PolicyAccess } from "./types.js";
import { normalizeVaultPath } from "./lib/paths.js";

const accessSchema = z.object({
  read: z.boolean(),
  write: z.boolean(),
  proposePatch: z.boolean(),
  openPrOrMr: z.enum(["require", "deny"])
});

const policyRuleSchema = z.object({
  name: z.string().min(1),
  effect: z.enum(["deny", "propose_only", "write_via_pr"]),
  paths: z.array(z.string().min(1)).min(1)
});

const policyDocumentSchema = z.object({
  version: z.literal(1),
  defaults: accessSchema.optional(),
  rules: z.array(policyRuleSchema).min(1)
});

type PolicyDocument = z.infer<typeof policyDocumentSchema>;
type PolicyRule = z.infer<typeof policyRuleSchema>;

const DENY_ACCESS: Omit<PolicyAccess, "matchedRules"> = {
  read: false,
  write: false,
  proposePatch: false,
  openPrOrMr: "deny"
};

const PROPOSE_ONLY_ACCESS: Omit<PolicyAccess, "matchedRules"> = {
  read: true,
  write: false,
  proposePatch: true,
  openPrOrMr: "deny"
};

const WRITE_VIA_PR_ACCESS: Omit<PolicyAccess, "matchedRules"> = {
  read: true,
  write: true,
  proposePatch: true,
  openPrOrMr: "require"
};

export class VaultPolicyEngine {
  private constructor(private readonly document: PolicyDocument) {}

  static async load(filePath: string): Promise<VaultPolicyEngine> {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = yaml.load(raw);
    const document = policyDocumentSchema.parse(parsed);
    return new VaultPolicyEngine(document);
  }

  accessForPath(relativePath: string): PolicyAccess {
    const normalizedPath = normalizeVaultPath(relativePath);
    const matchedRules = this.document.rules.filter((rule) =>
      rule.paths.some((pattern) =>
        minimatch(normalizedPath, pattern, {
          dot: true,
          nocase: false
        })
      )
    );

    const matchedRuleNames = matchedRules.map((rule) => rule.name);

    if (matchedRules.some((rule) => rule.effect === "deny")) {
      return { ...DENY_ACCESS, matchedRules: matchedRuleNames };
    }

    for (let index = matchedRules.length - 1; index >= 0; index -= 1) {
      const rule = matchedRules[index];

      if (rule?.effect === "write_via_pr") {
        return { ...WRITE_VIA_PR_ACCESS, matchedRules: matchedRuleNames };
      }

      if (rule?.effect === "propose_only") {
        return { ...PROPOSE_ONLY_ACCESS, matchedRules: matchedRuleNames };
      }
    }

    const defaults = this.document.defaults ?? DENY_ACCESS;
    return { ...defaults, matchedRules: matchedRuleNames };
  }

  allowsReadBelow(relativePath: string): boolean {
    const normalizedPath = normalizeVaultPath(relativePath);
    const overlappingRules = this.document.rules.filter((rule) =>
      rule.paths.some((pattern) => pathOverlapsPattern(normalizedPath, pattern))
    );

    if (overlappingRules.some((rule) => rule.effect === "deny")) {
      return false;
    }

    return overlappingRules.some(
      (rule) => rule.effect === "propose_only" || rule.effect === "write_via_pr"
    );
  }
}

function pathOverlapsPattern(relativePath: string, pattern: string): boolean {
  if (
    minimatch(relativePath, pattern, {
      dot: true,
      nocase: false
    })
  ) {
    return true;
  }

  const staticPrefix = extractStaticPrefix(pattern);

  if (!staticPrefix) {
    return false;
  }

  return (
    relativePath === staticPrefix ||
    relativePath.startsWith(`${staticPrefix}/`) ||
    staticPrefix.startsWith(`${relativePath}/`)
  );
}

function extractStaticPrefix(pattern: string): string {
  const firstWildcardIndex = pattern.search(/[*?[\]{}()!+@]/);
  const prefix = firstWildcardIndex >= 0 ? pattern.slice(0, firstWildcardIndex) : pattern;
  return prefix.replace(/\/+$/, "");
}
