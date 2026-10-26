import type { ToolCall, ToolResult } from '@mookacode/protocol';
import { CancelledError, PermissionDeniedError, errorMessage } from '../util/errors';
import { redactSecrets } from '../util/redact';
import { truncateEnd } from '../util/tokens';
import type { ToolRegistry } from './registry';
import type { ToolContext, ToolExecution } from './types';

function failed(summary: string, content: string): ToolResult {
  return { ok: false, summary, content };
}

export class ToolExecutor {
  private readonly registry: ToolRegistry;

  constructor(registry: ToolRegistry) {
    this.registry = registry;
  }

  async execute(call: ToolCall, ctx: ToolContext): Promise<ToolExecution> {
    const started = Date.now();
    const definition = this.registry.get(call.name);
    if (!definition) {
      const result = failed(`Unknown tool: ${call.name}`, `Tool "${call.name}" is not available in ${ctx.mode} mode.`);
      ctx.emit({ type: 'tool.failed', call, error: result.content, durationMs: 0 });
      return {
        callId: call.id,
        name: call.name,
        input: call.arguments,
        result,
        risk: { level: 'safe', reason: 'unknown tool' },
        durationMs: 0,
      };
    }
    if (!definition.modes.includes(ctx.mode)) {
      const result = failed(
        `${call.name} is not available in ${ctx.mode} mode`,
        `Tool "${call.name}" is blocked in ${ctx.mode} mode. Switch to build or debug mode when you are ready to make changes.`,
      );
      ctx.emit({ type: 'tool.failed', call, error: result.content, durationMs: Date.now() - started });
      return {
        callId: call.id,
        name: call.name,
        input: call.arguments,
        result,
        risk: { level: 'safe', reason: 'mode restriction' },
        durationMs: Date.now() - started,
      };
    }

    const parsed = definition.schema.safeParse(call.arguments);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      const result = failed(`Invalid arguments for ${call.name}`, `Invalid arguments: ${detail}`);
      ctx.emit({ type: 'tool.failed', call, error: result.content, durationMs: Date.now() - started });
      return {
        callId: call.id,
        name: call.name,
        input: call.arguments,
        result,
        risk: definition.risk(call.arguments as never),
        durationMs: Date.now() - started,
      };
    }

    const input = parsed.data;
    const risk = definition.risk(input);
    const category = typeof definition.category === 'function' ? definition.category(input) : definition.category;
    const command = definition.command?.(input);
    const paths = definition.paths?.(input);
    ctx.emit({ type: 'tool.started', call, risk });

    let preview: string | undefined;
    if (definition.preview) {
      try {
        preview = await definition.preview(input, ctx);
      } catch {
        preview = undefined;
      }
    }

    try {
      await ctx.permissions.authorize(
        {
          tool: call.name,
          category,
          mode: ctx.mode,
          risk,
          title: definition.title(input),
          detail: definition.detail(input),
          paths,
          command,
          preview,
        },
        ctx.requestPermission,
      );
    } catch (error) {
      if (error instanceof CancelledError) throw error;
      const result = failed(
        error instanceof PermissionDeniedError ? 'Permission denied' : `Permission check failed: ${call.name}`,
        errorMessage(error),
      );
      ctx.emit({ type: 'tool.failed', call, error: result.content, durationMs: Date.now() - started });
      return {
        callId: call.id,
        name: call.name,
        input: call.arguments,
        result,
        risk,
        durationMs: Date.now() - started,
      };
    }

    try {
      const result = await definition.execute(input, ctx);
      const maxChars = ctx.config.context.maxToolResultChars;
      if (result.content.length > maxChars) {
        result.content = truncateEnd(result.content, maxChars);
        result.metadata = { ...(result.metadata ?? {}), truncated: true };
      }
      if (ctx.config.logging.redact) {
        result.content = redactSecrets(result.content);
        result.summary = redactSecrets(result.summary);
      }
      for (const changed of result.changedFiles ?? []) {
        const existing = ctx.changedFiles.get(changed.path);
        ctx.changedFiles.set(changed.path, {
          ...changed,
          additions: (existing?.additions ?? 0) + (changed.additions ?? 0),
          deletions: (existing?.deletions ?? 0) + (changed.deletions ?? 0),
        });
      }
      const durationMs = Date.now() - started;
      ctx.emit({ type: 'tool.completed', call, result, durationMs });
      return { callId: call.id, name: call.name, input: call.arguments, result, risk, durationMs };
    } catch (error) {
      if (error instanceof CancelledError) throw error;
      const durationMs = Date.now() - started;
      const message = redactSecrets(errorMessage(error));
      const result = failed(`Tool ${call.name} failed`, `Tool "${call.name}" failed: ${message}`);
      ctx.emit({ type: 'tool.failed', call, error: message, durationMs });
      return { callId: call.id, name: call.name, input: call.arguments, result, risk, durationMs };
    }
  }
}
