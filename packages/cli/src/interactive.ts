import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentMode, AgentEvent, Effort, SessionRecord } from '@mookacode/protocol';
import { MookaCore, CancelledError, errorMessage, formatNumber, truncateMiddle } from '@mookacode/core';
import { PromptSession, clearScreen, shortPath } from './prompt';
import { CliRenderer } from './renderer';
import { printPet } from './pet';

const EFFORTS: Effort[] = ['auto', 'low', 'medium', 'high'];
import { theme, icons, terminalWidth, truncate, rule } from './theme';

export interface InteractiveOptions {
  provider?: string;
  model?: string;
  mode?: AgentMode;
  effort?: Effort;
  sessionId?: string;
  continueSession?: boolean;
  showReasoning?: boolean;
  maxIterations?: number;
}

export class InteractiveCli {
  private readonly core: MookaCore;
  private readonly prompt: PromptSession;
  private readonly renderer: CliRenderer;
  private provider?: string;
  private model?: string;
  private mode?: AgentMode;
  private effort?: Effort;
  private sessionId?: string;
  private abortController?: AbortController;
  private exiting = false;
  private lastSigint = 0;
  private session: SessionRecord | null = null;
  private readonly continueSession: boolean;
  private readonly maxIterations?: number;

  constructor(core: MookaCore, options: InteractiveOptions) {
    this.core = core;
    this.provider = options.provider;
    this.model = options.model;
    this.mode = options.mode;
    this.effort = options.effort;
    this.sessionId = options.sessionId;
    this.continueSession = Boolean(options.continueSession);
    this.maxIterations = options.maxIterations;
    this.prompt = new PromptSession();
    this.renderer = new CliRenderer(core, options.showReasoning ?? false);
    this.renderer.update({
      provider: options.provider ?? core.config.defaultProvider,
      model: options.model ?? core.config.defaultModel,
      mode: options.mode ?? core.config.mode,
      effort: options.effort ?? core.config.agent.effort,
    });
    this.installSigint();
  }

  private installSigint(): void {
    this.prompt.rl.on('SIGINT', () => {
      if (this.abortController) {
        process.stdout.write(`\n${icons.warn} ${theme.yellow('Interrupting task...')}\n`);
        this.abortController.abort();
        return;
      }
      const now = Date.now();
      if (now - this.lastSigint < 1200) {
        void this.shutdown(130).then(() => process.exit(130));
        return;
      }
      this.lastSigint = now;
      process.stdout.write(`\n${theme.gray('Press Ctrl+C again within 1s to exit, or use /quit.')}\n`);
    });
  }

  async start(): Promise<number> {
    if (this.core.snapshot.hasProjectConfig && !this.core.snapshot.projectTrusted) {
      const trusted = await this.prompt.askYesNo(
        `${icons.warn} This project has .mookacode/config.json but is not trusted. Project permissions, MCP servers and agents are ignored. Trust it?`,
        false,
      );
      if (trusted) {
        await this.core.trustCurrentProject();
        process.stdout.write(`${icons.ok} Project trusted.\n`);
      }
    }

    if (this.sessionId) {
      await this.loadSession(this.sessionId);
    } else if (this.continueSession) {
      await this.loadLatestSession(true);
    }

    this.renderer.banner(this.core);
    if (!this.session) {
      const latest = await this.core.sessionStore.latest(this.core.root);
      if (latest && latest.status === 'interrupted' && latest.pendingTask) {
        process.stdout.write(
          `${icons.warn} Interrupted session ${theme.accent(latest.id)} found: ${theme.gray(truncate(latest.pendingTask, 70))}\n` +
            `${theme.gray('  Use /continue to resume it, or /resume ' + latest.id + ' to open it.')}\n\n`,
        );
      }
    }

    while (!this.exiting) {
      if (!this.prompt.interactive) throw new Error('Interactive mode requires a TTY.');
      this.renderer.printPromptStatus(shortPath(this.core.root, 56));
      const input = await this.prompt
        .question(`\n${theme.accentBold('mookacode')} ${theme.accent('›')} `)
        .catch((error) => {
          if (error instanceof CancelledError) return '';
          throw error;
        });
      const task = input.trim();
      if (!task) continue;
      if (task.startsWith('/')) {
        const shouldExit = await this.handleSlash(task);
        if (shouldExit) break;
        continue;
      }
      await this.executeTask(task);
    }
    await this.shutdown(0);
    return 0;
  }

  async runOnce(task: string): Promise<number> {
    if (this.core.snapshot.hasProjectConfig && !this.core.snapshot.projectTrusted) {
      process.stderr.write(`Warning: project config is ignored until trusted (mookacode config trust).\n`);
    }
    if (this.prompt.interactive) {
      this.renderer.banner(this.core);
    }
    if (this.sessionId) {
      await this.loadSession(this.sessionId);
    } else if (this.continueSession) {
      await this.loadLatestSession(false);
    }
    if (!task && this.session?.pendingTask) task = this.session.pendingTask;
    if (!task) {
      process.stderr.write('No task provided. Usage: mookacode "your task"\n');
      return 1;
    }
    const status = await this.executeTask(task);
    await this.shutdown(status === 'completed' || status === 'plan' ? 0 : status === 'cancelled' ? 130 : 1);
    return status === 'completed' || status === 'plan' ? 0 : status === 'cancelled' ? 130 : 1;
  }

  private async executeTask(task: string): Promise<'completed' | 'failed' | 'cancelled' | 'plan'> {
    this.abortController = new AbortController();
    this.renderer.update({
      provider: this.provider ?? this.core.config.defaultProvider,
      model: this.model ?? this.core.config.defaultModel,
      mode: this.mode ?? this.core.config.mode,
      effort: this.effort ?? this.core.config.agent.effort,
      contextPercent: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
    this.renderer.startRun(task);
    let lastSessionId = this.sessionId;
    try {
      const result = await this.core.runAgent(
        {
          task,
          provider: this.provider,
          model: this.model,
          mode: this.mode,
          sessionId: this.sessionId,
          maxIterations: this.maxIterations,
          effort: this.effort,
          signal: this.abortController.signal,
          requestPermission: async (request) => {
            this.renderer.stopSpinner();
            try {
              return await this.prompt.confirmPermission(request);
            } finally {
              this.renderer.startSpinner('Thinking');
            }
          },
        },
        (event: AgentEvent) => this.renderer.handle(event),
      );
      this.sessionId = result.sessionId;
      lastSessionId = result.sessionId;
      this.session = await this.core.getSession(result.sessionId);
      this.renderer.printStatus(
        result.changedFiles.length ? [`${theme.gray('changes')} ${result.changedFiles.length} file(s)`] : [],
      );
      return result.status;
    } catch (error) {
      if (error instanceof CancelledError) {
        this.renderer.handle({ type: 'run.cancelled', sessionId: lastSessionId ?? 'unknown' });
        return 'cancelled';
      }
      const message = errorMessage(error);
      this.renderer.stopRun();
      process.stderr.write(`${icons.error} ${theme.red(message)}\n`);
      if (/api key|provider|model/i.test(message)) {
        process.stderr.write(
          `${theme.gray('Run "mookacode models", "mookacode auth status" or "mookacode doctor".')}\n`,
        );
      }
      return 'failed';
    } finally {
      this.abortController = undefined;
      this.renderer.stopRun();
    }
  }

  private async handleSlash(input: string): Promise<boolean> {
    const [command = '', ...rest] = input.split(/\s+/);
    const arg = rest.join(' ').trim();
    switch (command) {
      case '/help':
        this.printHelp();
        return false;
      case '/pet':
        printPet();
        return false;
      case '/effort': {
        if (arg) {
          if (!EFFORTS.includes(arg as Effort)) {
            process.stdout.write(`${icons.error} Effort must be one of: ${EFFORTS.join(', ')}\n`);
            return false;
          }
          this.effort = arg as Effort;
        } else {
          const index = await this.prompt.choose(
            'Select effort',
            EFFORTS.map((value) => (value === 'auto' ? 'auto (provider default)' : value)),
            EFFORTS.indexOf(this.effort ?? 'auto'),
          );
          this.effort = EFFORTS[index] ?? this.effort;
        }
        await this.core.updateConfig({ agent: { ...this.core.config.agent, effort: this.effort ?? 'auto' } });
        this.renderer.update({ effort: this.effort ?? 'auto' });
        const model = (await this.core.models()).find((item) => item.id === this.model);
        const native =
          model?.extra?.supportsReasoningEffort === true
            ? 'native reasoning_effort'
            : model?.extra?.supportsThinking === true
              ? 'native thinking budget'
              : 'generic output/temperature/instruction tuning';
        process.stdout.write(
          `${icons.ok} Effort: ${theme.accent(this.effort ?? 'auto')} ${theme.gray(`(${native})`)}\n`,
        );
        return false;
      }
      case '/quit':
      case '/exit':
        return true;
      case '/new':
        this.sessionId = undefined;
        this.session = null;
        this.renderer.update({ contextPercent: 0, inputTokens: 0, outputTokens: 0, changedFiles: 0 });
        process.stdout.write(`${icons.ok} New session. The next prompt starts fresh.\n`);
        return false;
      case '/model': {
        if (arg) {
          const model = (await this.core.models()).find((item) => item.id === arg);
          if (!model) {
            process.stdout.write(`${icons.error} Unknown model "${arg}". Use /models.\n`);
            return false;
          }
          this.model = model.id;
          this.provider = model.providerId;
        } else {
          const models = (await this.core.models()).filter(
            (model) => model.configured && model.supportsTools !== false,
          );
          if (!models.length) {
            process.stdout.write(
              `${icons.warn} No models are configured. Use "mookacode providers add" or "mookacode auth set".\n`,
            );
            return false;
          }
          const index = await this.prompt.choose(
            'Select model',
            models.slice(0, 30).map((model) => `${model.providerId}/${model.id}${model.default ? ' (default)' : ''}`),
          );
          const selected = models[index];
          if (selected) {
            this.model = selected.id;
            this.provider = selected.providerId;
          }
        }
        this.renderer.update({ provider: this.provider ?? '', model: this.model ?? '' });
        process.stdout.write(`${icons.ok} Model: ${theme.accent(`${this.provider}/${this.model}`)}\n`);
        return false;
      }
      case '/provider': {
        if (arg) {
          const provider = this.core.config.providers.find((item) => item.id === arg);
          if (!provider) {
            process.stdout.write(`${icons.error} Unknown provider "${arg}".\n`);
            return false;
          }
          this.provider = provider.id;
          this.model = provider.models[0]?.id;
        } else {
          const index = await this.prompt.choose(
            'Select provider',
            this.core.config.providers.map((provider) => `${provider.id} — ${provider.name}`),
          );
          const provider = this.core.config.providers[index];
          if (provider) {
            this.provider = provider.id;
            this.model = provider.models[0]?.id;
          }
        }
        this.renderer.update({ provider: this.provider ?? '', model: this.model ?? '' });
        process.stdout.write(`${icons.ok} Provider: ${theme.accent(this.provider ?? '')} / ${this.model ?? ''}\n`);
        return false;
      }
      case '/mode': {
        const modes: AgentMode[] = ['plan', 'build', 'debug', 'ask', 'review'];
        if (arg) {
          if (!modes.includes(arg as AgentMode)) {
            process.stdout.write(`${icons.error} Mode must be one of: ${modes.join(', ')}\n`);
            return false;
          }
          this.mode = arg as AgentMode;
        } else {
          const index = await this.prompt.choose('Select mode', modes, modes.indexOf(this.mode ?? 'build'));
          this.mode = modes[index] ?? this.mode;
        }
        this.renderer.update({ mode: this.mode ?? 'build' });
        process.stdout.write(`${icons.ok} Mode: ${theme.accent(this.mode ?? 'build')}\n`);
        return false;
      }
      case '/models':
        await this.printModels();
        return false;
      case '/sessions': {
        const sessions = await this.core.listSessions({ query: arg || undefined, limit: 20 });
        if (!sessions.length) {
          process.stdout.write('No sessions.\n');
          return false;
        }
        for (const session of sessions) {
          process.stdout.write(
            `${theme.accent(session.id)} ${theme.bold(truncate(session.title, 55))} ${theme.gray(`[${session.status}] ${session.model}`)}\n`,
          );
        }
        process.stdout.write(`${theme.gray('Use /resume <id> or /resume to choose.')}\n`);
        return false;
      }
      case '/resume': {
        if (arg) {
          await this.loadSession(arg);
        } else {
          const sessions = await this.core.listSessions({ limit: 20 });
          if (!sessions.length) {
            process.stdout.write('No sessions to resume.\n');
            return false;
          }
          const index = await this.prompt.choose(
            'Resume session',
            sessions.map((session) => `${session.id} — ${truncate(session.title, 60)}`),
          );
          const selected = sessions[index];
          if (selected) await this.loadSession(selected.id);
        }
        return false;
      }
      case '/continue': {
        if (!this.session && this.sessionId) await this.loadSession(this.sessionId);
        if (!this.session) this.session = await this.core.sessionStore.latest(this.core.root);
        if (!this.session) {
          process.stdout.write('No session to continue.\n');
          return false;
        }
        const pending = this.session.pendingTask;
        if (!pending) {
          process.stdout.write('The current session has no interrupted task. Enter a new prompt instead.\n');
          return false;
        }
        this.sessionId = this.session.id;
        await this.executeTask(pending);
        return false;
      }
      case '/diff':
        await this.printDiff(arg);
        return false;
      case '/status':
        await this.printStatus();
        return false;
      case '/permissions':
        this.printPermissions();
        return false;
      case '/compact':
        process.stdout.write(
          `${theme.gray('Automatic context compaction is enabled. It runs before a request when usage reaches ' + this.core.config.context.compactAtPercent + '%.')}\n`,
        );
        return false;
      case '/init':
        await this.initAgentsFile();
        return false;
      case '/clear':
        clearScreen();
        this.renderer.banner(this.core);
        return false;
      default:
        process.stdout.write(`${icons.warn} Unknown command ${command}. Use /help.\n`);
        return false;
    }
  }

  private async loadLatestSession(show: boolean): Promise<void> {
    const session = await this.core.sessionStore.latest(this.core.root);
    if (!session) return;
    this.sessionId = session.id;
    this.session = session;
    this.provider = session.provider;
    this.model = session.model;
    this.mode = session.mode;
    this.renderer.update({ provider: session.provider, model: session.model, mode: session.mode });
    if (show) {
      this.renderer.sessionBanner(session.id, session.title);
      if (session.pendingTask)
        process.stdout.write(`${theme.gray('Interrupted task:')} ${truncate(session.pendingTask, 100)}\n`);
    }
  }

  private async loadSession(id: string): Promise<void> {
    const session = await this.core.getSession(id);
    if (!session) throw new Error(`Session not found: ${id}`);
    if (path.resolve(session.projectRoot) !== path.resolve(this.core.root)) {
      process.stdout.write(
        `${icons.warn} Session belongs to ${session.projectRoot}; switch to that directory to continue it.\n`,
      );
      this.sessionId = undefined;
      this.session = null;
      return;
    }
    this.sessionId = session.id;
    this.session = session;
    this.provider = session.provider;
    this.model = session.model;
    this.mode = session.mode;
    this.renderer.update({ provider: session.provider, model: session.model, mode: session.mode });
    this.renderer.sessionBanner(session.id, session.title);
    if (session.pendingTask)
      process.stdout.write(
        `${theme.gray('Interrupted task:')} ${truncate(session.pendingTask, 100)} ${theme.gray('(/continue to resume)')}\n`,
      );
    const lastAssistant = [...session.messages]
      .reverse()
      .find((message) => message.role === 'assistant' && message.content.trim());
    if (lastAssistant) {
      process.stdout.write(`${theme.gray(truncate(lastAssistant.content, 600))}\n`);
    }
  }

  private async printModels(): Promise<void> {
    const models = await this.core.models();
    for (const model of models) {
      const status =
        model.providerType === 'ollama'
          ? 'local'
          : model.keySource === 'none'
            ? theme.red('no key')
            : theme.green(model.keySource);
      process.stdout.write(
        `${model.default ? theme.accent('*') : ' '} ${model.providerId}/${model.id}  ${theme.gray(
          `${model.contextWindow ? formatNumber(model.contextWindow) : '?'} ctx · tools ${model.supportsTools === false ? 'no' : 'yes'} · ${status}`,
        )}\n`,
      );
    }
    process.stdout.write(`${theme.gray('Set with /model <id>, --model, or the Desktop model manager.')}\n`);
  }

  private async printDiff(paths?: string): Promise<void> {
    try {
      if (!(await this.core.git.isRepository())) {
        process.stdout.write(`${icons.warn} Not a Git repository.\n`);
        return;
      }
      const diff = await this.core.gitDiff(paths ? [paths] : undefined);
      if (!diff.trim()) {
        process.stdout.write(`${theme.gray('No tracked changes.')}\n`);
        return;
      }
      process.stdout.write(`${truncateMiddle(diff, 40_000)}\n`);
    } catch (error) {
      process.stdout.write(`${icons.error} ${errorMessage(error)}\n`);
    }
  }

  private async printStatus(): Promise<void> {
    const session = this.sessionId ? await this.core.getSession(this.sessionId) : null;
    process.stdout.write(`${theme.bold('Status')}\n`);
    process.stdout.write(`  workspace   ${this.core.root}\n`);
    process.stdout.write(`  provider    ${this.provider ?? this.core.config.defaultProvider}\n`);
    process.stdout.write(`  model       ${this.model ?? this.core.config.defaultModel}\n`);
    process.stdout.write(`  mode        ${this.mode ?? this.core.config.mode}\n`);
    process.stdout.write(`  effort      ${this.effort ?? this.core.config.agent.effort}\n`);
    process.stdout.write(`  session     ${session?.id ?? '(new)'}\n`);
    if (session) {
      process.stdout.write(`  title       ${session.title}\n`);
      process.stdout.write(`  state       ${session.status}\n`);
      process.stdout.write(`  messages    ${session.messages.length}\n`);
      process.stdout.write(
        `  usage       ${formatNumber(session.usage.inputTokens)} in / ${formatNumber(session.usage.outputTokens)} out (${session.usage.requests} requests)\n`,
      );
      if (session.changedFiles.length) {
        process.stdout.write(
          `  changes     ${session.changedFiles.map((file) => `${file.kind}:${file.path}`).join(', ')}\n`,
        );
      }
      if (session.checkpoints.length) {
        process.stdout.write(`  checkpoints ${session.checkpoints.map((checkpoint) => checkpoint.id).join(', ')}\n`);
      }
    }
    process.stdout.write(`  context     ${this.renderer.state.contextPercent}% (last request)\n`);
  }

  private printPermissions(): void {
    const permissions = this.core.config.permissions;
    process.stdout.write(`${theme.bold('Permissions')} ${theme.gray('(session overrides are additional)')}\n`);
    for (const key of ['read', 'edit', 'command', 'network', 'gitWrite', 'mcp'] as const) {
      const value = permissions[key];
      const color = value === 'allow' ? theme.green : value === 'ask' ? theme.yellow : theme.red;
      process.stdout.write(`  ${key.padEnd(10)} ${color(value)}\n`);
    }
    process.stdout.write(`${theme.gray('Change with "mookacode config set permissions.edit ask".')}\n`);
  }

  private async initAgentsFile(): Promise<void> {
    const target = path.join(this.core.root, 'AGENTS.md');
    try {
      const existing = await readFile(target, 'utf8');
      if (existing.trim() && !(await this.prompt.askYesNo('AGENTS.md already exists. Overwrite it?', false))) {
        return;
      }
    } catch {
      // File does not exist.
    }
    const project = await this.core.projectSnapshot();
    const scripts = Object.entries(project.scripts).slice(0, 12);
    const content = `# AGENTS.md

## Project
- Name: ${project.info.name}
- Stack: ${project.info.projectTypes.join(', ') || 'unknown'}
- Languages: ${project.info.languages.join(', ') || 'unknown'}
- Package manager: ${project.info.packageManager ?? 'unknown'}

## Commands
${scripts.length ? scripts.map(([name, command]) => `- ${name}: \`${command}\``).join('\n') : '- Add the exact test, lint and typecheck commands here.'}

## Working agreements
- Inspect existing code before changing it.
- Keep edits focused and preserve public APIs unless the task requires a change.
- Do not overwrite unrelated uncommitted work.
- Run the relevant tests or typecheck before finishing.
- Do not commit secrets or API keys.

## Project notes
- Add architecture decisions and known constraints here.
`;
    await writeFile(target, content, 'utf8');
    process.stdout.write(`${icons.ok} Wrote ${target}\n`);
  }

  private printHelp(): void {
    const lines = [
      '',
      `${theme.accentBold('MookaCode commands')}`,
      `  ${theme.accent('/help')}              Show this help`,
      `  ${theme.accent('/pet')}               Show the MookaCode companion`,
      `  ${theme.accent('/effort [level]')}    auto | low | medium | high (saved to config)`,
      `  ${theme.accent('/new')}               Start a new session`,
      `  ${theme.accent('/model [id]')}        Select a model`,
      `  ${theme.accent('/provider [id]')}     Select a provider`,
      `  ${theme.accent('/mode [mode]')}       plan | build | debug | ask | review`,
      `  ${theme.accent('/models')}            List configured models and key status`,
      `  ${theme.accent('/sessions [query]')}  List recent sessions`,
      `  ${theme.accent('/resume [id]')}       Resume a session`,
      `  ${theme.accent('/continue')}          Resume the interrupted task`,
      `  ${theme.accent('/diff [path]')}       Show the current Git diff`,
      `  ${theme.accent('/status')}            Session, model and usage status`,
      `  ${theme.accent('/permissions')}       Show effective permission policy`,
      `  ${theme.accent('/compact')}           Context compaction information`,
      `  ${theme.accent('/init')}              Create an AGENTS.md from the project profile`,
      `  ${theme.accent('/clear')}             Clear the screen`,
      `  ${theme.accent('/quit')}              Exit`,
      '',
      theme.gray('Ctrl+C interrupts a running task; press twice while idle to exit.'),
      theme.gray('CLI commands: models, providers, config, auth, sessions, doctor.'),
      '',
      rule(Math.min(terminalWidth(), 84)),
      '',
    ];
    process.stdout.write(lines.join('\n'));
  }

  async shutdown(code: number): Promise<void> {
    if (this.exiting) return;
    this.exiting = true;
    this.renderer.stopRun();
    this.prompt.close();
    await this.core.close().catch(() => undefined);
    process.exitCode = code;
  }
}
