import "dotenv/config";

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

import { createHttpApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { logEvent } from "../src/logger.js";

const execFileAsync = promisify(execFile);

const envFile = process.env.E2E_ENV_FILE ?? ".env.e2e";
loadDotenv({ path: envFile, override: true });

const e2eConfigSchema = z.object({
  E2E_NOTE_PATH: z.string().min(1),
  E2E_SEARCH_ROOT: z.string().min(1).optional().default("02-Work/TOR2e/working"),
  E2E_SEARCH_QUERY: z.string().min(1).optional().default("test note"),
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
  const e2eConfig = e2eConfigSchema.parse(process.env);
  const config = loadConfig();
  const app = await createHttpApp({
    ...config,
    host: "127.0.0.1",
    port: 0
  });

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

  if (!e2eConfig.E2E_SKIP_PROPOSE_CHANGE) {
    if (!config.githubToken) {
      throw new Error(
        "GITHUB_TOKEN is required for the full E2E flow. Set it in .env.e2e or export it before running npm run test:e2e:real."
      );
    }

    await ensureTrackedFile(config.vaultRepoRoot, e2eConfig.E2E_NOTE_PATH);
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
    await client.connect(
      transport as unknown as Parameters<typeof client.connect>[0]
    );

    const tools = await client.request(
      {
        method: "tools/list",
        params: {}
      },
      ListToolsResultSchema
    );

    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      ["propose_change", "read_note", "search_notes", "update_note_draft"]
    );

    const readResult = await callTool<{
      path: string;
      sha256: string;
      content: string;
      policy: { read: boolean; write: boolean };
    }>(client, "read_note", {
      path: e2eConfig.E2E_NOTE_PATH
    });

    assert.equal(readResult.path, e2eConfig.E2E_NOTE_PATH);
    assert.equal(readResult.policy.read, true);

    const searchResult = await callTool<{ results: Array<{ path: string }> }>(client, "search_notes", {
      query: e2eConfig.E2E_SEARCH_QUERY,
      roots: [e2eConfig.E2E_SEARCH_ROOT],
      limit: 10
    });

    assert.ok(
      searchResult.results.some((result) => result.path === e2eConfig.E2E_NOTE_PATH),
      `Expected search_notes to return ${e2eConfig.E2E_NOTE_PATH}`
    );

    const draftResult = await callTool<{
      draft_content: string;
      current_sha256: string;
      draft_sha256: string;
      diff_summary: { line_delta: number };
    }>(client, "update_note_draft", {
      path: e2eConfig.E2E_NOTE_PATH,
      mode: "append",
      content: marker,
      expected_sha256: readResult.sha256
    });

    assert.equal(draftResult.current_sha256, readResult.sha256);
    assert.ok(draftResult.draft_content.includes(marker.trim()));
    assert.ok(draftResult.diff_summary.line_delta >= 1);

    if (e2eConfig.E2E_SKIP_PROPOSE_CHANGE) {
      logEvent("info", "e2e_real_pre_pr_completed", {
        notePath: e2eConfig.E2E_NOTE_PATH,
        mode: "read-search-draft"
      });
    } else {
      const proposeResult = await callTool<{
        branch: string;
        commit_sha: string;
        pull_request: { number: number; url: string };
        changed_files: string[];
      }>(client, "propose_change", {
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
      });

      assert.equal(proposeResult.branch, branchName);
      assert.equal(proposeResult.changed_files.length, 1);
      assert.equal(proposeResult.changed_files[0], e2eConfig.E2E_NOTE_PATH);
      assert.ok(proposeResult.pull_request.url.includes(`/pull/${proposeResult.pull_request.number}`));

      const verifiedPullRequest = await verifyPullRequest(
        config.githubOwner,
        config.githubRepo,
        config.githubToken!,
        proposeResult.pull_request.number
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
        await closePullRequest(config.githubOwner, config.githubRepo, config.githubToken!, proposeResult.pull_request.number);
        await deleteBranchRef(config.githubOwner, config.githubRepo, config.githubToken!, branchName);
        await deleteLocalBranch(config.vaultRepoRoot, branchName);
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
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
