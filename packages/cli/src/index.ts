import { MookaCore, MookaError, CancelledError, errorMessage, MOOKACODE_VERSION } from '@mookacode/core';
import type { AgentMode, Effort } from '@mookacode/protocol';
import { parseArgs, flagBool, flagString } from './args';
import { runCommand } from './commands';
import { InteractiveCli } from './interactive';
import { theme, icons } from './theme';
import { printPet } from './pet';

const VERSION = MOOKACODE_VERSION;
const COMMANDS = new Set(['models', 'providers', 'setup', 'config', 'auth', 'sessions', 'doctor', 'help', 'version']);
const MODES: AgentMode[] = ['plan', 'build', 'debug', 'ask', 'review'];
const EFFORTS: Effort[] = ['auto', 'low', 'medium', 'high'];

function printHelp(): void {
  process.stdout.write(`${theme.accentBold('MookaCode')} ${VERSION} — local-first AI coding environment

${theme.bold('USAGE')}
  mookacode                          Interactive session
  mookacode "task"                   Run one task in the current project
  mookacode --continue "task"        Continue the latest session
  mookacode --session <id> "task"    Continue a specific session
  mookacode --model <model>          Select a model
  mookacode --provider <provider>    Select a provider
  mookacode --mode <mode>            plan | build | debug | ask | review
  mookacode --effort <level>         auto | low | medium | high (reasoning effort)
  mookacode --max-iterations <n>     Override the iteration limit for this run
  mookacode --show-reasoning         Show model reasoning deltas when provided
  mookacode --pet                    Print the companion mascot and exit

${theme.bold('COMMANDS')}
  mookacode models [--json]          List configured models and key status
  mookacode providers [list]         List providers
  mookacode setup                    Interactive provider/key wizard
  mookacode providers add ...        Add a provider and model(s) (custom endpoints, headers)
  mookacode providers edit --id <id> Change endpoint, models, headers
  mookacode providers remove <id>    Remove a provider
  mookacode providers default <id> [model]
  mookacode providers probe <id>     Test connectivity and credentials
  mookacode config [show]            Show effective configuration
  mookacode config get <path>        Read a configuration value
  mookacode config set <path> <v>    Set a configuration value
  mookacode config init              Write default configuration
  mookacode config trust|untrust     Manage project trust
  mookacode auth [status]            Show credential backend and stored keys
  mookacode auth set <provider>      Store an API key securely
  mookacode auth remove <provider>   Remove a stored key
  mookacode sessions [list]          List sessions
  mookacode sessions show <id>       Show session history
  mookacode sessions delete <id>     Delete a session
  mookacode sessions restore <id> [checkpoint]
                                     Apply a Git checkpoint without rewriting history
  mookacode doctor [--verbose]       Diagnose configuration and integrations

${theme.bold('EXAMPLES')}
  mookacode "find and fix the failing auth test"
  mookacode --mode plan "migrate the API client to fetch"
  mookacode --provider ollama --model qwen2.5-coder:7b "add pagination"
  mookacode --continue

${theme.gray('API keys come from environment variables or the OS credential backend.')}
${theme.gray('Project config, MCP servers and project agents require explicit trust.')}
`);
}

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\nRun "mookacode --help".\n`);
    return 1;
  }

  if (flagBool(parsed, 'version') || parsed.command === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (flagBool(parsed, 'pet')) {
    printPet();
    return 0;
  }
  if (flagBool(parsed, 'help') || parsed.command === 'help') {
    printHelp();
    return 0;
  }

  const modeFlag = flagString(parsed, 'mode');
  if (modeFlag && !MODES.includes(modeFlag as AgentMode)) {
    process.stderr.write(`Invalid mode "${modeFlag}". Expected one of: ${MODES.join(', ')}\n`);
    return 1;
  }
  const effortFlag = flagString(parsed, 'effort');
  if (effortFlag && !EFFORTS.includes(effortFlag as Effort)) {
    process.stderr.write(`Invalid effort "${effortFlag}". Expected one of: ${EFFORTS.join(', ')}\n`);
    return 1;
  }
  const maxIterationsRaw = flagString(parsed, 'max-iterations');
  const maxIterations = maxIterationsRaw ? Number.parseInt(maxIterationsRaw, 10) : undefined;
  if (maxIterationsRaw && (!Number.isFinite(maxIterations) || (maxIterations ?? 0) < 1)) {
    process.stderr.write('--max-iterations must be a positive integer.\n');
    return 1;
  }

  let core: MookaCore | null = null;
  try {
    core = await MookaCore.create({ cwd: process.cwd() });
    if (parsed.command && COMMANDS.has(parsed.command) && parsed.command !== 'help' && parsed.command !== 'version') {
      return await runCommand(core, parsed);
    }

    const task = parsed.positionals.join(' ').trim();
    const interactive = !task;
    if (interactive && (!process.stdin.isTTY || !process.stdout.isTTY)) {
      process.stderr.write('No task provided and stdin is not a TTY. Usage: mookacode "your task"\n');
      return 1;
    }

    const cli = new InteractiveCli(core, {
      provider: flagString(parsed, 'provider'),
      model: flagString(parsed, 'model'),
      mode: modeFlag as AgentMode | undefined,
      effort: effortFlag as Effort | undefined,
      sessionId: flagString(parsed, 'session'),
      continueSession: flagBool(parsed, 'continue'),
      showReasoning: flagBool(parsed, 'show-reasoning'),
      maxIterations,
    });
    if (interactive) return await cli.start();
    return await cli.runOnce(task);
  } catch (error) {
    if (error instanceof CancelledError) return 130;
    const message = errorMessage(error);
    process.stderr.write(`\n${icons.error} ${theme.red(message)}\n`);
    if (error instanceof MookaError) {
      if (error.code === 'CONFIG_INVALID') {
        process.stderr.write(`${theme.gray('Fix the configuration or run "mookacode config path" to locate it.')}\n`);
      }
      if (error.code === 'MISSING_API_KEY' || error.code === 'AUTH_FAILED') {
        process.stderr.write(
          `${theme.gray('Store a key with "mookacode auth set <provider>" or set the provider environment variable.')}\n`,
        );
      }
    }
    if (process.env.MOOKACODE_DEBUG === '1' && error instanceof Error && error.stack) {
      process.stderr.write(`${error.stack}\n`);
    }
    return 1;
  } finally {
    await core?.close().catch(() => undefined);
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
