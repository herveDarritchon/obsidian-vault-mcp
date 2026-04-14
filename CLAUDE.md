# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**obsidian-vault-mcp** is a remote Model Context Protocol (MCP) server that provides secure, policy-checked access to an Obsidian markdown vault via HTTP. AI assistants connect to the `/mcp` endpoint and use registered tools to read, draft, and propose changes to notes — all gated by a YAML-based access-control policy.

## Commands

```bash
npm run dev          # Start development server with auto-reload (tsx watch)
npm run build        # Compile TypeScript to dist/
npm start            # Run production build
npm run typecheck    # Type-check without emitting
npm test             # Run unit tests (Node built-in test runner)
npm run test:e2e:real  # Full end-to-end test harness (requires .env.e2e)
```

To run a single test file:
```bash
node --import tsx --test test/policy.test.ts
```

## Architecture

### Request Flow

```
HTTP POST /mcp
  → Express server (app.ts)
  → MCP SDK StreamableHTTPServerTransport
  → McpServer routes to registered tool handler
  → VaultService method (vault-service.ts)
  → VaultPolicyEngine checks access (policy.ts)
  → File I/O / Git worktree / GitHub API
  → JSON response
```

### Key Modules

| File | Responsibility |
|------|---------------|
| `src/index.ts` | Bootstrap: load env, config, start HTTP server |
| `src/app.ts` | Express app, MCP tool registration (12 tools), Zod schemas |
| `src/config.ts` | Config loading & validation; 3 modes (single, multi-target, manifest) |
| `src/vault-service.ts` | All vault operations; git worktree management |
| `src/policy.ts` | Path-based access control (deny / propose_only / write_via_pr) |
| `src/markdown.ts` | Frontmatter parsing, section extraction, diffs, excerpts |
| `src/github.ts` | GitHub API client (PR create/reuse) |
| `src/lib/paths.ts` | Path normalization and vault-root boundary enforcement |
| `src/types.ts` | All TypeScript interfaces for tool I/O |

### The 12 MCP Tools

**Read (7):** `search`, `fetch`, `read_note`, `read_note_excerpt`, `read_section`, `list_notes`, `search_notes`

**Draft (1):** `update_note_draft` — computes a what-if diff without writing anything

**Write via PR (4):** `propose_change`, `rename_note`, `move_note`, `create_folder` — all create a git branch, commit, push, and open/reuse a GitHub PR

### Write Operation Flow

1. Policy check on all paths
2. Create temporary git worktree from `base_branch`
3. Checkout new branch (`ai/scope/slug` format)
4. Apply changes
5. Commit + push to origin
6. Create or reuse open PR on GitHub
7. Clean up worktree
8. Return branch, commit SHA, PR URL

## Configuration

Three mutually exclusive config modes (set via environment variables):

1. **Single-target**: `VAULT_REPO_ROOT` + `VAULT_POLICY_FILE` + `GITHUB_OWNER` + `GITHUB_REPO`
2. **Multi-target catalog**: `VAULT_TARGETS_FILE` + `VAULT_TARGET`
3. **Manifest-based**: `VAULT_TARGET_MANIFEST_FILE` pointing to `.config/mcp/vault-target.yaml` inside the vault

Copy `.env.example` to `.env` and fill in values. Copy `config/vault-access-policy.example.yaml` as a policy template.

### Policy File Format

```yaml
version: 1
defaults:
  read: false
rules:
  - name: deny-secrets
    effect: deny       # absolute — cannot be overridden
    paths: ["Private/**"]
  - name: knowledge-read
    effect: propose_only   # read + draft
    paths: ["03-Knowledge/**"]
  - name: work-write
    effect: write_via_pr   # read + draft + write
    paths: ["02-Work/**"]
```

- Path globs use `minimatch` with `dot: true`
- `deny` rules are checked first; among permissive rules, **last match wins**

## Key Design Patterns

- **SHA256 freshness guard**: Write tools accept `expected_sha256` to prevent stale overwrites. Compute from current `read_note` response.
- **Idempotent PRs**: `GitHubClient.createPullRequest()` reuses an existing open PR for the same branch.
- **Path safety**: `resolveVaultPath()` in `lib/paths.ts` rejects any path that escapes `VAULT_REPO_ROOT`.
- **RefusalError**: Thrown for policy violations; caught in `app.ts` to return a structured error response.
- **Worktree isolation**: All git mutations happen in a temp-dir worktree, never in the checked-out repo.

## Testing

- Unit tests use Node's built-in `node:test` + `assert` — no test framework dependency.
- E2E test (`scripts/e2e-real.ts`) requires a `.env.e2e` file (see `.env.e2e.example`) and a real vault + GitHub repo.
- E2E covers the full pipeline: search → read → draft → propose change → policy rejection → stale hash rejection.
