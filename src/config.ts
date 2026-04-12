import "dotenv/config";

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { z } from "zod";

const baseConfigSchema = z.object({
  PORT: z.coerce.number().int().min(0).default(3000),
  HOST: z.string().min(1).default("127.0.0.1"),
  MCP_PATH: z.string().min(1).default("/mcp"),
  MCP_AUTH_TOKEN: z.string().trim().optional().transform((value) => value || undefined),
  VAULT_TARGET: z.string().trim().optional().transform((value) => value || undefined),
  VAULT_TARGETS_FILE: z.string().trim().optional().transform((value) => value || undefined),
  VAULT_REPO_ROOT: z.string().trim().optional().transform((value) => value || undefined),
  VAULT_POLICY_FILE: z.string().trim().optional().transform((value) => value || undefined),
  GITHUB_OWNER: z.string().trim().optional().transform((value) => value || undefined),
  GITHUB_REPO: z.string().trim().optional().transform((value) => value || undefined),
  GITHUB_TOKEN: z.string().trim().optional().transform((value) => value || undefined),
  GITHUB_DEFAULT_BRANCH: z.string().trim().min(1).default("main"),
  GITHUB_API_BASE_URL: z.string().url().default("https://api.github.com"),
  GIT_AUTHOR_NAME: z.string().trim().optional().transform((value) => value || undefined),
  GIT_AUTHOR_EMAIL: z.string().trim().optional().transform((value) => value || undefined),
  MAX_CHANGE_FILES: z.coerce.number().int().min(1).max(20).default(5),
  MAX_TOTAL_LINE_DELTA: z.coerce.number().int().min(1).default(400)
});

const targetEntrySchema = z.object({
  repoRoot: z.string().min(1),
  policyFile: z.string().min(1),
  github: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    defaultBranch: z.string().min(1).optional()
  }),
  githubApiBaseUrl: z.string().url().optional(),
  githubTokenEnv: z.string().min(1).optional(),
  gitAuthorName: z.string().min(1).optional(),
  gitAuthorEmail: z.string().min(1).optional(),
  maxChangeFiles: z.number().int().min(1).max(20).optional(),
  maxTotalLineDelta: z.number().int().min(1).optional()
});

const targetsFileSchema = z.object({
  version: z.literal(1),
  defaultTarget: z.string().min(1).optional(),
  targets: z.record(z.string().min(1), targetEntrySchema).refine(
    (value) => Object.keys(value).length > 0,
    "targets must contain at least one entry."
  )
});

type ParsedBaseConfig = z.infer<typeof baseConfigSchema>;
type ParsedTargetFile = z.infer<typeof targetsFileSchema>;

export interface VaultTargetConfig {
  name: string;
  vaultRepoRoot: string;
  vaultPolicyFile: string;
  githubOwner: string;
  githubRepo: string;
  githubToken?: string;
  githubDefaultBranch: string;
  githubApiBaseUrl: string;
  gitAuthorName?: string;
  gitAuthorEmail?: string;
  maxChangeFiles: number;
  maxTotalLineDelta: number;
}

export interface AppConfig {
  port: number;
  host: string;
  mcpPath: string;
  mcpAuthToken?: string;
  defaultTarget: string;
  targets: Record<string, VaultTargetConfig>;
}

function requiredValue(value: string | undefined, variableName: string): string {
  if (!value) {
    throw new Error(`${variableName} is required.`);
  }

  return value;
}

function resolveAbsolutePath(baseDirectory: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(baseDirectory, filePath);
}

function normalizeBaseConfig(parsed: ParsedBaseConfig): Omit<AppConfig, "defaultTarget" | "targets"> {
  return {
    port: parsed.PORT,
    host: parsed.HOST,
    mcpPath: parsed.MCP_PATH,
    ...(parsed.MCP_AUTH_TOKEN ? { mcpAuthToken: parsed.MCP_AUTH_TOKEN } : {})
  };
}

function buildLegacyTargetConfig(parsed: ParsedBaseConfig): AppConfig {
  const targetName = parsed.VAULT_TARGET ?? "default";

  return {
    ...normalizeBaseConfig(parsed),
    defaultTarget: targetName,
    targets: {
      [targetName]: {
        name: targetName,
        vaultRepoRoot: path.resolve(requiredValue(parsed.VAULT_REPO_ROOT, "VAULT_REPO_ROOT")),
        vaultPolicyFile: path.resolve(requiredValue(parsed.VAULT_POLICY_FILE, "VAULT_POLICY_FILE")),
        githubOwner: requiredValue(parsed.GITHUB_OWNER, "GITHUB_OWNER"),
        githubRepo: requiredValue(parsed.GITHUB_REPO, "GITHUB_REPO"),
        ...(parsed.GITHUB_TOKEN ? { githubToken: parsed.GITHUB_TOKEN } : {}),
        githubDefaultBranch: parsed.GITHUB_DEFAULT_BRANCH,
        githubApiBaseUrl: parsed.GITHUB_API_BASE_URL.replace(/\/$/, ""),
        ...(parsed.GIT_AUTHOR_NAME ? { gitAuthorName: parsed.GIT_AUTHOR_NAME } : {}),
        ...(parsed.GIT_AUTHOR_EMAIL ? { gitAuthorEmail: parsed.GIT_AUTHOR_EMAIL } : {}),
        maxChangeFiles: parsed.MAX_CHANGE_FILES,
        maxTotalLineDelta: parsed.MAX_TOTAL_LINE_DELTA
      }
    }
  };
}

function loadTargetsFile(parsed: ParsedBaseConfig): AppConfig {
  const targetsFilePath = path.resolve(requiredValue(parsed.VAULT_TARGETS_FILE, "VAULT_TARGETS_FILE"));
  const fileDirectory = path.dirname(targetsFilePath);
  const raw = fs.readFileSync(targetsFilePath, "utf8");
  const loadedDocument = yaml.load(raw);

  if (
    loadedDocument &&
    typeof loadedDocument === "object" &&
    !Array.isArray(loadedDocument) &&
    ("rules" in loadedDocument || "defaults" in loadedDocument) &&
    !("targets" in loadedDocument)
  ) {
    throw new Error(
      `VAULT_TARGETS_FILE must point to a targets catalog, but ${targetsFilePath} looks like a policy file. ` +
        `Use a file like config/vault-targets.example.yaml, or unset VAULT_TARGETS_FILE to use single-target mode.`
    );
  }

  const parsedDocument = targetsFileSchema.safeParse(loadedDocument);

  if (!parsedDocument.success) {
    throw new Error(
      `Invalid targets catalog at ${targetsFilePath}: ${parsedDocument.error.message}`
    );
  }

  const document = parsedDocument.data as ParsedTargetFile;
  const targetNames = Object.keys(document.targets);
  const defaultTarget = parsed.VAULT_TARGET ?? document.defaultTarget ?? targetNames[0];

  if (!defaultTarget || !(defaultTarget in document.targets)) {
    throw new Error(
      `Unknown default target "${defaultTarget}". Available targets: ${targetNames.sort().join(", ")}`
    );
  }

  const targets = Object.fromEntries(
    Object.entries(document.targets).map(([targetName, entry]) => {
      const tokenEnvName = entry.githubTokenEnv ?? "GITHUB_TOKEN";
      const token = process.env[tokenEnvName]?.trim() || parsed.GITHUB_TOKEN;
      const gitAuthorName = entry.gitAuthorName ?? parsed.GIT_AUTHOR_NAME;
      const gitAuthorEmail = entry.gitAuthorEmail ?? parsed.GIT_AUTHOR_EMAIL;
      const targetConfig: VaultTargetConfig = {
        name: targetName,
        vaultRepoRoot: resolveAbsolutePath(fileDirectory, entry.repoRoot),
        vaultPolicyFile: resolveAbsolutePath(fileDirectory, entry.policyFile),
        githubOwner: entry.github.owner,
        githubRepo: entry.github.repo,
        ...(token ? { githubToken: token } : {}),
        githubDefaultBranch: entry.github.defaultBranch ?? parsed.GITHUB_DEFAULT_BRANCH,
        githubApiBaseUrl: (entry.githubApiBaseUrl ?? parsed.GITHUB_API_BASE_URL).replace(/\/$/, ""),
        ...(gitAuthorName ? { gitAuthorName } : {}),
        ...(gitAuthorEmail ? { gitAuthorEmail } : {}),
        maxChangeFiles: entry.maxChangeFiles ?? parsed.MAX_CHANGE_FILES,
        maxTotalLineDelta: entry.maxTotalLineDelta ?? parsed.MAX_TOTAL_LINE_DELTA
      };

      return [
        targetName,
        targetConfig
      ];
    })
  ) as Record<string, VaultTargetConfig>;

  return {
    ...normalizeBaseConfig(parsed),
    defaultTarget,
    targets
  };
}

export function loadConfig(): AppConfig {
  const parsed = baseConfigSchema.parse(process.env);

  if (parsed.VAULT_TARGETS_FILE) {
    return loadTargetsFile(parsed);
  }

  return buildLegacyTargetConfig(parsed);
}
