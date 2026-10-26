import type { z } from 'zod';
import type {
  AgentEvent,
  AgentMode,
  ChangedFile,
  MookaConfig,
  ProjectProfile,
  ToolResult,
  ToolRisk,
} from '@mookacode/protocol';
import type { GitService } from '../git/service';
import type { PermissionCategory, PermissionEngine } from '../permissions/engine';
import type { WorkspaceGuard } from '../workspace/guard';
import type { LspManager } from '../lsp/manager';
import type { McpManager } from '../mcp/manager';

export interface ToolContext {
  cwd: string;
  root: string;
  config: MookaConfig;
  project: ProjectProfile;
  guard: WorkspaceGuard;
  git: GitService;
  permissions: PermissionEngine;
  lsp: LspManager;
  mcp: McpManager;
  mode: AgentMode;
  sessionId: string;
  providerId?: string;
  modelId?: string;
  signal?: AbortSignal;
  changedFiles: Map<string, ChangedFile>;
  requestPermission?: Parameters<PermissionEngine['authorize']>[1];
  emit: (event: AgentEvent) => void;
  runSubagent?: (
    name: string,
    task: string,
  ) => Promise<{ ok: boolean; summary: string; findings: string[]; usage?: import('@mookacode/protocol').Usage }>;
}

export interface ToolDefinition<Schema extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  category: PermissionCategory | ((input: z.output<Schema>) => PermissionCategory);
  modes: AgentMode[];
  schema: Schema;
  parameters?: Record<string, unknown>;
  risk: (input: z.output<Schema>) => ToolRisk;
  title: (input: z.output<Schema>) => string;
  detail: (input: z.output<Schema>) => string;
  paths?: (input: z.output<Schema>) => string[];
  command?: (input: z.output<Schema>) => string | undefined;
  preview?: (input: z.output<Schema>, ctx: ToolContext) => Promise<string | undefined>;
  execute: (input: z.output<Schema>, ctx: ToolContext) => Promise<ToolResult>;
}

export type AnyToolDefinition = ToolDefinition<z.ZodType>;

export function defineTool<Schema extends z.ZodType>(tool: ToolDefinition<Schema>): ToolDefinition<Schema> {
  return tool;
}

export interface ToolExecution {
  callId: string;
  name: string;
  input: Record<string, unknown>;
  result: ToolResult;
  risk: ToolRisk;
  durationMs: number;
}

export const READ_MODES: AgentMode[] = ['plan', 'build', 'debug', 'ask', 'review'];
export const WRITE_MODES: AgentMode[] = ['build', 'debug'];

export function safeRisk(reason: string): ToolRisk {
  return { level: 'safe', reason };
}

export function moderateRisk(reason: string): ToolRisk {
  return { level: 'moderate', reason };
}

export function highRisk(reason: string): ToolRisk {
  return { level: 'high', reason };
}
