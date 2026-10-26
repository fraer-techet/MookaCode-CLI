export interface ParsedArgs {
  command?: string;
  subcommand?: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

const VALUE_FLAGS = new Set([
  'model',
  'provider',
  'session',
  'mode',
  'max-iterations',
  'name',
  'type',
  'base-url',
  'api-key-env',
  'id',
  'context',
  'max-output',
  'commands',
  'scope',
  'limit',
  'status',
  'transport',
  'command',
  'url',
  'query',
  'effort',
  'headers',
]);

const BOOLEAN_FLAGS = new Set([
  'help',
  'version',
  'continue',
  'json',
  'no-color',
  'verbose',
  'trust',
  'archived',
  'default',
  'all',
  'show-reasoning',
  'pet',
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let afterDoubleDash = false;
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === undefined) continue;
    if (afterDoubleDash) {
      positionals.push(value);
      continue;
    }
    if (value === '--') {
      afterDoubleDash = true;
      continue;
    }
    if (value === '-h') {
      flags.help = true;
      continue;
    }
    if (value === '-v') {
      flags.version = true;
      continue;
    }
    if (value === '-c') {
      flags.continue = true;
      continue;
    }
    if (value.startsWith('--')) {
      const [rawName, ...rest] = value.slice(2).split('=');
      const name = rawName ?? '';
      if (!name) continue;
      if (VALUE_FLAGS.has(name)) {
        if (rest.length) flags[name] = rest.join('=');
        else {
          const next = argv[index + 1];
          if (next && !next.startsWith('-')) {
            flags[name] = next;
            index++;
          } else {
            flags[name] = true;
          }
        }
      } else if (BOOLEAN_FLAGS.has(name)) {
        flags[name] = true;
      } else {
        throw new Error(`Unknown option: --${name}`);
      }
      continue;
    }
    if (value.startsWith('-') && value.length > 1) {
      throw new Error(`Unknown option: ${value}`);
    }
    positionals.push(value);
  }
  const command = positionals[0];
  const subcommand = positionals[1];
  return { command, subcommand, positionals, flags };
}

export function flagString(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags[name];
  return typeof value === 'string' ? value : undefined;
}

export function flagBool(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags[name] === true;
}
