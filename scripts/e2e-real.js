import "dotenv/config";
import assert from "node:assert/strict";
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
        .transform((value) => value === "true")
});
function parseToolJson(result) {
    if (result.isError) {
        const message = result.content.find((item) => item.type === "text")?.text ?? "Tool call failed.";
        throw new Error(message);
    }
    if (result.structuredContent) {
        return result.structuredContent;
    }
    const text = result.content.find((item) => item.type === "text")?.text;
    if (!text) {
        throw new Error("Tool returned no text content.");
    }
    return JSON.parse(text);
}
async function callTool(client, name, args) {
    const result = await client.request({
        method: "tools/call",
        params: {
            name,
            arguments: args
        }
    }, CallToolResultSchema);
    return parseToolJson(result);
}
async function closePullRequest(owner, repo, token, prNumber) {
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
async function deleteBranchRef(owner, repo, token, branchName) {
    await fetch(`https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branchName)}`, {
        method: "DELETE",
        headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "User-Agent": "obsidian-vault-mcp-e2e"
        }
    });
}
async function deleteLocalBranch(repoRoot, branchName) {
    await execFileAsync("git", ["-C", repoRoot, "branch", "-D", branchName]).catch(() => undefined);
}
async function verifyPullRequest(owner, repo, token, prNumber) {
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
    return (await response.json());
}
async function main() {
    const config = loadConfig();
    const e2eConfig = e2eConfigSchema.parse(process.env);
    const app = await createHttpApp({
        ...config,
        host: "127.0.0.1",
        port: 0
    });
    const server = await new Promise((resolve, reject) => {
        const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
        instance.once("error", reject);
    });
    const address = server.address();
    const baseUrl = new URL(`http://127.0.0.1:${address.port}${config.mcpPath}`);
    const runId = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    const branchName = `ai/${e2eConfig.E2E_BRANCH_SCOPE}/${e2eConfig.E2E_BRANCH_SLUG}-${runId}`;
    const commitMessage = `ai(${e2eConfig.E2E_BRANCH_SCOPE}): verify end-to-end PR workflow`;
    const marker = `\n<!-- obsidian-vault-mcp-e2e:${runId} -->\n`;
    const transport = new StreamableHTTPClientTransport(baseUrl, {
        requestInit: config.mcpAuthToken
            ? {
                headers: {
                    Authorization: `Bearer ${config.mcpAuthToken}`
                }
            }
            : undefined
    });
    const client = new Client({
        name: "obsidian-vault-mcp-e2e",
        version: "0.1.0"
    });
    try {
        await client.connect(transport);
        const tools = await client.request({
            method: "tools/list",
            params: {}
        }, ListToolsResultSchema);
        assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["propose_change", "read_note", "search_notes", "update_note_draft"]);
        const readResult = await callTool(client, "read_note", {
            path: e2eConfig.E2E_NOTE_PATH
        });
        assert.equal(readResult.path, e2eConfig.E2E_NOTE_PATH);
        assert.equal(readResult.policy.read, true);
        const searchResult = await callTool(client, "search_notes", {
            query: e2eConfig.E2E_SEARCH_QUERY,
            roots: [e2eConfig.E2E_SEARCH_ROOT],
            limit: 10
        });
        assert.ok(searchResult.results.some((result) => result.path === e2eConfig.E2E_NOTE_PATH), `Expected search_notes to return ${e2eConfig.E2E_NOTE_PATH}`);
        const draftResult = await callTool(client, "update_note_draft", {
            path: e2eConfig.E2E_NOTE_PATH,
            mode: "append",
            content: marker,
            expected_sha256: readResult.sha256
        });
        assert.equal(draftResult.current_sha256, readResult.sha256);
        assert.ok(draftResult.draft_content.includes(marker.trim()));
        assert.ok(draftResult.diff_summary.line_delta >= 1);
        const proposeResult = await callTool(client, "propose_change", {
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
        const verifiedPullRequest = await verifyPullRequest(config.githubOwner, config.githubRepo, config.githubToken, proposeResult.pull_request.number);
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
            await closePullRequest(config.githubOwner, config.githubRepo, config.githubToken, proposeResult.pull_request.number);
            await deleteBranchRef(config.githubOwner, config.githubRepo, config.githubToken, branchName);
            await deleteLocalBranch(config.vaultRepoRoot, branchName);
            logEvent("info", "e2e_real_cleanup_completed", {
                branch: branchName,
                pullRequestNumber: proposeResult.pull_request.number
            });
        }
    }
    finally {
        await transport.close().catch(() => undefined);
        await new Promise((resolve, reject) => {
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
//# sourceMappingURL=e2e-real.js.map