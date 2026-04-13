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
  id: string;
  title: string;
  path: string;
  url: string;
  sha256: string;
  content: string;
  policy: PolicyAccess;
}

export interface ReadSectionResult extends Record<string, unknown> {
  id: string;
  title: string;
  path: string;
  url: string;
  section_heading: string;
  note_sha256: string;
  content: string;
  policy: PolicyAccess;
}

export interface ReadNoteExcerptResult extends Record<string, unknown> {
  id: string;
  title: string;
  path: string;
  url: string;
  note_sha256: string;
  summary: string;
  excerpt: string;
  headings: string[];
  policy: PolicyAccess;
}

export interface SearchResult {
  id: string;
  title: string;
  path: string;
  url: string;
  snippet: string;
  score: number;
}

export interface SearchNotesResult extends Record<string, unknown> {
  results: SearchResult[];
}

export interface OpenAISearchResult {
  id: string;
  title: string;
  path: string;
  url: string;
  text: string;
}

export interface OpenAISearchResultSet extends Record<string, unknown> {
  results: OpenAISearchResult[];
}

export interface OpenAIFetchResult extends Record<string, unknown> {
  id: string;
  title: string;
  path: string;
  content: string;
  text: string;
  url: string;
  metadata: Record<string, unknown>;
}

export interface ListNotesItem {
  id: string;
  title: string;
  path: string;
  url: string;
}

export interface ListNotesResult extends Record<string, unknown> {
  root: string;
  results: ListNotesItem[];
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

export interface MoveNoteResult extends Record<string, unknown> {
  id: string;
  title: string;
  previous_path: string;
  path: string;
  url: string;
  sha256: string;
  branch: string;
  commit_sha: string;
  pull_request: PullRequestInfo;
}

export type RenameNoteResult = MoveNoteResult;

export interface CreateFolderResult extends Record<string, unknown> {
  path: string;
  placeholder_path: string;
  url: string;
  branch: string;
  commit_sha: string;
  pull_request: PullRequestInfo;
}
