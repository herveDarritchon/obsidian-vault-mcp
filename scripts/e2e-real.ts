import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

import { createHttpApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { logEvent } from "../src/logger.js";

const execFileAsync = promisify(execFile);
process.env.LOG_FORMAT ??= "silent";

const envFile = process.env.E2E_ENV_FILE ?? ".env.e2e";

function loadEnvFileIfPresent(path: string, override: boolean) {
  if (!fs.existsSync(path)) {
    return;
  }

  loadDotenv({ path, override });
}

loadEnvFileIfPresent(".env", false);
loadEnvFileIfPresent(envFile, true);

const e2eConfigSchema = z.object({
  E2E_TARGET: z.string().min(1).optional(),
  E2E_NOTE_PATH: z.string().min(1),
  E2E_SEARCH_ROOT: z.string().min(1).optional().default("02-Work/TOR2e/working"),
  E2E_SEARCH_QUERY: z.string().min(1).optional().default("test note"),
  E2E_BLACKLISTED_PATH: z.string().min(1).optional().default("Private/e2e-secret.md"),
  E2E_BASE_BRANCH: z.string().min(1).optional().default("main"),
  E2E_BRANCH_SCOPE: z.string().min(1).optional().default("e2e"),
  E2E_BRANCH_SLUG: z.string().min(1).optional().default("obsidian-vault-mcp"),
  E2E_CLEANUP: z
    .enum(["true", "false"])
    .optional()
    .default("false")
    .transform((value) => value === "true"),
  E2E_SKIP_PROPOSE_CHANGE: z
    .enum(["true", "false"])
    .optional()
    .default("false")
    .transform((value) => value === "true")
});

type ToolTextResult = {
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

type StepStatus = "passed" | "failed";

interface StepRecord {
  name: string;
  status: StepStatus;
  durationMs: number;
  detail: string;
}

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  blue: "\u001b[34m",
  cyan: "\u001b[36m"
};

const steps: StepRecord[] = [];

function color(text: string, tone: keyof typeof ANSI): string {
  return `${ANSI[tone]}${text}${ANSI.reset}`;
}

function printLine(text = ""): void {
  console.log(text);
}

function printBanner(title: string): void {
  printLine(color(`\n🧪 ${title}`, "bold"));
}

function printInfo(label: string, value: string): void {
  printLine(`${color(label.padEnd(14), "cyan")} ${value}`);
}

function summarizeError(error: unknown): { title: string; hint?: string } {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("GITHUB_TOKEN is required")) {
    return {
      title: "GitHub token manquant",
      hint: "Renseigne GITHUB_TOKEN dans .env.e2e pour activer la création de PR."
    };
  }

  if (message.includes("Resource not accessible by personal access token")) {
    return {
      title: "Token GitHub insuffisant pour créer la PR",
      hint: "Vérifie que le token couvre ce repo et accorde 'Pull requests: write'."
    };
  }

  if (message.includes("not tracked on")) {
    return {
      title: "Fichier de test non tracké sur la branche de base",
      hint: "Committe la note cible sur main avant de lancer propose_change."
    };
  }

  if (message.includes("expected_sha256 mismatch")) {
    return {
      title: "Hash de fraîcheur invalide",
      hint: "Relis la note avant d'appeler update_note_draft ou propose_change."
    };
  }

  if (message.includes("Write denied by policy") || message.includes("Read denied by policy")) {
    return {
      title: "Policy MCP bloquante",
      hint: "Vérifie la policy YAML et le chemin de la note ciblée."
    };
  }

  if (message.includes("Unknown E2E target:")) {
    return {
      title: message,
      hint: "Aligne E2E_TARGET avec le catalogue chargé par VAULT_TARGETS_FILE, ou retire E2E_TARGET pour utiliser la target par défaut."
    };
  }

  return {
    title: message
  };
}

async function runStep<T>(
  name: string,
  action: () => Promise<T>,
  onSuccess: (result: T) => string
): Promise<T> {
  const startedAt = Date.now();
  printLine(`\n${color("🔹", "blue")} ${name} ${color("…", "dim")}`);

  try {
    const result = await action();
    const durationMs = Date.now() - startedAt;
    const detail = onSuccess(result);
    steps.push({ name, status: "passed", durationMs, detail });
    printLine(`${color("✅", "green")} ${name} ${color(`(${durationMs} ms)`, "dim")}`);
    printLine(`   ${detail}`);
    return result;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const summary = summarizeError(error);
    steps.push({ name, status: "failed", durationMs, detail: summary.title });
    printLine(`${color("❌", "red")} ${name} ${color(`(${durationMs} ms)`, "dim")}`);
    printLine(`   ${summary.title}`);

    if (summary.hint) {
      printLine(`   ${color("💡", "yellow")} ${summary.hint}`);
    }

    throw error;
  }
}

async function runExpectedFailureStep(
  name: string,
  action: () => Promise<unknown>,
  matches: (message: string) => boolean,
  onExpectedFailure: (message: string) => string
): Promise<void> {
  const startedAt = Date.now();
  printLine(`\n${color("🔹", "blue")} ${name} ${color("…", "dim")}`);

  try {
    await action();
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);

    if (!matches(message)) {
      const summary = summarizeError(error);
      steps.push({ name, status: "failed", durationMs, detail: summary.title });
      printLine(`${color("❌", "red")} ${name} ${color(`(${durationMs} ms)`, "dim")}`);
      printLine(`   ${summary.title}`);

      if (summary.hint) {
        printLine(`   ${color("💡", "yellow")} ${summary.hint}`);
      }

      throw error;
    }

    const detail = onExpectedFailure(message);
    steps.push({ name, status: "passed", durationMs, detail });
    printLine(`${color("✅", "green")} ${name} ${color(`(${durationMs} ms)`, "dim")}`);
    printLine(`   ${detail}`);
    return;
  }

  const durationMs = Date.now() - startedAt;
  const detail = "The tool unexpectedly succeeded.";
  steps.push({ name, status: "failed", durationMs, detail });
  printLine(`${color("❌", "red")} ${name} ${color(`(${durationMs} ms)`, "dim")}`);
  printLine(`   ${detail}`);
  throw new Error(`${name} unexpectedly succeeded.`);
}

function printSummary(context: {
  elapsedMs: number;
  mode: "pre-pr" | "full";
  notePath: string;
  branchName: string;
  pullRequestUrl?: string;
}) {
  const hasFailure = steps.some((step) => step.status === "failed");
  const heading = hasFailure ? "❌ E2E failed" : "✅ E2E passed";

  printLine();
  printLine(color("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━", "dim"));
  printLine(color(heading, hasFailure ? "red" : "green"));
  printLine(color("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━", "dim"));

  for (const step of steps) {
    const icon = step.status === "passed" ? color("✔", "green") : color("✘", "red");
    printLine(`${icon} ${step.name} ${color(`(${step.durationMs} ms)`, "dim")}`);
    printLine(`  ${step.detail}`);
  }

  printLine();
  printInfo("Mode", context.mode);
  printInfo("Note", context.notePath);
  printInfo("Branch", context.branchName);
  printInfo("Duration", `${context.elapsedMs} ms`);

  if (context.pullRequestUrl) {
    printInfo("PR", context.pullRequestUrl);
  }
}

function parseToolJson<T>(result: ToolTextResult): T {
  if (result.isError) {
    const message = result.content.find((item) => item.type === "text")?.text ?? "Tool call failed.";
    throw new Error(message);
  }

  if (result.structuredContent) {
    return result.structuredContent as T;
  }

  const text = result.content.find((item) => item.type === "text")?.text;

  if (!text) {
    throw new Error("Tool returned no text content.");
  }

  return JSON.parse(text) as T;
}

async function callTool<T>(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<T> {
  const result = await client.request(
    {
      method: "tools/call",
      params: {
        name,
        arguments: args
      }
    },
    CallToolResultSchema
  );

  return parseToolJson<T>(result as ToolTextResult);
}

async function closePullRequest(owner: string, repo: string, token: string, prNumber: number) {
  await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, {
    method: "PATCH",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "obsidian-vault-mcp-e2e"
    },
    body: JSON.stringify({ state: "closed" })
  });
}

async function deleteBranchRef(owner: string, repo: string, token: string, branchName: string) {
  await fetch(`https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branchName)}`, {
    method: "DELETE",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "obsidian-vault-mcp-e2e"
    }
  });
}

async function deleteLocalBranch(repoRoot: string, branchName: string) {
  await execFileAsync("git", ["-C", repoRoot, "branch", "-D", branchName]).catch(() => undefined);
}

async function ensureTrackedFile(repoRoot: string, relativePath: string) {
  await execFileAsync("git", ["-C", repoRoot, "ls-files", "--error-unmatch", "--", relativePath]).catch(() => {
    throw new Error(
      `The E2E note is not tracked on ${repoRoot}. Commit ${relativePath} to ${process.env.E2E_BASE_BRANCH ?? "main"} before running the full PR flow.`
    );
  });
}

async function verifyPullRequest(owner: string, repo: string, token: string, prNumber: number) {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "obsidian-vault-mcp-e2e"
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to verify PR #${prNumber}: ${response.status} ${await response.text()}`);
  }

  return (await response.json()) as {
    number: number;
    state: string;
    head: { ref: string };
    base: { ref: string };
    html_url: string;
  };
}

async function main() {
  const startedAt = Date.now();
  const e2eConfig = e2eConfigSchema.parse(process.env);
  const config = loadConfig();
  const activeTargetName = e2eConfig.E2E_TARGET ?? config.defaultTarget;
  const activeTarget = config.targets[activeTargetName];
  const mode = e2eConfig.E2E_SKIP_PROPOSE_CHANGE ? "pre-pr" : "full";
  const app = await createHttpApp({
    ...config,
    host: "127.0.0.1",
    port: 0
  });

  if (!activeTarget) {
    const loadedCatalog = process.env.VAULT_TARGETS_FILE ?? "(single-target mode)";
    throw new Error(
      `Unknown E2E target: ${activeTargetName}. Available targets: ${Object.keys(config.targets).sort().join(", ")}. Loaded config: ${loadedCatalog}`
    );
  }

  const server = await new Promise<import("node:http").Server>((resolve, reject) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    instance.once("error", reject);
  });

  const address = server.address() as AddressInfo;
  const baseUrl = new URL(`http://127.0.0.1:${address.port}${config.mcpPath}`);
  const runId = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const branchName = `ai/${e2eConfig.E2E_BRANCH_SCOPE}/${e2eConfig.E2E_BRANCH_SLUG}-${runId}`;
  const commitMessage = `ai(${e2eConfig.E2E_BRANCH_SCOPE}): verify end-to-end PR workflow`;
  const marker = `\n<!-- obsidian-vault-mcp-e2e:${runId} -->\n`;
  let pullRequestUrl: string | undefined;

  printBanner("Obsidian Vault MCP E2E");
  printInfo("Env file", envFile);
  printInfo("Target", activeTargetName);
  printInfo("Repo", activeTarget.vaultRepoRoot);
  printInfo("Mode", mode);
  printInfo("Note", e2eConfig.E2E_NOTE_PATH);
  printInfo("Search root", e2eConfig.E2E_SEARCH_ROOT);
  printInfo("Blacklist", e2eConfig.E2E_BLACKLISTED_PATH);
  printInfo("Branch", branchName);

  if (!e2eConfig.E2E_SKIP_PROPOSE_CHANGE) {
    if (!activeTarget.githubToken) {
      throw new Error(
        "GITHUB_TOKEN is required for the full E2E flow. Set it in .env.e2e or export it before running npm run test:e2e:real."
      );
    }

    await runStep(
      "Verify tracked note",
      () => ensureTrackedFile(activeTarget.vaultRepoRoot, e2eConfig.E2E_NOTE_PATH),
      () => `Tracked on ${e2eConfig.E2E_BASE_BRANCH}`
    );
  }

  const transport = new StreamableHTTPClientTransport(baseUrl, {
    ...(config.mcpAuthToken
      ? {
          requestInit: {
            headers: {
              Authorization: `Bearer ${config.mcpAuthToken}`
            }
          }
        }
      : {})
  });

  const client = new Client({
    name: "obsidian-vault-mcp-e2e",
    version: "0.1.0"
  });

  try {
    await runStep(
      "Connect MCP client",
      () =>
        client.connect(
          transport as unknown as Parameters<typeof client.connect>[0]
        ),
      () => `Connected to ${baseUrl.toString()}`
    );

    const tools = await runStep(
      "List tools",
      () =>
        client.request(
          {
            method: "tools/list",
            params: {}
          },
          ListToolsResultSchema
        ),
      (result) => `Found ${result.tools.length} tools: ${result.tools.map((tool) => tool.name).join(", ")}`
    );

    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      ["list_notes", "propose_change", "read_note", "search_notes", "update_note_draft"]
    );

    const readResult = await runStep(
      "Read note",
      () =>
        callTool<{
          path: string;
          sha256: string;
          content: string;
          policy: { read: boolean; write: boolean };
        }>(client, "read_note", {
          target: activeTargetName,
          path: e2eConfig.E2E_NOTE_PATH
        }),
      (result) => `sha=${result.sha256.slice(0, 12)} read=${String(result.policy.read)} write=${String(result.policy.write)}`
    );

    assert.equal(readResult.path, e2eConfig.E2E_NOTE_PATH);
    assert.equal(readResult.policy.read, true);

    const searchResult = await runStep(
      "Search notes",
      () =>
        callTool<{ results: Array<{ path: string }> }>(client, "search_notes", {
          target: activeTargetName,
          query: e2eConfig.E2E_SEARCH_QUERY,
          roots: [e2eConfig.E2E_SEARCH_ROOT],
          limit: 10
        }),
      (result) => {
        const topPath = result.results[0]?.path ?? "none";
        return `${result.results.length} result(s), top hit: ${topPath}`;
      }
    );

    assert.ok(
      searchResult.results.some((result) => result.path === e2eConfig.E2E_NOTE_PATH),
      `Expected search_notes to return ${e2eConfig.E2E_NOTE_PATH}`
    );

    const draftResult = await runStep(
      "Prepare draft",
      () =>
        callTool<{
          draft_content: string;
          current_sha256: string;
          draft_sha256: string;
          diff_summary: { line_delta: number };
        }>(client, "update_note_draft", {
          target: activeTargetName,
          path: e2eConfig.E2E_NOTE_PATH,
          mode: "append",
          content: marker,
          expected_sha256: readResult.sha256
        }),
      (result) =>
        `sha ${result.current_sha256.slice(0, 12)} -> ${result.draft_sha256.slice(0, 12)}, line delta ${result.diff_summary.line_delta}`
    );

    assert.equal(draftResult.current_sha256, readResult.sha256);
    assert.ok(draftResult.draft_content.includes(marker.trim()));
    assert.ok(draftResult.diff_summary.line_delta >= 1);

    await runExpectedFailureStep(
      "Refuse blacklisted read",
      () =>
        callTool(client, "read_note", {
          target: activeTargetName,
          path: e2eConfig.E2E_BLACKLISTED_PATH
        }),
      (message) => message.includes("Read denied by policy"),
      () => `Policy correctly denied ${e2eConfig.E2E_BLACKLISTED_PATH}`
    );

    const staleSha =
      readResult.sha256.slice(0, -1) + (readResult.sha256.endsWith("0") ? "1" : "0");

    await runExpectedFailureStep(
      "Reject stale hash",
      () =>
        callTool(client, "update_note_draft", {
          target: activeTargetName,
          path: e2eConfig.E2E_NOTE_PATH,
          mode: "append",
          content: `${marker.trim()}\n<!-- stale-hash-check -->`,
          expected_sha256: staleSha
        }),
      (message) => message.includes("expected_sha256 mismatch"),
      () => `Server rejected a stale expected_sha256 for ${e2eConfig.E2E_NOTE_PATH}`
    );

    if (e2eConfig.E2E_SKIP_PROPOSE_CHANGE) {
      steps.push({
        name: "Skip propose_change",
        status: "passed",
        durationMs: 0,
        detail: "Pre-PR mode enabled in .env.e2e"
      });
      logEvent("info", "e2e_real_pre_pr_completed", {
        notePath: e2eConfig.E2E_NOTE_PATH,
        mode: "read-search-draft"
      });
    } else {
      const proposeResult = await runStep(
        "Create branch, push, open PR",
        () =>
          callTool<{
            branch: string;
            commit_sha: string;
            pull_request: { number: number; url: string };
            changed_files: string[];
          }>(client, "propose_change", {
            target: activeTargetName,
            title: `E2E validation ${runId}`,
            base_branch: e2eConfig.E2E_BASE_BRANCH,
            branch_name: branchName,
            commit_message: commitMessage,
            pr_body: `Automated E2E validation run ${runId}.`,
            changes: [
              {
                path: e2eConfig.E2E_NOTE_PATH,
                mode: "append",
                content: marker,
                expected_sha256: readResult.sha256
              }
            ]
          }),
        (result) => `branch=${result.branch} commit=${result.commit_sha.slice(0, 12)} pr=${result.pull_request.url}`
      );

      assert.equal(proposeResult.branch, branchName);
      assert.equal(proposeResult.changed_files.length, 1);
      assert.equal(proposeResult.changed_files[0], e2eConfig.E2E_NOTE_PATH);
      assert.ok(proposeResult.pull_request.url.includes(`/pull/${proposeResult.pull_request.number}`));
      pullRequestUrl = proposeResult.pull_request.url;

      const verifiedPullRequest = await runStep(
        "Verify GitHub PR",
        () =>
          verifyPullRequest(
            activeTarget.githubOwner,
            activeTarget.githubRepo,
            activeTarget.githubToken!,
            proposeResult.pull_request.number
          ),
        (result) => `PR #${result.number} is ${result.state} on ${result.base.ref} <- ${result.head.ref}`
      );

      assert.equal(verifiedPullRequest.number, proposeResult.pull_request.number);
      assert.equal(verifiedPullRequest.state, "open");
      assert.equal(verifiedPullRequest.head.ref, branchName);
      assert.equal(verifiedPullRequest.base.ref, e2eConfig.E2E_BASE_BRANCH);

      logEvent("info", "e2e_real_completed", {
        notePath: e2eConfig.E2E_NOTE_PATH,
        branch: branchName,
        pullRequest: proposeResult.pull_request.url
      });

      if (e2eConfig.E2E_CLEANUP) {
        await runStep(
          "Cleanup PR and branch",
          async () => {
            await closePullRequest(
              activeTarget.githubOwner,
              activeTarget.githubRepo,
              activeTarget.githubToken!,
              proposeResult.pull_request.number
            );
            await deleteBranchRef(activeTarget.githubOwner, activeTarget.githubRepo, activeTarget.githubToken!, branchName);
            await deleteLocalBranch(activeTarget.vaultRepoRoot, branchName);
          },
          () => `Closed PR #${proposeResult.pull_request.number} and removed ${branchName}`
        );
        logEvent("info", "e2e_real_cleanup_completed", {
          branch: branchName,
          pullRequestNumber: proposeResult.pull_request.number
        });
      }
    }
  } finally {
    await transport.close().catch(() => undefined);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  printSummary({
    elapsedMs: Date.now() - startedAt,
    mode,
    notePath: e2eConfig.E2E_NOTE_PATH,
    branchName,
    ...(pullRequestUrl ? { pullRequestUrl } : {})
  });
}

main().catch((error) => {
  const summary = summarizeError(error);

  if (!steps.some((step) => step.status === "failed")) {
    steps.push({
      name: "Bootstrap E2E run",
      status: "failed",
      durationMs: 0,
      detail: summary.title
    });
  }

  printSummary({
    elapsedMs: 0,
    mode: process.env.E2E_SKIP_PROPOSE_CHANGE === "true" ? "pre-pr" : "full",
    notePath: process.env.E2E_NOTE_PATH ?? "unknown",
    branchName: "not-created"
  });
  printLine();
  printLine(`${color("❗ Why it failed", "red")}`);
  printLine(`   ${summary.title}`);

  if (summary.hint) {
    printLine(`   ${color("💡", "yellow")} ${summary.hint}`);
  }

  process.exitCode = 1;
});
