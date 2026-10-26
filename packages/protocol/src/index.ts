export type AgentMode = 'plan' | 'build' | 'debug' | 'ask' | 'review';
export type PermissionDecision = 'allow' | 'ask' | 'deny';
export type Preference = 'quality' | 'balanced' | 'economy';
/** Reasoning/effort preset. uto leaves provider defaults untouched. */
export type Effort = 'auto' | 'low' | 'medium' | 'high';
export type ThemeMode = 'dark' | 'light' | 'system';
export type ProviderType = 'anthropic' | 'openai' | 'openai-compatible' | 'ollama';

export const AGENT_MODES: AgentMode[] = ['plan', 'build', 'debug', 'ask', 'review'];

export interface ModelConfig {
  id: string;
  providerModelId?: string;
  name?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsTools?: boolean;
  supportsStreaming?: boolean;
  supportsVision?: boolean;
  supportsPromptCaching?: boolean;
  inputPricePerMillion?: number;
  outputPricePerMillion?: number;
  extra?: Record<string, unknown>;
}

export interface ProviderConfig {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl?: string;
  apiKeyEnv?: string;
  apiKeyRef?: string;
  headers?: Record<string, string>;
  models: ModelConfig[];
  timeoutMs?: number;
  maxRetries?: number;
  defaultModel?: string;
  allowLocalNetwork?: boolean;
}

export interface CommandRule {
  pattern: string;
  decision: PermissionDecision;
  reason?: string;
}

export interface PermissionConfig {
  read: PermissionDecision;
  edit: PermissionDecision;
  command: PermissionDecision;
  network: PermissionDecision;
  gitWrite: PermissionDecision;
  mcp: PermissionDecision;
  commandRules: CommandRule[];
  toolOverrides: Record<string, PermissionDecision>;
}

export interface McpServerConfig {
  id: string;
  name?: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  timeoutMs?: number;
  toolAllowlist?: string[];
}

export interface LspServerConfig {
  id: string;
  languages: string[];
  command: string;
  args?: string[];
  fileExtensions: string[];
  enabled?: boolean;
}

export interface AgentConfig {
  maxIterations: number;
  maxToolCalls: number;
  maxRunMs: number;
  maxOutputTokens: number;
  temperature: number;
  duplicateCallLimit: number;
  effort: Effort;
  autoCheckpoint: boolean;
  verifyAfterEdit: boolean;
}

export interface ContextConfig {
  maxInputTokens: number;
  compactAtPercent: number;
  reserveOutputTokens: number;
  memoryMaxEntries: number;
  includeGitStatus: boolean;
  maxToolResultChars: number;
}

export interface UiConfig {
  theme: ThemeMode;
  accent: string;
  fontFamily: string;
  fontSize: number;
  scale: number;
  sidebarWidth: number;
  rightPanelWidth: number;
  rightPanelOpen: boolean;
  showReasoning: boolean;
}

export interface LoggingConfig {
  level: 'silent' | 'error' | 'warn' | 'info' | 'debug';
  redact: boolean;
}

export interface MookaConfig {
  version: 1;
  defaultProvider: string;
  defaultModel: string;
  mode: AgentMode;
  preference: Preference;
  providers: ProviderConfig[];
  permissions: PermissionConfig;
  mcpServers: McpServerConfig[];
  lspServers: LspServerConfig[];
  agent: AgentConfig;
  context: ContextConfig;
  ui: UiConfig;
  logging: LoggingConfig;
  shell?: string;
  ignoreDirectories: string[];
  instructions: string[];
}

export interface ProviderModelView extends ModelConfig {
  providerId: string;
  providerName: string;
  providerType: ProviderType;
  configured: boolean;
  keySource: 'env' | 'store' | 'none';
  default: boolean;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd?: number;
}

export interface UsageTotals extends Usage {
  requests: number;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  rawArguments?: string;
}

export interface AgentMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  createdAt: number;
  usage?: Usage;
  reasoning?: string;
  isError?: boolean;
  meta?: Record<string, unknown>;
}

export type SessionStatus = 'active' | 'completed' | 'interrupted' | 'failed' | 'plan' | 'archived';

export interface ChangedFile {
  path: string;
  kind: 'modified' | 'created' | 'deleted' | 'renamed';
  additions?: number;
  deletions?: number;
}

export interface Checkpoint {
  id: string;
  label: string;
  ref: string;
  createdAt: number;
  head: string;
}

export interface SessionMeta {
  id: string;
  title: string;
  cwd: string;
  projectRoot: string;
  createdAt: number;
  updatedAt: number;
  mode: AgentMode;
  provider: string;
  model: string;
  status: SessionStatus;
  summary?: string;
  usage: UsageTotals;
  messageCount: number;
  changedFiles: ChangedFile[];
  archived?: boolean;
  parentId?: string;
  plan?: string;
}

export interface SessionRecord extends SessionMeta {
  messages: AgentMessage[];
  checkpoints: Checkpoint[];
  pendingTask?: string;
  contextSummary?: string;
  modelNotes?: string;
}

export interface ProjectInfo {
  root: string;
  name: string;
  isGit: boolean;
  branch?: string;
  projectTypes: string[];
  languages: string[];
  packageManager?: string;
  instructions: string[];
  memoryFile?: string;
  heavyDirectories: string[];
  fileCountSample: number;
}

export interface ProjectProfile {
  info: ProjectInfo;
  topLevel: string[];
  manifests: string[];
  scripts: Record<string, string>;
  gitStatus?: string;
}

export interface DiffStat {
  files: number;
  additions: number;
  deletions: number;
}

export interface ToolResult {
  ok: boolean;
  summary: string;
  content: string;
  metadata?: Record<string, unknown>;
  changedFiles?: ChangedFile[];
}

export interface ToolRisk {
  level: 'safe' | 'moderate' | 'high';
  reason: string;
}

export interface PermissionRequest {
  id: string;
  tool: string;
  category: keyof Omit<PermissionConfig, 'commandRules' | 'toolOverrides'> | 'mcp';
  decision: PermissionDecision;
  risk: ToolRisk;
  title: string;
  detail: string;
  paths?: string[];
  command?: string;
  preview?: string;
}

export interface PermissionResponse {
  id: string;
  approved: boolean;
  alwaysAllow?: boolean;
  rememberTool?: boolean;
  reason?: string;
}

export interface SubagentResult {
  agent: string;
  ok: boolean;
  summary: string;
  findings: string[];
  changedFiles: string[];
  usage?: Usage;
}

export type ProviderStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool_call_start'; id: string; name: string; index: number }
  | { type: 'tool_call_delta'; id: string; index: number; argumentsDelta: string }
  | {
      type: 'tool_call_end';
      id: string;
      index: number;
      name: string;
      arguments: Record<string, unknown>;
      rawArguments: string;
    }
  | { type: 'usage'; usage: Usage }
  | { type: 'done'; stopReason: string }
  | { type: 'error'; message: string; retryable?: boolean };

export type AgentEvent =
  | {
      type: 'run.started';
      sessionId: string;
      task: string;
      mode: AgentMode;
      model: string;
      provider: string;
      effort?: Effort;
    }
  | { type: 'assistant.delta'; delta: string }
  | { type: 'assistant.reasoning'; delta: string }
  | { type: 'assistant.completed'; message: AgentMessage }
  | { type: 'tool.started'; call: ToolCall; risk: ToolRisk }
  | { type: 'tool.completed'; call: ToolCall; result: ToolResult; durationMs: number }
  | { type: 'tool.failed'; call: ToolCall; error: string; durationMs: number }
  | { type: 'permission.request'; request: PermissionRequest }
  | { type: 'permission.resolved'; id: string; approved: boolean }
  | { type: 'context.compacted'; beforeTokens: number; afterTokens: number; summary: string }
  | { type: 'usage'; usage: UsageTotals; contextPercent: number }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'plan.created'; plan: string }
  | { type: 'checkpoint.created'; checkpoint: Checkpoint }
  | { type: 'session.updated'; meta: SessionMeta }
  | { type: 'run.completed'; sessionId: string; summary: string; usage: UsageTotals }
  | { type: 'run.failed'; sessionId: string; error: string; recoverable: boolean }
  | { type: 'run.cancelled'; sessionId: string };

export interface AgentRunOptions {
  task: string;
  mode?: AgentMode;
  provider?: string;
  model?: string;
  sessionId?: string;
  continueSession?: boolean;
  signal?: AbortSignal;
  preference?: Preference;
  effort?: Effort;
  maxIterations?: number;
}

export interface AgentRunResult {
  sessionId: string;
  status: 'completed' | 'failed' | 'cancelled' | 'plan';
  finalText: string;
  usage: UsageTotals;
  changedFiles: ChangedFile[];
  plan?: string;
}

export interface SessionSearch {
  query?: string;
  cwd?: string;
  status?: SessionStatus;
  limit?: number;
  includeArchived?: boolean;
}

export interface DiagnosticsSummary {
  file: string;
  errors: number;
  warnings: number;
  messages: Array<{
    severity: 'error' | 'warning' | 'info' | 'hint';
    line: number;
    column: number;
    message: string;
    source?: string;
  }>;
}

export interface ConfigValidationIssue {
  path: string;
  message: string;
}

export interface ConfigSnapshot {
  config: MookaConfig;
  globalPath: string;
  projectPath?: string;
  projectTrusted: boolean;
  hasProjectConfig: boolean;
  issues: ConfigValidationIssue[];
}
