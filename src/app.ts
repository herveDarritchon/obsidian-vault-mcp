import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import type { AppConfig } from "./config.js";
import { isRefusalError } from "./errors.js";
import { logEvent } from "./logger.js";
import { VaultService } from "./vault-service.js";

const policySchemaDefinition = {
  read: z.boolean(),
  write: z.boolean(),
  proposePatch: z.boolean(),
  openPrOrMr: z.enum(["require", "deny"]),
  matchedRules: z.array(z.string())
};

const readNoteOutputSchema = {
  path: z.string(),
  sha256: z.string(),
  content: z.string(),
  policy: z.object(policySchemaDefinition)
};

const searchNotesOutputSchema = {
  results: z.array(
    z.object({
      path: z.string(),
      snippet: z.string(),
      score: z.number()
    })
  )
};

const updateDraftOutputSchema = {
  path: z.string(),
  current_sha256: z.string(),
  draft_sha256: z.string(),
  draft_content: z.string(),
  diff_summary: z.object({
    changed_sections: z.array(z.string()),
    line_delta: z.number().int()
  }),
  warnings: z.array(z.string()),
  policy: z.object(policySchemaDefinition)
};

const proposeChangeOutputSchema = {
  branch: z.string(),
  commit_sha: z.string(),
  pull_request: z.object({
    number: z.number().int(),
    url: z.string().url()
  }),
  changed_files: z.array(z.string())
};

function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true
  };
}

function jsonText(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function withStructuredContent<T extends Record<string, unknown>>(output: T) {
  return {
    content: [{ type: "text" as const, text: jsonText(output) }],
    structuredContent: output
  };
}

function createMcpServer(vaultService: VaultService) {
  const server = new McpServer({
    name: "obsidian-vault",
    version: "0.1.0"
  });

  server.registerTool(
    "read_note",
    {
      title: "Read Obsidian note",
      description: "Reads a note from the vault after policy checks.",
      inputSchema: {
        path: z.string()
      },
      outputSchema: readNoteOutputSchema,
      annotations: {
        readOnlyHint: true
      }
    },
    async ({ path }) => {
      const requestId = randomUUID();
      logEvent("info", "tool_invoked", {
        requestId,
        tool: "read_note",
        paths: [path]
      });

      try {
        const output = await vaultService.readNote(path);
        logEvent("info", "tool_completed", {
          requestId,
          tool: "read_note",
          result: "success",
          paths: [output.path]
        });
        return withStructuredContent(output);
      } catch (error) {
        const message = error instanceof Error ? error.message : "read_note failed";
        logEvent(isRefusalError(error) ? "warn" : "error", "tool_completed", {
          requestId,
          tool: "read_note",
          result: isRefusalError(error) ? "refusal" : "error",
          paths: [path],
          error: message
        });
        return toolError(message);
      }
    }
  );

  server.registerTool(
    "search_notes",
    {
      title: "Search Obsidian notes",
      description: "Searches readable notes under selected roots.",
      inputSchema: {
        query: z.string(),
        roots: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(50).default(10)
      },
      outputSchema: searchNotesOutputSchema,
      annotations: {
        readOnlyHint: true
      }
    },
    async ({ query, roots, limit }) => {
      const requestId = randomUUID();
      logEvent("info", "tool_invoked", {
        requestId,
        tool: "search_notes",
        paths: roots ?? ["."],
        limit
      });

      try {
        const output = await vaultService.searchNotes(query, roots, limit);
        logEvent("info", "tool_completed", {
          requestId,
          tool: "search_notes",
          result: "success",
          paths: roots ?? ["."],
          resultCount: output.results.length
        });
        return withStructuredContent(output);
      } catch (error) {
        const message = error instanceof Error ? error.message : "search_notes failed";
        logEvent(isRefusalError(error) ? "warn" : "error", "tool_completed", {
          requestId,
          tool: "search_notes",
          result: isRefusalError(error) ? "refusal" : "error",
          paths: roots ?? ["."],
          error: message
        });
        return toolError(message);
      }
    }
  );

  server.registerTool(
    "update_note_draft",
    {
      title: "Prepare a note draft",
      description: "Computes a candidate markdown edit without touching git or GitHub.",
      inputSchema: {
        path: z.string(),
        mode: z.enum(["replace_full", "append", "replace_section"]),
        content: z.string(),
        section_heading: z.string().optional(),
        expected_sha256: z.string().optional()
      },
      outputSchema: updateDraftOutputSchema,
      annotations: {
        readOnlyHint: true
      }
    },
    async ({ path, mode, content, section_heading, expected_sha256 }) => {
      const requestId = randomUUID();
      logEvent("info", "tool_invoked", {
        requestId,
        tool: "update_note_draft",
        paths: [path],
        mode
      });

      try {
        const output = await vaultService.updateNoteDraft({
          path,
          mode,
          content,
          ...(section_heading ? { section_heading } : {}),
          ...(expected_sha256 ? { expected_sha256 } : {})
        });
        logEvent("info", "tool_completed", {
          requestId,
          tool: "update_note_draft",
          result: "success",
          paths: [output.path],
          lineDelta: output.diff_summary.line_delta
        });
        return withStructuredContent(output);
      } catch (error) {
        const message = error instanceof Error ? error.message : "update_note_draft failed";
        logEvent(isRefusalError(error) ? "warn" : "error", "tool_completed", {
          requestId,
          tool: "update_note_draft",
          result: isRefusalError(error) ? "refusal" : "error",
          paths: [path],
          error: message
        });
        return toolError(message);
      }
    }
  );

  server.registerTool(
    "propose_change",
    {
      title: "Propose a vault change",
      description: "Applies policy-checked edits in an isolated git worktree, pushes a branch, then opens a GitHub PR.",
      inputSchema: {
        title: z.string(),
        base_branch: z.string().default("main"),
        branch_name: z.string(),
        commit_message: z.string(),
        pr_body: z.string().default("Automated policy-checked change."),
        changes: z
          .array(
            z.object({
              path: z.string(),
              mode: z.enum(["replace_full", "append", "replace_section"]),
              content: z.string(),
              section_heading: z.string().optional(),
              expected_sha256: z.string().optional()
            })
          )
          .min(1)
          .max(20)
      },
      outputSchema: proposeChangeOutputSchema
    },
    async ({ title, base_branch, branch_name, commit_message, pr_body, changes }) => {
      const requestId = randomUUID();
      const changedPaths = changes.map((change) => change.path);
      logEvent("info", "tool_invoked", {
        requestId,
        tool: "propose_change",
        paths: changedPaths,
        branch: branch_name,
        baseBranch: base_branch
      });

      try {
        const output = await vaultService.proposeChange({
          title,
          base_branch,
          branch_name,
          commit_message,
          pr_body,
          changes: changes.map((change) => ({
            path: change.path,
            mode: change.mode,
            content: change.content,
            ...(change.section_heading ? { section_heading: change.section_heading } : {}),
            ...(change.expected_sha256 ? { expected_sha256: change.expected_sha256 } : {})
          }))
        });
        logEvent("info", "tool_completed", {
          requestId,
          tool: "propose_change",
          result: "success",
          paths: output.changed_files,
          branch: output.branch,
          pullRequest: output.pull_request.url
        });
        return withStructuredContent(output);
      } catch (error) {
        const message = error instanceof Error ? error.message : "propose_change failed";
        logEvent(isRefusalError(error) ? "warn" : "error", "tool_completed", {
          requestId,
          tool: "propose_change",
          result: isRefusalError(error) ? "refusal" : "error",
          paths: changedPaths,
          branch: branch_name,
          error: message
        });
        return toolError(message);
      }
    }
  );

  return server;
}

export async function createHttpApp(config: AppConfig) {
  const vaultService = await VaultService.create(config);
  const app = express();

  app.use(express.json({ limit: "1mb" }));

  app.use(config.mcpPath, (request, response, next) => {
    if (!config.mcpAuthToken) {
      next();
      return;
    }

    const authorization = request.header("authorization");
    const expected = `Bearer ${config.mcpAuthToken}`;

    if (authorization !== expected) {
      response.status(401).json({
        error: "Unauthorized"
      });
      return;
    }

    next();
  });

  app.get("/health", (_request, response) => {
    response.json({
      ok: true,
      name: "obsidian-vault",
      version: "0.1.0"
    });
  });

  app.post(config.mcpPath, async (request: Request, response: Response) => {
    const server = createMcpServer(vaultService);
    const transport = new StreamableHTTPServerTransport({});

    try {
      await server.connect(
        transport as unknown as Parameters<typeof server.connect>[0]
      );
      await transport.handleRequest(request, response, request.body);

      response.on("close", () => {
        Promise.resolve(transport.close()).catch(() => undefined);
        Promise.resolve(server.close()).catch(() => undefined);
      });
    } catch (error) {
      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : "Internal server error"
          },
          id: null
        });
      }
    }
  });

  app.get(config.mcpPath, (_request, response) => {
    response.status(405).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed. Use POST with Streamable HTTP."
      },
      id: null
    });
  });

  app.delete(config.mcpPath, (_request, response) => {
    response.status(405).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed. Stateless mode does not expose DELETE."
      },
      id: null
    });
  });

  return app;
}
