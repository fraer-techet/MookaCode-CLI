import type {
  AgentEvent,
  AgentMessage,
  AgentMode,
  AgentRunOptions,
  AgentRunResult,
  ChangedFile,
  MookaConfig,
  PermissionRequest,
  PermissionResponse,
  ProjectProfile,
  SessionRecord,
  ToolCall,
  ToolResult,
  UsageTotals,
} from '@mookacode/protocol';
import type { CredentialStore } from '../auth/store';
import { PREFERENCE_PRESETS } from '../config/defaults';
import { loadInstructions } from '../context/instructions';
import { compactContext } from '../context/manager';
import { MemoryStore } from '../context/memory';
import { buildSystemPrompt, describeContextUsage } from '../context/system-prompt';
import type { GitService } from '../git/service';
import type { LspManager } from '../lsp/manager';
import type { McpManager } from '../mcp/manager';
import { PermissionEngine } from '../permissions/engine';
import { runCompletion } from '../providers/complete';
import type { ProviderManager } from '../providers/manager';
import type { ProviderRuntime } from '../providers/types';
import type { SessionStore } from '../sessions/store';
import { ToolExecutor } from '../tools/executor';
import { ToolRegistry } from '../tools/registry';
import type { AnyToolDefinition, ToolContext } from '../tools/types';
import { CancelledError, MookaError, errorMessage, isAbortError } from '../util/errors';
import { sha256 } from '../util/fs';
import { shortId } from '../util/ids';
import { isWithin } from '../util/paths';
import { redactSecrets } from '../util/redact';
import { estimateTokens } from '../util/tokens';
import type { WorkspaceGuard } from '../workspace/guard';

export interface EngineDependencies {
  config: MookaConfig;
  sessionStore: SessionStore;
  providers: ProviderManager;
  credentials: CredentialStore;
  project: ProjectProfile;
  guard: WorkspaceGuard;
  git: GitService;
  lsp: LspManager;
  mcp: McpManager;
  memory: MemoryStore;
  builtinTools: AnyToolDefinition[];
  subagentRunner?: (
    name: string,
    task: string,
    parent: ToolContext,
  ) => Promise<{ ok: boolean; summary: string; findings: string[]; usage?: import('@mookacode/protocol').Usage }>;
}

export interface EngineRunOptions extends AgentRunOptions {
  emit: (event: AgentEvent) => void;
  requestPermission?: (request: PermissionRequest) => Promise<PermissionResponse>;
}

export class AgentEngine {
  private readonly deps: EngineDependencies;

  constructor(deps: EngineDependencies) {
    this.deps = deps;
  }

  async run(options: EngineRunOptions): Promise<AgentRunResult> {
    const { emit } = options;
    const startedAt = Date.now();
    const preference = options.preference ?? this.deps.config.preference;
    const preset = PREFERENCE_PRESETS[preference];
    const maxIterations = Math.min(options.maxIterations ?? this.deps.config.agent.maxIterations, preset.maxIterations);
    const maxToolCalls = Math.min(this.deps.config.agent.maxToolCalls, preset.maxToolCalls);
    const deadline = startedAt + this.deps.config.agent.maxRunMs;
    const abortController = new AbortController();
    const onAbort = () => abortController.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', onAbort, { once: true });

    let session: SessionRecord | null = null;
    let runtime: ProviderRuntime | null = null;
    let assistantPartial = '';
    const changedFiles = new Map<string, ChangedFile>();
    let toolCallCount = 0;
    let iterations = 0;
    let lastContextTokens = 0;
    let verificationNudged = false;
    let verificationDone = false;

    try {
      runtime = await this.deps.providers.resolve(options.provider || undefined, options.model || undefined);
      session = await this.openSession(options, runtime);
      if (
        session.projectRoot &&
        !isWithin(session.projectRoot, this.deps.project.info.root) &&
        !isWithin(this.deps.project.info.root, session.projectRoot)
      ) {
        throw new MookaError(
          'SESSION_PROJECT_MISMATCH',
          `This session belongs to ${session.projectRoot}. Run MookaCode from that project or start a new session.`,
        );
      }

      const mode = options.mode ?? session.mode ?? this.deps.config.mode;
      const providerId = options.provider ?? session.provider ?? runtime.provider.config.id;
      const modelId = options.model ?? session.model ?? runtime.provider.model.id;
      if (!runtime || runtime.provider.config.id !== providerId || runtime.provider.model.id !== modelId) {
        runtime = await this.deps.providers.resolve(providerId, modelId);
      }
      session.mode = mode;
      session.provider = runtime.provider.config.id;
      session.model = runtime.provider.model.id;
      session.status = 'active';

      const isResume = Boolean(session.pendingTask) && (!options.task || options.task === session.pendingTask);
      if (isResume) {
        session.messages.push({
          id: shortId('msg'),
          role: 'user',
          content:
            'Continue the interrupted task from where it stopped. Inspect the current project state first; do not undo completed work. Reuse existing results and finish the task.',
          createdAt: Date.now(),
          meta: { resume: true },
        });
      } else {
        if (!options.task.trim()) throw new MookaError('EMPTY_TASK', 'Task prompt is empty.');
        await this.deps.sessionStore.appendUserMessage(session, options.task);
      }
      session.pendingTask = options.task || session.pendingTask || 'Continue interrupted task';
      await this.deps.sessionStore.save(session);

      for (const file of session.changedFiles) changedFiles.set(file.path, file);
      emit({
        type: 'run.started',
        sessionId: session.id,
        task: options.task,
        mode,
        model: runtime.provider.model.id,
        provider: runtime.provider.config.id,
        effort: options.effort ?? this.deps.config.agent.effort,
      });
      emit({ type: 'session.updated', meta: this.meta(session) });

      await this.createCheckpoint(session, options.task, mode, emit);

      const instructions = await loadInstructions(this.deps.project.info.root, this.deps.config.instructions);
      const relevantMemory = await this.deps.memory.relevant(options.task, 8);
      const status = await this.deps.git.status().catch(() => null);
      const gitStatus = status
        ? `${status.branch}${
            status.clean
              ? ' (clean)'
              : ` (${status.files.length} changed file(s): ${status.files
                  .slice(0, 12)
                  .map((file) => file.path)
                  .join(', ')})`
          }`
        : 'not available';
      let system = buildSystemPrompt({
        mode,
        config: this.deps.config,
        project: this.deps.project,
        instructions: instructions.text,
        memory: relevantMemory,
        gitStatus,
        toolsEnabled: true,
      });
      if (session.contextSummary) {
        system += `\n\nEARLIER SESSION SUMMARY:\n${session.contextSummary}`;
      }

      await this.deps.mcp.initialize().catch(() => undefined);
      for (const statusItem of this.deps.mcp.statuses()) {
        if (statusItem.error) {
          emit({ type: 'notice', level: 'warn', message: `MCP ${statusItem.name}: ${statusItem.error}` });
        }
      }

      const registry = new ToolRegistry();
      registry.registerMany(this.deps.builtinTools);
      for (const tool of this.deps.mcp.toolDefinitions()) registry.register(tool);

      const permissions = new PermissionEngine(this.deps.config.permissions);
      const model = runtime.provider.model;
      const modelContext = model.contextWindow ?? this.deps.config.context.maxInputTokens;
      const maxInput = Math.min(modelContext, this.deps.config.context.maxInputTokens);
      const effort = options.effort ?? this.deps.config.agent.effort;
      const effortMultiplier = effort === 'low' ? 0.65 : effort === 'high' ? 1.25 : 1;
      const baseOutput = Math.min(
        this.deps.config.agent.maxOutputTokens,
        model.maxOutputTokens ?? this.deps.config.agent.maxOutputTokens,
      );
      const maxOutput = Math.min(
        model.maxOutputTokens ?? baseOutput,
        Math.max(512, Math.round(baseOutput * effortMultiplier)),
      );
      const compactPercent = preset.contextPercent;
      const targetWindow = Math.floor((maxInput * compactPercent) / 100) - maxOutput - Math.floor(maxInput * 0.05);
      const effortGuide =
        effort === 'low'
          ? 'EFFORT low: be decisive and concise. Avoid optional exploration; use the fewest tool calls that complete the task.'
          : effort === 'high'
            ? 'EFFORT high: reason carefully before acting and after tool results. Verify assumptions, consider edge cases and check the final diff more than once.'
            : '';
      if (effortGuide) system += `\n\n${effortGuide}`;

      let finalText = '';
      let done = false;
      let forcedCompaction = false;
      const callSignatures = new Map<string, number>();

      while (!done) {
        if (options.signal?.aborted || abortController.signal.aborted) throw new CancelledError();
        if (Date.now() > deadline) {
          throw new MookaError(
            'RUN_TIMEOUT',
            `Task exceeded the ${Math.round(this.deps.config.agent.maxRunMs / 1000)}s time limit.`,
            {
              retryable: true,
            },
          );
        }
        if (iterations >= maxIterations) {
          throw new MookaError(
            'ITERATION_LIMIT',
            `Stopped after ${iterations} model iterations. Increase agent.maxIterations or narrow the task.`,
            {
              retryable: true,
            },
          );
        }
        if (toolCallCount >= maxToolCalls) {
          throw new MookaError(
            'TOOL_CALL_LIMIT',
            `Stopped after ${toolCallCount} tool calls. Increase agent.maxToolCalls or narrow the task.`,
            {
              retryable: true,
            },
          );
        }

        const toolSpecs = registry.providerTools(mode);
        const systemTokens = estimateTokens(system);
        const toolTokens = estimateTokens(JSON.stringify(toolSpecs));
        const target = Math.max(1200, targetWindow - systemTokens - toolTokens);
        const compacted = compactContext(session.messages, {
          targetTokens: forcedCompaction ? Math.floor(target * 0.6) : target,
          maxToolResultChars: preset.maxToolResultChars,
          previousSummary: session.contextSummary,
          changedFiles: [...changedFiles.keys()],
        });
        if (compacted.compacted) {
          session.contextSummary = compacted.summary;
          emit({
            type: 'context.compacted',
            beforeTokens: compacted.beforeTokens,
            afterTokens: compacted.afterTokens,
            summary: compacted.summary ?? 'Earlier messages compacted.',
          });
          await this.deps.sessionStore.save(session);
        }
        const promptMessages = compacted.messages;
        forcedCompaction = false;

        const request = {
          model,
          system,
          messages: promptMessages,
          tools: toolSpecs,
          temperature: this.deps.config.agent.temperature,
          maxOutputTokens: maxOutput,
          promptCaching: model.supportsPromptCaching !== false,
          effort,
          signal: abortController.signal,
        };
        this.deps.providers.validateCapabilities(runtime, { tools: toolSpecs, streaming: true });

        let completion;
        try {
          completion = await runCompletion(this.deps.providers, runtime, request, {
            onText: (delta) => {
              assistantPartial += delta;
              emit({ type: 'assistant.delta', delta });
            },
            onReasoning: (delta) => emit({ type: 'assistant.reasoning', delta }),
          });
        } catch (error) {
          if (isAbortError(error) || options.signal?.aborted) throw new CancelledError();
          const message = errorMessage(error).toLowerCase();
          if (!compacted.compacted && /context|too long|maximum.*token|prompt.*length/.test(message)) {
            forcedCompaction = true;
            emit({
              type: 'notice',
              level: 'warn',
              message: 'Provider reported a context limit; compacting and retrying once.',
            });
            continue;
          }
          throw error;
        }
        iterations++;

        const usage: UsageTotals = {
          requests: 1,
          inputTokens: completion.usage.inputTokens,
          outputTokens: completion.usage.outputTokens,
          cacheReadTokens: completion.usage.cacheReadTokens,
          cacheWriteTokens: completion.usage.cacheWriteTokens,
          costUsd: completion.usage.costUsd,
        };
        await this.deps.sessionStore.addUsage(session, usage);
        lastContextTokens = completion.usage.inputTokens;
        emit({
          type: 'usage',
          usage: session.usage,
          contextPercent: describeContextUsage({ ...session.usage, inputTokens: lastContextTokens }, modelContext),
        });

        const toolCalls = normalizeToolCalls(completion.toolCalls);
        const assistant: AgentMessage = {
          id: shortId('msg'),
          role: 'assistant',
          content: completion.text,
          reasoning: completion.reasoning || undefined,
          toolCalls: toolCalls.length ? toolCalls : undefined,
          createdAt: Date.now(),
          usage: completion.usage,
        };
        session.messages.push(assistant);
        assistantPartial = '';
        await this.deps.sessionStore.save(session);
        emit({ type: 'assistant.completed', message: assistant });

        if (toolCalls.length === 0) {
          finalText = completion.text.trim();
          if (!finalText && iterations === 1) {
            session.messages.push({
              id: shortId('msg'),
              role: 'user',
              content: 'Continue and complete the task. Return a concrete result, not an empty response.',
              createdAt: Date.now(),
              meta: { hidden: true },
            });
            continue;
          }
          if (
            this.deps.config.agent.verifyAfterEdit &&
            changedFiles.size > 0 &&
            !verificationNudged &&
            !verificationDone &&
            iterations < maxIterations
          ) {
            verificationNudged = true;
            session.messages.push({
              id: shortId('msg'),
              role: 'user',
              content:
                'Verification reminder: you changed files but have not run tests, diagnostics, a typecheck, or a build. Run an appropriate verification step now. If no verification is possible, explain why.',
              createdAt: Date.now(),
              meta: { hidden: true, verificationNudge: true },
            });
            continue;
          }
          if (!finalText) finalText = 'Task finished.';
          done = true;
          break;
        }

        for (const call of toolCalls) {
          if (toolCallCount >= maxToolCalls) {
            throw new MookaError('TOOL_CALL_LIMIT', `Stopped after ${toolCallCount} tool calls.`, { retryable: true });
          }
          toolCallCount++;
          const signature = sha256(`${call.name}:${JSON.stringify(call.arguments)}`);
          const seenCount = callSignatures.get(signature) ?? 0;
          callSignatures.set(signature, seenCount + 1);
          if (seenCount >= this.deps.config.agent.duplicateCallLimit) {
            const blocked: ToolResult = {
              ok: false,
              summary: 'Repeated tool call blocked',
              content: `The identical call ${call.name}(${JSON.stringify(call.arguments)}) was already made ${seenCount} time(s). Reuse the earlier result, change the arguments, or choose a different approach.`,
            };
            session.messages.push({
              id: shortId('msg'),
              role: 'tool',
              content: blocked.content,
              toolCallId: call.id,
              toolName: call.name,
              isError: true,
              createdAt: Date.now(),
              meta: { summary: blocked.summary, repeated: true },
            });
            emit({ type: 'notice', level: 'warn', message: `Blocked repeated tool call: ${call.name}` });
            await this.deps.sessionStore.save(session);
            continue;
          }
          const result = await this.executeToolCall(call, {
            session,
            runtime,
            mode,
            registry,
            permissions,
            changedFiles,
            emit,
            signal: abortController.signal,
            providerId: runtime.provider.config.id,
            modelId: runtime.provider.model.id,
            requestPermission: options.requestPermission,
            subagentRunner: this.deps.subagentRunner,
          });
          if (
            call.name === 'test_runner' ||
            call.name === 'diagnostics' ||
            (call.name === 'run_command' &&
              /\b(test|lint|typecheck|check|build|tsc|cargo|pytest)\b/i.test(String(call.arguments.command ?? '')))
          ) {
            verificationDone = true;
          }
          const subagentUsage = result.metadata?.usage as
            | { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }
            | undefined;
          if (call.name === 'subagent' && subagentUsage) {
            await this.deps.sessionStore.addUsage(session, {
              requests: 1,
              inputTokens: subagentUsage.inputTokens ?? 0,
              outputTokens: subagentUsage.outputTokens ?? 0,
              cacheReadTokens: subagentUsage.cacheReadTokens ?? 0,
              cacheWriteTokens: subagentUsage.cacheWriteTokens ?? 0,
            });
          }
          session.messages.push({
            id: shortId('msg'),
            role: 'tool',
            content: result.content,
            toolCallId: call.id,
            toolName: call.name,
            isError: !result.ok,
            createdAt: Date.now(),
            meta: { summary: result.summary, ...(result.metadata ?? {}) },
          });
          await this.deps.sessionStore.save(session);
          emit({ type: 'session.updated', meta: this.meta(session) });
        }
      }

      finalText = finalText.trim() || 'Task finished.';
      session.changedFiles = [...changedFiles.values()];
      session.summary = redactSecrets(finalText).slice(0, 4000);
      session.plan = mode === 'plan' ? finalText : session.plan;
      session.status = mode === 'plan' ? 'plan' : 'completed';
      session.pendingTask = undefined;
      await this.deps.sessionStore.save(session);
      await this.deps.memory
        .add({
          kind: 'session-summary',
          text: `${session.title}: ${finalText.replace(/\s+/g, ' ').slice(0, 700)}${
            changedFiles.size ? ` Files: ${[...changedFiles.keys()].slice(0, 20).join(', ')}.` : ''
          }`,
          files: [...changedFiles.keys()],
          sessionId: session.id,
        })
        .catch(() => undefined);

      if (mode === 'plan') emit({ type: 'plan.created', plan: finalText });
      emit({ type: 'session.updated', meta: this.meta(session) });
      emit({
        type: 'run.completed',
        sessionId: session.id,
        summary: finalText,
        usage: session.usage,
      });
      return {
        sessionId: session.id,
        status: mode === 'plan' ? 'plan' : 'completed',
        finalText,
        usage: session.usage,
        changedFiles: [...changedFiles.values()],
        plan: mode === 'plan' ? finalText : undefined,
      };
    } catch (error) {
      if (!session) {
        emit({
          type: 'run.failed',
          sessionId: 'unknown',
          error: redactSecrets(errorMessage(error)),
          recoverable: false,
        });
        throw error;
      }
      if (error instanceof CancelledError || isAbortError(error) || options.signal?.aborted) {
        session.status = 'interrupted';
        session.pendingTask = options.task || session.pendingTask;
        this.completeOpenToolCalls(session, 'The task was cancelled before this tool returned.');
        await this.deps.sessionStore.save(session).catch(() => undefined);
        emit({ type: 'run.cancelled', sessionId: session.id });
        return {
          sessionId: session.id,
          status: 'cancelled',
          finalText: assistantPartial,
          usage: session.usage,
          changedFiles: [...changedFiles.values()],
        };
      }
      session.status = 'interrupted';
      session.pendingTask = options.task || session.pendingTask;
      this.completeOpenToolCalls(session, `The task failed before this tool returned: ${errorMessage(error)}`);
      session.summary = redactSecrets(errorMessage(error)).slice(0, 2000);
      await this.deps.sessionStore.save(session).catch(() => undefined);
      const recoverable = error instanceof MookaError ? error.retryable || error.code === 'AUTH_FAILED' : false;
      emit({ type: 'run.failed', sessionId: session.id, error: redactSecrets(errorMessage(error)), recoverable });
      return {
        sessionId: session.id,
        status: 'failed',
        finalText: assistantPartial,
        usage: session.usage,
        changedFiles: [...changedFiles.values()],
      };
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  private async openSession(options: EngineRunOptions, runtime: ProviderRuntime): Promise<SessionRecord> {
    let session: SessionRecord | null = null;
    if (options.sessionId) session = await this.deps.sessionStore.get(options.sessionId);
    else if (options.continueSession) session = await this.deps.sessionStore.latest(this.deps.project.info.root);
    if (!session) {
      session = await this.deps.sessionStore.create({
        cwd: this.deps.project.info.root,
        projectRoot: this.deps.project.info.root,
        mode: options.mode ?? this.deps.config.mode,
        provider: options.provider ?? runtime.provider.config.id,
        model: options.model ?? runtime.provider.model.id,
      });
    }
    return session;
  }

  private async createCheckpoint(
    session: SessionRecord,
    task: string,
    mode: AgentMode,
    emit: (event: AgentEvent) => void,
  ): Promise<void> {
    if (!this.deps.config.agent.autoCheckpoint || (mode !== 'build' && mode !== 'debug')) return;
    if (!(await this.deps.git.isRepository().catch(() => false))) return;
    try {
      const checkpoint = await this.deps.git.createCheckpoint(task.slice(0, 80) || 'before task');
      if (!checkpoint) return;
      session.checkpoints.push(checkpoint);
      await this.deps.sessionStore.save(session);
      emit({ type: 'checkpoint.created', checkpoint });
    } catch (error) {
      emit({ type: 'notice', level: 'warn', message: `Could not create a Git checkpoint: ${errorMessage(error)}` });
    }
  }

  private async executeToolCall(
    call: ToolCall,
    context: {
      session: SessionRecord;
      runtime: ProviderRuntime;
      mode: AgentMode;
      registry: ToolRegistry;
      permissions: PermissionEngine;
      changedFiles: Map<string, ChangedFile>;
      emit: (event: AgentEvent) => void;
      signal?: AbortSignal;
      providerId?: string;
      modelId?: string;
      requestPermission?: (request: PermissionRequest) => Promise<PermissionResponse>;
      subagentRunner?: EngineDependencies['subagentRunner'];
    },
  ): Promise<ToolResult> {
    const toolContext: ToolContext = {
      cwd: this.deps.project.info.root,
      root: this.deps.project.info.root,
      config: this.deps.config,
      project: this.deps.project,
      guard: this.deps.guard,
      git: this.deps.git,
      permissions: context.permissions,
      lsp: this.deps.lsp,
      mcp: this.deps.mcp,
      mode: context.mode,
      sessionId: context.session.id,
      providerId: context.providerId,
      modelId: context.modelId,
      signal: context.signal,
      changedFiles: context.changedFiles,
      requestPermission: context.requestPermission,
      emit: context.emit,
    };
    if (context.subagentRunner) {
      toolContext.runSubagent = (name, task) => context.subagentRunner!(name, task, toolContext);
    }
    const executor = new ToolExecutor(context.registry);
    const execution = await executor.execute(call, toolContext);
    return execution.result;
  }

  private completeOpenToolCalls(session: SessionRecord, message: string): void {
    const answered = new Set(session.messages.filter((item) => item.role === 'tool').map((item) => item.toolCallId));
    for (const item of session.messages) {
      if (item.role !== 'assistant' || !item.toolCalls) continue;
      for (const call of item.toolCalls) {
        if (answered.has(call.id)) continue;
        session.messages.push({
          id: shortId('msg'),
          role: 'tool',
          content: message,
          toolCallId: call.id,
          toolName: call.name,
          isError: true,
          createdAt: Date.now(),
          meta: { synthetic: true },
        });
      }
    }
  }

  private meta(session: SessionRecord) {
    return {
      id: session.id,
      title: session.title,
      cwd: session.cwd,
      projectRoot: session.projectRoot,
      createdAt: session.createdAt,
      updatedAt: Date.now(),
      mode: session.mode,
      provider: session.provider,
      model: session.model,
      status: session.status,
      summary: session.summary,
      usage: session.usage,
      messageCount: session.messages.length,
      changedFiles: session.changedFiles,
      archived: session.archived,
      parentId: session.parentId,
      plan: session.plan,
    };
  }
}

function normalizeToolCalls(calls: ToolCall[]): ToolCall[] {
  const seen = new Set<string>();
  return calls.map((call) => {
    let id = call.id;
    if (!id || seen.has(id)) id = shortId('call');
    seen.add(id);
    let args = call.arguments;
    if (
      (!args || Object.keys(args).length === 0) &&
      call.rawArguments &&
      call.rawArguments.trim() &&
      call.rawArguments.trim() !== '{}'
    ) {
      try {
        const parsed = JSON.parse(call.rawArguments) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
      } catch {
        // leave invalid arguments: schema validation will fail with a useful message
      }
    }
    return { ...call, id, arguments: args ?? {} };
  });
}
