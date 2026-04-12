import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import type { AppConfig } from "./config.js";
import { RefusalError, isRefusalError } from "./errors.js";
import { logEvent } from "./logger.js";
import { VaultService } from "./vault-service.js";

const optionalTargetSchema = z.string().optional();

const policySchemaDefinition = {
  read: z.boolean(),
  write: z.boolean(),
  proposePatch: z.boolean(),
  openPrOrMr: z.enum(["require", "deny"]),
  matchedRules: z.array(z.string())
};

const readNoteOutputSchema = {
  target: z.string(),
  path: z.string(),
  sha256: z.string(),
  content: z.string(),
  policy: z.object(policySchemaDefinition)
};

const readSectionOutputSchema = {
  target: z.string(),
  path: z.string(),
  section_heading: z.string(),
  note_sha256: z.string(),
  content: z.string(),
  policy: z.object(policySchemaDefinition)
};

const readNoteExcerptOutputSchema = {
  target: z.string(),
  path: z.string(),
  note_sha256: z.string(),
  summary: z.string(),
  excerpt: z.string(),
  headings: z.array(z.string()),
  policy: z.object(policySchemaDefinition)
};

const searchNotesOutputSchema = {
  target: z.string(),
  results: z.array(
    z.object({
      path: z.string(),
      snippet: z.string(),
      score: z.number()
    })
  )
};

const listNotesOutputSchema = {
  target: z.string(),
  root: z.string(),
  results: z.array(
    z.object({
      path: z.string()
    })
  )
};

const updateDraftOutputSchema = {
  target: z.string(),
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
  target: z.string(),
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

function withJsonTextOnly<T extends Record<string, unknown>>(output: T) {
  return {
    content: [{ type: "text" as const, text: jsonText(output) }]
  };
}

function createTargetResolver(services: Map<string, VaultService>, defaultTarget: string) {
  return (requestedTarget?: string) => {
    const targetName = requestedTarget?.trim() || defaultTarget;
    const service = services.get(targetName);

    if (!service) {
      throw new RefusalError(
        `Unknown target: ${targetName}. Available targets: ${Array.from(services.keys()).sort().join(", ")}`
      );
    }

    return {
      targetName,
      service
    };
  };
}

function createMcpServer(config: AppConfig, services: Map<string, VaultService>) {
  const server = new McpServer({
    name: "obsidian-vault",
    version: "0.1.0"
  });
  const resolveTarget = createTargetResolver(services, config.defaultTarget);

  server.registerTool(
    "read_note",
    {
      title: "Read Obsidian note",
      description: "Reads a note from the vault after policy checks.",
      inputSchema: {
        target: optionalTargetSchema,
        path: z.string()
      },
      outputSchema: readNoteOutputSchema,
      annotations: {
        readOnlyHint: true
      }
    },
    async ({ target, path }) => {
      const requestId = randomUUID();
      logEvent("info", "tool_invoked", {
        requestId,
        tool: "read_note",
        target: target ?? config.defaultTarget,
        paths: [path]
      });

      try {
        const { targetName, service } = resolveTarget(target);
        const output = await service.readNote(path);
        logEvent("info", "tool_completed", {
          requestId,
          tool: "read_note",
          result: "success",
          target: targetName,
          paths: [output.path]
        });
        return withStructuredContent({
          target: targetName,
          ...output
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "read_note failed";
        logEvent(isRefusalError(error) ? "warn" : "error", "tool_completed", {
          requestId,
          tool: "read_note",
          result: isRefusalError(error) ? "refusal" : "error",
          target: target ?? config.defaultTarget,
          paths: [path],
          error: message
        });
        return toolError(message);
      }
    }
  );

  server.registerTool(
    "read_section",
    {
      title: "Read note section",
      description: "Reads a specific markdown section from a note after policy checks.",
      inputSchema: {
        target: optionalTargetSchema,
        path: z.string(),
        section_heading: z.string()
      },
      outputSchema: readSectionOutputSchema,
      annotations: {
        readOnlyHint: true
      }
    },
    async ({ target, path, section_heading }) => {
      const requestId = randomUUID();
      logEvent("info", "tool_invoked", {
        requestId,
        tool: "read_section",
        target: target ?? config.defaultTarget,
        paths: [path],
        sectionHeading: section_heading
      });

      try {
        const { targetName, service } = resolveTarget(target);
        const output = await service.readSection(path, section_heading);
        logEvent("info", "tool_completed", {
          requestId,
          tool: "read_section",
          result: "success",
          target: targetName,
          paths: [output.path],
          sectionHeading: output.section_heading
        });
        return withStructuredContent({
          target: targetName,
          ...output
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "read_section failed";
        logEvent(isRefusalError(error) ? "warn" : "error", "tool_completed", {
          requestId,
          tool: "read_section",
          result: isRefusalError(error) ? "refusal" : "error",
          target: target ?? config.defaultTarget,
          paths: [path],
          sectionHeading: section_heading,
          error: message
        });
        return toolError(message);
      }
    }
  );

  server.registerTool(
    "read_note_excerpt",
    {
      title: "Read note excerpt",
      description: "Reads a compact summary and excerpt from a note after policy checks.",
      inputSchema: {
        target: optionalTargetSchema,
        path: z.string(),
        max_excerpt_chars: z.number().int().min(120).max(4000).default(800),
        max_summary_chars: z.number().int().min(80).max(1000).default(240),
        max_headings: z.number().int().min(0).max(20).default(6)
      },
      outputSchema: readNoteExcerptOutputSchema,
      annotations: {
        readOnlyHint: true
      }
    },
    async ({ target, path, max_excerpt_chars, max_summary_chars, max_headings }) => {
      const requestId = randomUUID();
      logEvent("info", "tool_invoked", {
        requestId,
        tool: "read_note_excerpt",
        target: target ?? config.defaultTarget,
        paths: [path],
        maxExcerptChars: max_excerpt_chars,
        maxSummaryChars: max_summary_chars,
        maxHeadings: max_headings
      });

      try {
        const { targetName, service } = resolveTarget(target);
        const output = await service.readNoteExcerpt(path, {
          maxExcerptChars: max_excerpt_chars,
          maxSummaryChars: max_summary_chars,
          maxHeadings: max_headings
        });
        logEvent("info", "tool_completed", {
          requestId,
          tool: "read_note_excerpt",
          result: "success",
          target: targetName,
          paths: [output.path],
          headings: output.headings.length
        });
        return withStructuredContent({
          target: targetName,
          ...output
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "read_note_excerpt failed";
        logEvent(isRefusalError(error) ? "warn" : "error", "tool_completed", {
          requestId,
          tool: "read_note_excerpt",
          result: isRefusalError(error) ? "refusal" : "error",
          target: target ?? config.defaultTarget,
          paths: [path],
          error: message
        });
        return toolError(message);
      }
    }
  );

  server.registerTool(
    "search",
    {
      title: "Search vault documents",
      description:
        "Searches readable vault documents and returns OpenAI-compatible document search results.",
      inputSchema: {
        query: z.string()
      },
      annotations: {
        readOnlyHint: true
      }
    },
    async ({ query }) => {
      const requestId = randomUUID();
      logEvent("info", "tool_invoked", {
        requestId,
        tool: "search",
        target: config.defaultTarget,
        paths: ["."],
        limit: 10
      });

      try {
        const { targetName, service } = resolveTarget();
        const output = await service.searchOpenAI(query, 10);
        logEvent("info", "tool_completed", {
          requestId,
          tool: "search",
          result: "success",
          target: targetName,
          paths: output.results.map((result) => result.id),
          resultCount: output.results.length
        });
        return withJsonTextOnly(output);
      } catch (error) {
        const message = error instanceof Error ? error.message : "search failed";
        logEvent(isRefusalError(error) ? "warn" : "error", "tool_completed", {
          requestId,
          tool: "search",
          result: isRefusalError(error) ? "refusal" : "error",
          target: config.defaultTarget,
          paths: ["."],
          error: message
        });
        return toolError(message);
      }
    }
  );

  server.registerTool(
    "fetch",
    {
      title: "Fetch vault document",
      description:
        "Fetches the full contents of a readable vault document by id and returns an OpenAI-compatible document payload.",
      inputSchema: {
        id: z.string()
      },
      annotations: {
        readOnlyHint: true
      }
    },
    async ({ id }) => {
      const requestId = randomUUID();
      logEvent("info", "tool_invoked", {
        requestId,
        tool: "fetch",
        target: config.defaultTarget,
        paths: [id]
      });

      try {
        const { targetName, service } = resolveTarget();
        const output = await service.fetchOpenAI(id);
        logEvent("info", "tool_completed", {
          requestId,
          tool: "fetch",
          result: "success",
          target: targetName,
          paths: [output.id]
        });
        return withJsonTextOnly(output);
      } catch (error) {
        const message = error instanceof Error ? error.message : "fetch failed";
        logEvent(isRefusalError(error) ? "warn" : "error", "tool_completed", {
          requestId,
          tool: "fetch",
          result: isRefusalError(error) ? "refusal" : "error",
          target: config.defaultTarget,
          paths: [id],
          error: message
        });
        return toolError(message);
      }
    }
  );

  server.registerTool(
    "list_notes",
    {
      title: "List vault notes",
      description: "Lists readable markdown notes under a root to help navigate the vault.",
      inputSchema: {
        target: optionalTargetSchema,
        root: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(50)
      },
      outputSchema: listNotesOutputSchema,
      annotations: {
        readOnlyHint: true
      }
    },
    async ({ target, root, limit }) => {
      const requestId = randomUUID();
      logEvent("info", "tool_invoked", {
        requestId,
        tool: "list_notes",
        target: target ?? config.defaultTarget,
        paths: [root ?? "."],
        limit
      });

      try {
        const { targetName, service } = resolveTarget(target);
        const output = await service.listNotes(root, limit);
        logEvent("info", "tool_completed", {
          requestId,
          tool: "list_notes",
          result: "success",
          target: targetName,
          paths: [output.root],
          resultCount: output.results.length
        });
        return withStructuredContent({
          target: targetName,
          ...output
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "list_notes failed";
        logEvent(isRefusalError(error) ? "warn" : "error", "tool_completed", {
          requestId,
          tool: "list_notes",
          result: isRefusalError(error) ? "refusal" : "error",
          target: target ?? config.defaultTarget,
          paths: [root ?? "."],
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
        target: optionalTargetSchema,
        query: z.string(),
        roots: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(50).default(10)
      },
      outputSchema: searchNotesOutputSchema,
      annotations: {
        readOnlyHint: true
      }
    },
    async ({ target, query, roots, limit }) => {
      const requestId = randomUUID();
      logEvent("info", "tool_invoked", {
        requestId,
        tool: "search_notes",
        target: target ?? config.defaultTarget,
        paths: roots ?? ["."],
        limit
      });

      try {
        const { targetName, service } = resolveTarget(target);
        const output = await service.searchNotes(query, roots, limit);
        logEvent("info", "tool_completed", {
          requestId,
          tool: "search_notes",
          result: "success",
          target: targetName,
          paths: roots ?? ["."],
          resultCount: output.results.length
        });
        return withStructuredContent({
          target: targetName,
          ...output
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "search_notes failed";
        logEvent(isRefusalError(error) ? "warn" : "error", "tool_completed", {
          requestId,
          tool: "search_notes",
          result: isRefusalError(error) ? "refusal" : "error",
          target: target ?? config.defaultTarget,
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
        target: optionalTargetSchema,
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
    async ({ target, path, mode, content, section_heading, expected_sha256 }) => {
      const requestId = randomUUID();
      logEvent("info", "tool_invoked", {
        requestId,
        tool: "update_note_draft",
        target: target ?? config.defaultTarget,
        paths: [path],
        mode
      });

      try {
        const { targetName, service } = resolveTarget(target);
        const output = await service.updateNoteDraft({
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
          target: targetName,
          paths: [output.path],
          lineDelta: output.diff_summary.line_delta
        });
        return withStructuredContent({
          target: targetName,
          ...output
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "update_note_draft failed";
        logEvent(isRefusalError(error) ? "warn" : "error", "tool_completed", {
          requestId,
          tool: "update_note_draft",
          result: isRefusalError(error) ? "refusal" : "error",
          target: target ?? config.defaultTarget,
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
        target: optionalTargetSchema,
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
    async ({ target, title, base_branch, branch_name, commit_message, pr_body, changes }) => {
      const requestId = randomUUID();
      const changedPaths = changes.map((change) => change.path);
      logEvent("info", "tool_invoked", {
        requestId,
        tool: "propose_change",
        target: target ?? config.defaultTarget,
        paths: changedPaths,
        branch: branch_name,
        baseBranch: base_branch
      });

      try {
        const { targetName, service } = resolveTarget(target);
        const output = await service.proposeChange({
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
          target: targetName,
          paths: output.changed_files,
          branch: output.branch,
          pullRequest: output.pull_request.url
        });
        return withStructuredContent({
          target: targetName,
          ...output
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "propose_change failed";
        logEvent(isRefusalError(error) ? "warn" : "error", "tool_completed", {
          requestId,
          tool: "propose_change",
          result: isRefusalError(error) ? "refusal" : "error",
          target: target ?? config.defaultTarget,
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
  const services = new Map(
    await Promise.all(
      Object.entries(config.targets).map(async ([targetName, targetConfig]) => [
        targetName,
        await VaultService.create(targetConfig)
      ] as const)
    )
  );
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
      version: "0.1.0",
      defaultTarget: config.defaultTarget,
      targets: Object.keys(config.targets).sort()
    });
  });

  app.post(config.mcpPath, async (request: Request, response: Response) => {
    const server = createMcpServer(config, services);
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
