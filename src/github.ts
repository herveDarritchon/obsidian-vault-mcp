import type { PullRequestInfo } from "./types.js";

interface GitHubClientOptions {
  apiBaseUrl: string;
  owner: string;
  repo: string;
  token: string;
}

interface PullRequestPayload {
  title: string;
  body: string;
  head: string;
  base: string;
  draft?: boolean;
}

interface GitHubPullResponse {
  number: number;
  html_url: string;
}

export class GitHubClient {
  constructor(private readonly options: GitHubClientOptions) {}

  async findOpenPullRequest(headBranch: string, baseBranch: string): Promise<PullRequestInfo | null> {
    const search = new URLSearchParams({
      state: "open",
      head: `${this.options.owner}:${headBranch}`,
      base: baseBranch
    });

    const response = await fetch(
      `${this.options.apiBaseUrl}/repos/${this.options.owner}/${this.options.repo}/pulls?${search.toString()}`,
      {
        headers: this.headers()
      }
    );

    if (!response.ok) {
      throw new Error(`GitHub pull request lookup failed: ${response.status} ${await response.text()}`);
    }

    const payload = (await response.json()) as GitHubPullResponse[];
    const pullRequest = payload[0];

    if (!pullRequest) {
      return null;
    }

    return {
      number: pullRequest.number,
      url: pullRequest.html_url
    };
  }

  async createPullRequest(payload: PullRequestPayload): Promise<PullRequestInfo> {
    const existing = await this.findOpenPullRequest(payload.head, payload.base);

    if (existing) {
      return existing;
    }

    const response = await fetch(
      `${this.options.apiBaseUrl}/repos/${this.options.owner}/${this.options.repo}/pulls`,
      {
        method: "POST",
        headers: {
          ...this.headers(),
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      }
    );

    if (!response.ok) {
      const body = await response.text();

      if (response.status === 422) {
        const openPullRequest = await this.findOpenPullRequest(payload.head, payload.base);

        if (openPullRequest) {
          return openPullRequest;
        }
      }

      throw new Error(`GitHub pull request creation failed: ${response.status} ${body}`);
    }

    const result = (await response.json()) as GitHubPullResponse;
    return {
      number: result.number,
      url: result.html_url
    };
  }

  private headers(): Record<string, string> {
    return {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${this.options.token}`,
      "User-Agent": "obsidian-vault-mcp"
    };
  }
}
