import { z } from 'zod';
import type { MookaConfig } from '@mookacode/protocol';

const permission = z.enum(['allow', 'ask', 'deny']);

const modelSchema = z.object({
  id: z.string().min(1),
  providerModelId: z.string().min(1).optional(),
  name: z.string().optional(),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  supportsTools: z.boolean().optional(),
  supportsStreaming: z.boolean().optional(),
  supportsVision: z.boolean().optional(),
  supportsPromptCaching: z.boolean().optional(),
  inputPricePerMillion: z.number().nonnegative().optional(),
  outputPricePerMillion: z.number().nonnegative().optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
});

export const providerSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9_-]+$/),
  name: z.string().min(1),
  type: z.enum(['anthropic', 'openai', 'openai-compatible', 'ollama']),
  baseUrl: z.string().url().optional(),
  apiKeyEnv: z.string().optional(),
  apiKeyRef: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  models: z.array(modelSchema),
  timeoutMs: z.number().int().positive().optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
  defaultModel: z.string().optional(),
  allowLocalNetwork: z.boolean().optional(),
});

const permissionConfigSchema = z.object({
  read: permission,
  edit: permission,
  command: permission,
  network: permission,
  gitWrite: permission,
  mcp: permission,
  commandRules: z.array(
    z.object({
      pattern: z.string().min(1),
      decision: permission,
      reason: z.string().optional(),
    }),
  ),
  toolOverrides: z.record(z.string(), permission),
});

const mcpSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9_-]+$/),
  name: z.string().optional(),
  transport: z.enum(['stdio', 'http', 'sse']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().url().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
  toolAllowlist: z.array(z.string()).optional(),
});

const lspSchema = z.object({
  id: z.string().min(1),
  languages: z.array(z.string()),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  fileExtensions: z.array(z.string()),
  enabled: z.boolean().optional(),
});

export const configSchema = z.object({
  version: z.literal(1),
  defaultProvider: z.string().min(1),
  defaultModel: z.string().min(1),
  mode: z.enum(['plan', 'build', 'debug', 'ask', 'review']),
  preference: z.enum(['quality', 'balanced', 'economy']),
  providers: z.array(providerSchema),
  permissions: permissionConfigSchema,
  mcpServers: z.array(mcpSchema),
  lspServers: z.array(lspSchema),
  agent: z.object({
    maxIterations: z.number().int().min(1).max(200),
    maxToolCalls: z.number().int().min(1).max(1000),
    maxRunMs: z
      .number()
      .int()
      .min(10_000)
      .max(24 * 60 * 60_000),
    maxOutputTokens: z.number().int().min(128).max(200_000),
    temperature: z.number().min(0).max(2),
    duplicateCallLimit: z.number().int().min(1).max(10),
    effort: z.enum(['auto', 'low', 'medium', 'high']).default('auto'),
    autoCheckpoint: z.boolean(),
    verifyAfterEdit: z.boolean(),
  }),
  context: z.object({
    maxInputTokens: z.number().int().min(1024),
    compactAtPercent: z.number().min(30).max(98),
    reserveOutputTokens: z.number().int().min(128),
    memoryMaxEntries: z.number().int().min(1).max(2000),
    includeGitStatus: z.boolean(),
    maxToolResultChars: z.number().int().min(1000).max(500_000),
  }),
  ui: z.object({
    theme: z.enum(['dark', 'light', 'system']),
    accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    fontFamily: z.string().min(1),
    fontSize: z.number().min(9).max(28),
    scale: z.number().min(0.75).max(2),
    sidebarWidth: z.number().int().min(180).max(520),
    rightPanelWidth: z.number().int().min(240).max(800),
    rightPanelOpen: z.boolean(),
    showReasoning: z.boolean(),
  }),
  logging: z.object({
    level: z.enum(['silent', 'error', 'warn', 'info', 'debug']),
    redact: z.boolean(),
  }),
  shell: z.string().optional(),
  ignoreDirectories: z.array(z.string()),
  instructions: z.array(z.string()),
});

export function validateConfig(value: unknown): {
  config: MookaConfig;
  issues: Array<{ path: string; message: string }>;
} {
  const result = configSchema.safeParse(value);
  if (result.success) return { config: result.data as MookaConfig, issues: [] };
  return {
    config: value as MookaConfig,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join('.') || '(root)',
      message: issue.message,
    })),
  };
}
