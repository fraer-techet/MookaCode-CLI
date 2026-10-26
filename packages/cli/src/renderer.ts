import type { AgentEvent, AgentMessage, Effort, ToolCall } from '@mookacode/protocol';
import type { MookaCore } from '@mookacode/core';
import { theme, icons, terminalWidth, truncate, rule } from './theme';
import { formatDuration, formatNumber } from '@mookacode/core';
import { printPet } from './pet';

export interface RendererState {
  provider: string;
  model: string;
  mode: string;
  effort: Effort;
  contextPercent: number;
  inputTokens: number;
  outputTokens: number;
  changedFiles: number;
  sessionId?: string;
  showReasoning: boolean;
}

export class CliRenderer {
  state: RendererState;
  private running = false;
  private spinner?: NodeJS.Timeout;
  private spinnerIndex = 0;
  private spinnerText = 'Working';
  private textOpen = false;
  private hadText = false;
  private toolStart = new Map<string, { name: string; startedAt: number }>();
  private runStarted = 0;

  constructor(core: MookaCore, showReasoning = false) {
    this.state = {
      provider: core.config.defaultProvider,
      model: core.config.defaultModel,
      mode: core.config.mode,
      effort: core.config.agent.effort,
      contextPercent: 0,
      inputTokens: 0,
      outputTokens: 0,
      changedFiles: 0,
      showReasoning,
    };
  }

  update(state: Partial<RendererState>): void {
    Object.assign(this.state, state);
  }

  banner(core: MookaCore): void {
    printPet();
    const effort =
      this.state.effort !== 'auto' ? ` ${theme.gray('·')} ${theme.accent(`effort ${this.state.effort}`)}` : '';
    process.stdout.write(
      ` ${theme.gray(core.root)}\n` +
        ` ${theme.gray(`${this.state.provider}/${this.state.model}`)} ${theme.gray('·')} ${theme.accent(this.state.mode)}${effort}\n` +
        ` ${theme.gray('/help · Ctrl+C interrupt · /quit exit')}\n\n`,
    );
  }

  printPromptStatus(workspace: string): void {
    const effort = this.state.effort !== 'auto' ? ` · effort ${this.state.effort}` : '';
    const context = this.state.contextPercent ? ` · ctx ${this.state.contextPercent}%` : '';
    process.stdout.write(`${theme.gray(` ${workspace}${effort}${context}`)}\n`);
  }

  sessionBanner(sessionId: string, title: string): void {
    process.stdout.write(`${theme.gray('session')} ${theme.accent(sessionId)}  ${theme.dim(truncate(title, 80))}\n`);
  }

  startRun(task: string): void {
    this.running = true;
    this.runStarted = Date.now();
    this.textOpen = false;
    this.hadText = false;
    this.startSpinner(`Thinking${task ? `: ${truncate(task, 50)}` : ''}`);
  }

  stopRun(): void {
    this.running = false;
    this.stopSpinner();
    if (this.textOpen) {
      process.stdout.write('\n');
      this.textOpen = false;
    }
  }

  handle(event: AgentEvent): void {
    switch (event.type) {
      case 'run.started':
        this.state.sessionId = event.sessionId;
        this.state.provider = event.provider;
        this.state.model = event.model;
        this.state.mode = event.mode;
        if (event.effort) this.state.effort = event.effort;
        break;
      case 'assistant.delta':
        this.stopSpinner();
        this.writeDelta(event.delta);
        break;
      case 'assistant.reasoning':
        if (this.state.showReasoning) {
          this.stopSpinner();
          this.writeDelta(theme.gray(event.delta));
        }
        break;
      case 'assistant.completed':
        this.hadText = this.hadText || Boolean(event.message.content.trim());
        if (this.textOpen) {
          process.stdout.write('\n');
          this.textOpen = false;
        }
        break;
      case 'tool.started':
        this.stopSpinner();
        this.endText();
        this.toolStart.set(event.call.id, { name: event.call.name, startedAt: Date.now() });
        process.stdout.write(
          `${icons.bullet} ${theme.cyan(event.call.name)} ${theme.gray(summarizeArgs(event.call))}\n`,
        );
        this.startSpinner(`Running ${event.call.name}`);
        break;
      case 'tool.completed': {
        this.stopSpinner();
        const started = this.toolStart.get(event.call.id)?.startedAt ?? Date.now() - event.durationMs;
        const changed = event.result.changedFiles?.length
          ? ` ${theme.green(`+${event.result.changedFiles.reduce((sum, file) => sum + (file.additions ?? 0), 0)}`)} ${theme.red(`-${event.result.changedFiles.reduce((sum, file) => sum + (file.deletions ?? 0), 0)}`)}`
          : '';
        process.stdout.write(
          `  ${event.result.ok ? icons.ok : icons.error} ${truncate(event.result.summary, Math.max(30, terminalWidth() - 28))} ${theme.gray(`${formatDuration(Date.now() - started)}`)}${changed}\n`,
        );
        if (!event.result.ok) this.printOutput(event.result.content, theme.red);
        this.startSpinner('Thinking');
        break;
      }
      case 'tool.failed':
        this.stopSpinner();
        process.stdout.write(`  ${icons.error} ${theme.red(truncate(event.error, terminalWidth() - 8))}\n`);
        this.startSpinner('Thinking');
        break;
      case 'permission.request':
        this.stopSpinner();
        break;
      case 'permission.resolved':
        break;
      case 'context.compacted':
        process.stdout.write(
          `${icons.info} ${theme.yellow('Context compacted')} ${theme.gray(`${formatNumber(event.beforeTokens)} → ${formatNumber(event.afterTokens)} tokens`)}\n`,
        );
        break;
      case 'usage':
        this.state.contextPercent = event.contextPercent;
        this.state.inputTokens = event.usage.inputTokens;
        this.state.outputTokens = event.usage.outputTokens;
        break;
      case 'notice':
        process.stdout.write(
          `${event.level === 'error' ? icons.error : event.level === 'warn' ? icons.warn : icons.info} ${theme.gray(event.message)}\n`,
        );
        break;
      case 'checkpoint.created':
        process.stdout.write(
          `${icons.ok} ${theme.gray(`Git checkpoint ${event.checkpoint.id} created (${event.checkpoint.label})`)}\n`,
        );
        break;
      case 'plan.created':
        this.stopRun();
        process.stdout.write(
          `\n${theme.accentBold('Plan ready')} ${theme.gray('(not executed; review it, then switch to build mode)')}\n`,
        );
        process.stdout.write(`${event.plan}\n`);
        break;
      case 'run.completed':
        this.stopSpinner();
        this.endText();
        this.state.changedFiles = 0;
        process.stdout.write(
          `${icons.ok} ${theme.green('Done')} ${theme.gray(
            `${formatDuration(Date.now() - this.runStarted)} · ${formatNumber(event.usage.outputTokens)} output tokens · ${formatNumber(event.usage.inputTokens)} input tokens`,
          )}\n`,
        );
        break;
      case 'run.failed':
        this.stopSpinner();
        this.endText();
        process.stdout.write(
          `\n${icons.error} ${theme.red('Task failed')}\n  ${theme.red(event.error)}\n${
            event.recoverable
              ? theme.gray('  The session is saved. Fix the issue and run "mookacode --continue".\n')
              : ''
          }`,
        );
        break;
      case 'run.cancelled':
        this.stopSpinner();
        this.endText();
        process.stdout.write(
          `\n${icons.warn} ${theme.yellow('Interrupted')} ${theme.gray('The session was saved. Use /continue to resume.')}\n`,
        );
        break;
      case 'session.updated':
        this.state.changedFiles = event.meta.changedFiles.length;
        break;
    }
  }

  printPlan(plan: string): void {
    process.stdout.write(`\n${theme.accentBold('Plan')}\n${plan}\n`);
  }

  printMessages(messages: AgentMessage[], limit = 20): void {
    const selected = messages.slice(-limit);
    for (const message of selected) {
      if (message.meta?.hidden) continue;
      const label =
        message.role === 'user'
          ? theme.accentBold('you')
          : message.role === 'assistant'
            ? theme.cyan('mooka')
            : theme.gray(message.toolName ?? 'tool');
      process.stdout.write(`\n${label}\n${truncate(message.content, 4000)}\n`);
      if (message.toolCalls?.length) {
        for (const call of message.toolCalls) {
          process.stdout.write(theme.gray(`  → ${call.name} ${summarizeArgs(call)}\n`));
        }
      }
    }
  }

  private writeDelta(delta: string): void {
    this.hadText = true;
    this.textOpen = true;
    process.stdout.write(delta);
  }

  private endText(): void {
    if (this.textOpen) {
      process.stdout.write('\n');
      this.textOpen = false;
    }
  }

  private printOutput(content: string, color: (value: string) => string): void {
    const lines = content.split('\n').slice(0, 14);
    for (const line of lines) process.stdout.write(color(`    ${truncate(line, terminalWidth() - 6)}\n`));
    if (content.split('\n').length > 14) process.stdout.write(theme.gray('    …\n'));
  }

  startSpinner(text = 'Working'): void {
    if (!theme.enabled || !process.stdout.isTTY || !this.running || this.spinner) return;
    this.spinnerText = text;
    this.spinnerIndex = 0;
    this.spinner = setInterval(() => {
      const frames = ['◐', '◓', '◑', '◒'];
      const frame = frames[this.spinnerIndex++ % frames.length];
      const context = this.state.contextPercent ? ` ${theme.gray(`${this.state.contextPercent}% ctx`)}` : '';
      process.stdout.write(
        `\r${theme.accent(frame ?? '◐')} ${theme.gray(truncate(this.spinnerText, Math.max(20, terminalWidth() - 24)))}${context}\u001b[K`,
      );
    }, 90);
    this.spinner.unref?.();
  }

  stopSpinner(): void {
    if (!this.spinner) return;
    clearInterval(this.spinner);
    this.spinner = undefined;
    process.stdout.write('\r\u001b[K');
  }

  printStatus(extra: string[] = []): void {
    const parts = [
      `${theme.gray('model')} ${theme.accent(this.state.model)}`,
      `${theme.gray('mode')} ${theme.accent(this.state.mode)}`,
      `${theme.gray('ctx')} ${this.state.contextPercent}%`,
      `${theme.gray('tokens')} ${formatNumber(this.state.inputTokens)}/${formatNumber(this.state.outputTokens)}`,
      this.state.changedFiles ? `${theme.gray('files')} ${this.state.changedFiles}` : '',
      ...extra,
    ].filter(Boolean);
    process.stdout.write(`\n${theme.gray('  ')}${parts.join(theme.gray(' · '))}\n`);
  }

  printRule(): void {
    process.stdout.write(`${rule()}\n`);
  }

  get hadAssistantText(): boolean {
    return this.hadText;
  }
}

export function summarizeArgs(call: ToolCall): string {
  const args = call.arguments ?? {};
  const pathValue = typeof args.path === 'string' ? args.path : typeof args.cwd === 'string' ? args.cwd : undefined;
  if (typeof args.command === 'string') return theme.gray(truncate(args.command, 80));
  if (pathValue) return theme.gray(pathValue);
  if (typeof args.query === 'string') return theme.gray(truncate(`"${args.query}"`, 70));
  if (typeof args.agent === 'string' && typeof args.task === 'string')
    return theme.gray(`${args.agent}: ${truncate(args.task, 70)}`);
  const json = JSON.stringify(args);
  if (!json || json === '{}') return '';
  return theme.gray(truncate(json, 80));
}
