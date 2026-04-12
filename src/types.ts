export type OpenPrPolicy = "require" | "deny";

export interface PolicyAccess {
  read: boolean;
  write: boolean;
  proposePatch: boolean;
  openPrOrMr: OpenPrPolicy;
  matchedRules: string[];
}

export type ChangeMode = "replace_full" | "append" | "replace_section";

export interface NoteChange {
  path: string;
  mode: ChangeMode;
  content: string;
  section_heading?: string | undefined;
  expected_sha256?: string | undefined;
}

export interface ReadNoteResult extends Record<string, unknown> {
  path: string;
  sha256: string;
  content: string;
  policy: PolicyAccess;
}

export interface SearchResult {
  path: string;
  snippet: string;
  score: number;
}

export interface SearchNotesResult extends Record<string, unknown> {
  results: SearchResult[];
}

export interface DraftDiffSummary {
  changed_sections: string[];
  line_delta: number;
}

export interface UpdateDraftResult extends Record<string, unknown> {
  path: string;
  current_sha256: string;
  draft_sha256: string;
  draft_content: string;
  diff_summary: DraftDiffSummary;
  warnings: string[];
  policy: PolicyAccess;
}

export interface PullRequestInfo {
  number: number;
  url: string;
}

export interface ProposeChangeResult extends Record<string, unknown> {
  branch: string;
  commit_sha: string;
  pull_request: PullRequestInfo;
  changed_files: string[];
}
