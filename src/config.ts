import "dotenv/config";

import path from "node:path";
import { z } from "zod";

const configSchema = z.object({
  PORT: z.coerce.number().int().min(0).default(3000),
  HOST: z.string().min(1).default("127.0.0.1"),
  MCP_PATH: z.string().min(1).default("/mcp"),
  MCP_AUTH_TOKEN: z.string().trim().optional().transform((value) => value || undefined),
  VAULT_REPO_ROOT: z.string().min(1),
  VAULT_POLICY_FILE: z.string().min(1),
  GITHUB_OWNER: z.string().min(1),
  GITHUB_REPO: z.string().min(1),
  GITHUB_TOKEN: z.string().trim().optional().transform((value) => value || undefined),
  GITHUB_API_BASE_URL: z.string().url().default("https://api.github.com"),
  GIT_AUTHOR_NAME: z.string().trim().optional().transform((value) => value || undefined),
  GIT_AUTHOR_EMAIL: z.string().trim().optional().transform((value) => value || undefined),
  MAX_CHANGE_FILES: z.coerce.number().int().min(1).max(20).default(5),
  MAX_TOTAL_LINE_DELTA: z.coerce.number().int().min(1).default(400)
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig() {
  const parsed = configSchema.parse(process.env);

  return {
    port: parsed.PORT,
    host: parsed.HOST,
    mcpPath: parsed.MCP_PATH,
    mcpAuthToken: parsed.MCP_AUTH_TOKEN,
    vaultRepoRoot: path.resolve(parsed.VAULT_REPO_ROOT),
    vaultPolicyFile: path.resolve(parsed.VAULT_POLICY_FILE),
    githubOwner: parsed.GITHUB_OWNER,
    githubRepo: parsed.GITHUB_REPO,
    githubToken: parsed.GITHUB_TOKEN,
    githubApiBaseUrl: parsed.GITHUB_API_BASE_URL.replace(/\/$/, ""),
    gitAuthorName: parsed.GIT_AUTHOR_NAME,
    gitAuthorEmail: parsed.GIT_AUTHOR_EMAIL,
    maxChangeFiles: parsed.MAX_CHANGE_FILES,
    maxTotalLineDelta: parsed.MAX_TOTAL_LINE_DELTA
  };
}
