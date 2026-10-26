import type { MookaCore } from '@mookacode/core';
import { formatDuration, formatNumber, sanitizeConfigForExport } from '@mookacode/core';
import type { ModelConfig, ProviderConfig, ProviderType } from '@mookacode/protocol';
import { PromptSession, promptSecret } from './prompt';
import { theme, icons, truncate } from './theme';
import { flagBool, flagString, type ParsedArgs } from './args';

export async function runCommand(core: MookaCore, parsed: ParsedArgs): Promise<number> {
  switch (parsed.command) {
    case 'models':
      await listModels(core, flagBool(parsed, 'json'));
      return 0;
    case 'setup':
      await setupProvider(core);
      return 0;
    case 'providers':
      await providersCommand(core, parsed);
      return 0;
    case 'config':
      await configCommand(core, parsed);
      return 0;
    case 'auth':
      await authCommand(core, parsed);
      return 0;
    case 'sessions':
      await sessionsCommand(core, parsed);
      return 0;
    case 'doctor':
      await doctorCommand(core, parsed);
      return 0;
    default:
      process.stderr.write(`Unknown command: ${parsed.command}\nRun "mookacode --help".\n`);
      return 1;
  }
}

async function listModels(core: MookaCore, json: boolean): Promise<void> {
  const models = await core.models();
  if (json) {
    process.stdout.write(`${JSON.stringify(models, null, 2)}\n`);
    return;
  }
  const rows = models.map((model) => ({
    active: model.default ? '*' : ' ',
    provider: model.providerId,
    model: model.id,
    context: model.contextWindow ? formatNumber(model.contextWindow) : '?',
    tools: model.supportsTools === false ? 'no' : 'yes',
    key: model.providerType === 'ollama' ? 'local' : model.keySource === 'none' ? 'missing' : model.keySource,
  }));
  const widths = {
    provider: Math.max(8, ...rows.map((row) => row.provider.length)),
    model: Math.max(5, ...rows.map((row) => row.model.length)),
    context: 7,
    tools: 5,
    key: 7,
  };
  const header = `  ${'provider'.padEnd(widths.provider)}  ${'model'.padEnd(widths.model)}  ${'context'.padEnd(widths.context)}  ${'tools'.padEnd(widths.tools)}  key`;
  process.stdout.write(`${theme.bold(header)}\n`);
  for (const row of rows) {
    const keyColor = row.key === 'missing' ? theme.red : row.key === 'local' ? theme.cyan : theme.green;
    process.stdout.write(
      `${row.active} ${row.provider.padEnd(widths.provider)}  ${row.model.padEnd(widths.model)}  ${row.context.padEnd(widths.context)}  ${row.tools.padEnd(widths.tools)}  ${keyColor(row.key)}\n`,
    );
  }
  process.stdout.write(`\n${theme.gray('* = default. Add a key with "mookacode auth set <provider>".')}\n`);
}

async function providersCommand(core: MookaCore, parsed: ParsedArgs): Promise<void> {
  const sub = parsed.subcommand ?? 'list';
  if (sub === 'list') {
    const status = await core.providers.keyStatus();
    for (const provider of core.config.providers) {
      const defaultMark = provider.id === core.config.defaultProvider ? theme.accent('*') : ' ';
      const key = provider.type === 'ollama' ? 'local' : (status.get(provider.id) ?? 'none');
      process.stdout.write(
        `${defaultMark} ${theme.bold(provider.id)} ${theme.gray(`(${provider.type})`)}  ${provider.name}\n`,
      );
      process.stdout.write(
        `    ${theme.gray('base')} ${provider.baseUrl ?? '(default)'}  ${theme.gray('models')} ${provider.models.map((model) => model.id).join(', ') || '(none)'}  ${theme.gray('key')} ${key}\n`,
      );
    }
    return;
  }
  if (sub === 'add') {
    await addProvider(core, parsed);
    return;
  }
  if (sub === 'remove') {
    const id = flagString(parsed, 'id') ?? parsed.positionals[2];
    if (!id) throw new Error('Usage: mookacode providers remove --id <provider>');
    await core.removeProvider(id);
    process.stdout.write(`${icons.ok} Removed provider ${theme.accent(id)}.\n`);
    return;
  }
  if (sub === 'default') {
    const id = flagString(parsed, 'id') ?? parsed.positionals[2];
    if (!id) throw new Error('Usage: mookacode providers default <provider> [model]');
    await core.setDefault(id, parsed.positionals[3]);
    const provider = core.config.providers.find((item) => item.id === id);
    process.stdout.write(
      `${icons.ok} Default set to ${theme.accent(`${id}/${provider?.models[0]?.id ?? core.config.defaultModel}`)}.\n`,
    );
    return;
  }
  if (sub === 'probe') {
    const id = flagString(parsed, 'id') ?? parsed.positionals[2] ?? core.config.defaultProvider;
    process.stdout.write(theme.gray(`Probing ${id}...\n`));
    const result = await core.probeProvider(id, parsed.positionals[3]);
    process.stdout.write(`${result.ok ? icons.ok : icons.error} ${result.message}\n`);
    if (result.models?.length) {
      process.stdout.write(`${theme.gray('Reported models:')} ${result.models.slice(0, 30).join(', ')}\n`);
    }
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (sub === 'edit') {
    await editProvider(core, parsed);
    return;
  }
  if (sub === 'setup') {
    await setupProvider(core);
    return;
  }
  throw new Error(`Unknown providers subcommand: ${sub}`);
}

const PROVIDER_TYPES: ProviderType[] = ['anthropic', 'openai', 'openai-compatible', 'ollama'];

function normalizeType(value?: string): ProviderType | undefined {
  const normalized = value?.trim().toLowerCase().replace(/_/g, '-');
  if (!normalized) return undefined;
  if (normalized === 'custom' || normalized === 'openai-compatible') return 'openai-compatible';
  if (PROVIDER_TYPES.includes(normalized as ProviderType)) return normalized as ProviderType;
  throw new Error(`Unsupported provider type: ${value}. Use anthropic, openai, openai-compatible (custom) or ollama.`);
}

function parseHeaders(raw?: string): Record<string, string> | undefined {
  if (!raw?.trim()) return undefined;
  const headers: Record<string, string> = {};
  for (const line of raw.split(/[;\n]/)) {
    const index = line.indexOf(':');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (key) headers[key] = value;
  }
  return Object.keys(headers).length ? headers : undefined;
}

function parseModels(
  raw: string | undefined,
  provider: { type: ProviderType },
  context?: string,
  maxOutput?: string,
): ModelConfig[] {
  const ids = (raw ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return ids.map((id) => ({
    id,
    providerModelId: id,
    name: id,
    contextWindow: context ? Number(context) : provider.type === 'ollama' ? 32768 : undefined,
    maxOutputTokens: maxOutput ? Number(maxOutput) : undefined,
    supportsTools: true,
    supportsStreaming: true,
  }));
}

async function addProvider(core: MookaCore, parsed: ParsedArgs): Promise<void> {
  const prompts = new PromptSession();
  try {
    let id = flagString(parsed, 'id') ?? parsed.positionals[2];
    let name = flagString(parsed, 'name');
    let type: ProviderType | undefined = normalizeType(flagString(parsed, 'type'));
    let baseUrl = flagString(parsed, 'base-url');
    let modelId = flagString(parsed, 'model');
    let context = flagString(parsed, 'context');
    const maxOutput = flagString(parsed, 'max-output');
    let headers = parseHeaders(flagString(parsed, 'headers'));
    const apiKeyEnv = flagString(parsed, 'api-key-env');
    let setDefault = flagBool(parsed, 'default');
    if (id === 'ollama') type = 'ollama';

    if (prompts.interactive && (!id || !type || !modelId)) {
      id = id || (await prompts.question('Provider id (letters, digits, dash): ')).trim();
      const typeAnswer =
        type ??
        normalizeType(
          (await prompts.question('Type [anthropic/openai/openai-compatible/ollama] (openai-compatible): ')).trim() ||
            'openai-compatible',
        );
      type = typeAnswer ?? 'openai-compatible';
      modelId = modelId || (await prompts.question('Model id (comma separated for several): ')).trim();
      name = name || id;
      baseUrl =
        baseUrl ||
        (
          await prompts.question(
            `Base URL${type === 'anthropic' ? ' (https://api.anthropic.com)' : type === 'openai' ? ' (https://api.openai.com/v1)' : type === 'ollama' ? ' (http://127.0.0.1:11434/v1)' : ' (must point to an OpenAI-compatible /v1 server)'}: `,
          )
        ).trim() ||
        undefined;
      if (!headers)
        headers = parseHeaders(
          (await prompts.question('Extra headers "Name: Value" separated by ";" (optional): ')).trim(),
        );
      if (context === undefined && type !== 'ollama')
        context = (await prompts.question('Context window (optional): ')).trim() || undefined;
      if (!setDefault) setDefault = await prompts.askYesNo('Make this the default provider?', false);
    }

    if (!id || !type || !modelId) {
      throw new Error(
        'Usage: mookacode providers add --id <id> --type <type> --model <model[,model2]> [--base-url <url>] [--name <name>] [--headers "Name: Value;..."] [--api-key-env VAR] [--context N] [--default]',
      );
    }
    const resolvedBase =
      baseUrl ||
      (type === 'anthropic'
        ? 'https://api.anthropic.com'
        : type === 'openai'
          ? 'https://api.openai.com/v1'
          : type === 'ollama'
            ? 'http://127.0.0.1:11434/v1'
            : undefined);
    if (!resolvedBase && type !== 'anthropic' && type !== 'openai') {
      throw new Error('A Base URL is required for custom OpenAI-compatible providers, e.g. http://127.0.0.1:8080/v1');
    }
    const provider: ProviderConfig = {
      id,
      name: name || id,
      type,
      baseUrl: resolvedBase,
      apiKeyEnv:
        apiKeyEnv || (type === 'anthropic' ? 'ANTHROPIC_API_KEY' : type === 'openai' ? 'OPENAI_API_KEY' : undefined),
      apiKeyRef: id,
      headers,
      timeoutMs: type === 'ollama' ? 180_000 : 120_000,
      maxRetries: type === 'ollama' ? 0 : 2,
      models: parseModels(modelId, { type }, context, maxOutput),
    };
    await core.addProvider(provider, setDefault);
    process.stdout.write(
      `${icons.ok} Added provider ${theme.accent(id)} (${type}) with model(s) ${theme.accent(provider.models.map((model) => model.id).join(', '))}.\n`,
    );
    if (type !== 'ollama') {
      if (prompts.interactive) {
        prompts.close();
        const key = await promptSecret(`  API key for ${id} (leave empty to configure later): `);
        if (key.trim()) {
          const backend = await core.setApiKey(id, key.trim());
          process.stdout.write(`${icons.ok} Stored key using ${backend}.\n`);
        }
      } else if (apiKeyEnv) {
        process.stdout.write(`${theme.gray(`Set ${apiKeyEnv} or use "mookacode auth set ${id}".`)}\n`);
      } else {
        process.stdout.write(`${theme.gray(`Configure a key with "mookacode auth set ${id}" or an env var.`)}\n`);
      }
    }
    process.stdout.write(`${theme.gray(`Verify with "mookacode providers probe ${id}".`)}\n`);
  } finally {
    prompts.close();
  }
}

async function editProvider(core: MookaCore, parsed: ParsedArgs): Promise<void> {
  const id = flagString(parsed, 'id') ?? parsed.positionals[2];
  if (!id)
    throw new Error(
      'Usage: mookacode providers edit --id <provider> [--base-url <url>] [--model a,b] [--headers "Name: Value"] [--api-key-env VAR] [--default]',
    );
  const provider = core.providers.getProvider(id);
  const next: ProviderConfig = structuredClone(provider);
  const name = flagString(parsed, 'name');
  const baseUrl = flagString(parsed, 'base-url');
  const apiKeyEnv = flagString(parsed, 'api-key-env');
  const models = flagString(parsed, 'model');
  const context = flagString(parsed, 'context');
  const maxOutput = flagString(parsed, 'max-output');
  const headers = parseHeaders(flagString(parsed, 'headers'));
  const type = normalizeType(flagString(parsed, 'type'));
  if (name) next.name = name;
  if (type) next.type = type;
  if (baseUrl) next.baseUrl = baseUrl;
  if (apiKeyEnv) next.apiKeyEnv = apiKeyEnv;
  if (headers) next.headers = { ...(next.headers ?? {}), ...headers };
  if (models) {
    const parsedModels = parseModels(models, next, context, maxOutput);
    next.models = parsedModels.map((model) => {
      const existing = provider.models.find((item) => item.id === model.id);
      return existing ? { ...existing, contextWindow: model.contextWindow ?? existing.contextWindow } : model;
    });
  } else if (context || maxOutput) {
    next.models = next.models.map((model) => ({
      ...model,
      contextWindow: context ? Number(context) : model.contextWindow,
      maxOutputTokens: maxOutput ? Number(maxOutput) : model.maxOutputTokens,
    }));
  }
  await core.addProvider(next, flagBool(parsed, 'default'));
  process.stdout.write(
    `${icons.ok} Updated provider ${theme.accent(id)}: ${next.type}, base ${next.baseUrl ?? '(default)'}, models ${next.models.map((model) => model.id).join(', ')}.\n`,
  );
}

async function setupProvider(core: MookaCore): Promise<void> {
  const prompts = new PromptSession();
  try {
    if (!prompts.interactive) {
      throw new Error(
        'Interactive setup requires a TTY. Use "mookacode providers add" with flags for non-interactive setup.',
      );
    }
    const type =
      normalizeType(
        (
          await prompts.question('API format [anthropic/openai/openai-compatible/ollama] (openai-compatible): ')
        ).trim() || 'openai-compatible',
      ) ?? 'openai-compatible';
    const id = (await prompts.question('Provider id (e.g. local, together, groq): ')).trim();
    const name = (await prompts.question('Display name: ')).trim() || id;
    const baseUrl =
      (
        await prompts.question(
          `Base URL${type === 'ollama' ? ' (http://127.0.0.1:11434/v1)' : type === 'anthropic' ? ' (https://api.anthropic.com)' : type === 'openai' ? ' (https://api.openai.com/v1)' : ' (https://host/v1)'}: `,
        )
      ).trim() || undefined;
    const modelIds = (await prompts.question('Model id(s), comma separated: ')).trim();
    const context = (await prompts.question('Context window (optional): ')).trim() || undefined;
    const headers = parseHeaders(
      (await prompts.question('Extra headers "Name: Value" separated by ";" (optional): ')).trim(),
    );
    const apiKeyEnv = (await prompts.question('API key env var (optional): ')).trim() || undefined;
    const setDefault = await prompts.askYesNo('Make this the default provider?', true);
    if (!id || !modelIds) throw new Error('Provider id and at least one model are required.');
    const resolvedBase =
      baseUrl ||
      (type === 'ollama'
        ? 'http://127.0.0.1:11434/v1'
        : type === 'anthropic'
          ? 'https://api.anthropic.com'
          : type === 'openai'
            ? 'https://api.openai.com/v1'
            : undefined);
    if (!resolvedBase) throw new Error('Base URL is required for custom OpenAI-compatible providers.');
    await core.addProvider(
      {
        id,
        name,
        type,
        baseUrl: resolvedBase,
        apiKeyEnv:
          apiKeyEnv || (type === 'anthropic' ? 'ANTHROPIC_API_KEY' : type === 'openai' ? 'OPENAI_API_KEY' : undefined),
        apiKeyRef: id,
        headers,
        timeoutMs: type === 'ollama' ? 180_000 : 120_000,
        maxRetries: type === 'ollama' ? 0 : 2,
        models: parseModels(modelIds, { type }, context),
      },
      setDefault,
    );
    process.stdout.write(`${icons.ok} Configured provider ${theme.accent(id)}.\n`);
    const probe = await prompts.askYesNo('Test the connection now?', true);
    prompts.close();
    if (type !== 'ollama') {
      const key = await promptSecret(`API key for ${id} (leave empty to use ${apiKeyEnv ?? 'an env var'}): `);
      if (key.trim()) {
        const backend = await core.setApiKey(id, key.trim());
        process.stdout.write(`${icons.ok} Stored key using ${backend}.\n`);
      }
    }
    if (probe && type !== 'ollama') {
      const result = await core.probeProvider(id);
      process.stdout.write(`${result.ok ? icons.ok : icons.error} ${result.message}\n`);
    }
    process.stdout.write(
      `${theme.gray(`Start with: mookacode --provider ${id} --model ${modelIds.split(',')[0]?.trim()} "..."`)}\n`,
    );
  } finally {
    prompts.close();
  }
}

async function authCommand(core: MookaCore, parsed: ParsedArgs): Promise<void> {
  const sub = parsed.subcommand ?? 'status';
  if (sub === 'status' || sub === 'list') {
    const backend = await core.authBackend();
    const entries = await core.authList();
    process.stdout.write(`${theme.gray('backend')} ${theme.accent(backend)}\n`);
    if (!entries.length) {
      process.stdout.write(`${theme.gray('No stored API keys. Environment variables also work.')}\n`);
      return;
    }
    for (const entry of entries) {
      process.stdout.write(
        `${icons.ok} ${entry.providerId} ${theme.gray(`(${entry.backend}, updated ${new Date(entry.updatedAt).toLocaleString()})`)}\n`,
      );
    }
    return;
  }
  if (sub === 'set') {
    let providerId = flagString(parsed, 'id') ?? parsed.positionals[2];
    if (!providerId) {
      const providers = core.config.providers.filter((provider) => provider.type !== 'ollama');
      if (providers.length === 1) providerId = providers[0]?.id;
      else throw new Error('Usage: mookacode auth set <provider>');
    }
    const provider = core.providers.getProvider(providerId);
    const key = await promptSecret(`API key for ${provider.name}: `);
    if (!key.trim()) throw new Error('API key is empty.');
    const backend = await core.setApiKey(providerId, key.trim());
    process.stdout.write(
      `${icons.ok} Stored API key for ${theme.accent(providerId)} using ${backend}. The key was not written to history or logs.\n`,
    );
    return;
  }
  if (sub === 'remove') {
    const providerId = flagString(parsed, 'id') ?? parsed.positionals[2];
    if (!providerId) throw new Error('Usage: mookacode auth remove <provider>');
    const removed = await core.removeApiKey(providerId);
    process.stdout.write(
      removed ? `${icons.ok} Removed stored key for ${providerId}.\n` : `No stored key for ${providerId}.\n`,
    );
    return;
  }
  throw new Error(`Unknown auth subcommand: ${sub}`);
}

async function configCommand(core: MookaCore, parsed: ParsedArgs): Promise<void> {
  const sub = parsed.subcommand ?? 'show';
  if (sub === 'path') {
    process.stdout.write(`${core.configPath}\n${core.projectConfigPath ?? ''}\n`);
    return;
  }
  if (sub === 'init') {
    await core.updateConfig({});
    process.stdout.write(`${icons.ok} Configuration initialized at ${core.configPath}\n`);
    return;
  }
  if (sub === 'show') {
    process.stdout.write(`${JSON.stringify(sanitizeConfigForExport(core.config), null, 2)}\n`);
    if (core.snapshot.hasProjectConfig && !core.snapshot.projectTrusted) {
      process.stdout.write(`\n${icons.warn} Project config exists but is not trusted. Run "mookacode config trust".\n`);
    }
    return;
  }
  if (sub === 'get') {
    const key = parsed.positionals[2];
    if (!key) throw new Error('Usage: mookacode config get <dot.path>');
    const value = getPath(sanitizeConfigForExport(core.config) as unknown as Record<string, unknown>, key);
    process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
    return;
  }
  if (sub === 'set') {
    const key = parsed.positionals[2];
    const raw = parsed.positionals.slice(3).join(' ');
    if (!key || !raw) throw new Error('Usage: mookacode config set <dot.path> <json-or-string>');
    let value: unknown = raw;
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw;
    }
    await core.updateConfig(nestedPatch(key, value));
    process.stdout.write(`${icons.ok} Updated ${key}. Configuration saved to ${core.configPath}\n`);
    return;
  }
  if (sub === 'trust') {
    await core.trustCurrentProject();
    process.stdout.write(
      `${icons.ok} Trusted project ${core.root}. Project config, MCP servers and agents are now active.\n`,
    );
    return;
  }
  if (sub === 'untrust') {
    await core.revokeProjectTrust();
    process.stdout.write(
      `${icons.warn} Revoked trust for ${core.root}. Project config, MCP servers and agents are ignored.\n`,
    );
    return;
  }
  throw new Error(`Unknown config subcommand: ${sub}`);
}

async function sessionsCommand(core: MookaCore, parsed: ParsedArgs): Promise<void> {
  const sub = parsed.subcommand ?? 'list';
  if (sub === 'list') {
    const status = flagString(parsed, 'status');
    const query = flagString(parsed, 'query') ?? parsed.positionals[2];
    const sessions = await core.listSessions({
      query,
      status: status as never,
      includeArchived: flagBool(parsed, 'archived'),
      limit: Number(flagString(parsed, 'limit') ?? 30),
    });
    if (!sessions.length) {
      process.stdout.write('No sessions found.\n');
      return;
    }
    for (const session of sessions) {
      const age = formatDuration(Date.now() - session.updatedAt);
      process.stdout.write(
        `${theme.accent(session.id)}  ${theme.bold(truncate(session.title, 60))}\n  ${theme.gray(
          `${session.status} · ${session.mode} · ${session.model} · ${formatNumber(session.usage.inputTokens)} in / ${formatNumber(session.usage.outputTokens)} out · ${age} ago`,
        )}\n`,
      );
    }
    return;
  }
  if (sub === 'show') {
    const id = parsed.positionals[2];
    if (!id) throw new Error('Usage: mookacode sessions show <id>');
    const session = await core.getSession(id);
    if (!session) throw new Error(`Session not found: ${id}`);
    process.stdout.write(
      `${theme.accentBold(session.title)}\n${theme.gray(`${session.id} · ${session.status} · ${session.cwd}`)}\n`,
    );
    if (session.checkpoints.length) {
      process.stdout.write(
        `${theme.gray('Checkpoints:')} ${session.checkpoints.map((checkpoint) => `${checkpoint.id} (${checkpoint.label})`).join(', ')}\n`,
      );
    }
    process.stdout.write('\n');
    for (const message of session.messages) {
      if (message.meta?.hidden) continue;
      const label =
        message.role === 'user' ? 'you' : message.role === 'assistant' ? 'mooka' : (message.toolName ?? 'tool');
      process.stdout.write(`${theme.bold(label)}:\n${truncate(message.content, 10_000)}\n\n`);
    }
    return;
  }
  if (sub === 'delete') {
    const id = parsed.positionals[2];
    if (!id) throw new Error('Usage: mookacode sessions delete <id>');
    const removed = await core.deleteSession(id);
    process.stdout.write(removed ? `${icons.ok} Deleted ${id}.\n` : `Session not found: ${id}\n`);
    return;
  }
  if (sub === 'rename') {
    const id = parsed.positionals[2];
    const title = parsed.positionals.slice(3).join(' ');
    if (!id || !title) throw new Error('Usage: mookacode sessions rename <id> <title>');
    const meta = await core.renameSession(id, title);
    process.stdout.write(meta ? `${icons.ok} Renamed session.\n` : 'Session not found.\n');
    return;
  }
  if (sub === 'archive') {
    const id = parsed.positionals[2];
    if (!id) throw new Error('Usage: mookacode sessions archive <id>');
    const meta = await core.archiveSession(id, true);
    process.stdout.write(meta ? `${icons.ok} Archived session.\n` : 'Session not found.\n');
    return;
  }
  if (sub === 'restore') {
    const id = parsed.positionals[2];
    if (!id) throw new Error('Usage: mookacode sessions restore <id> [checkpoint-id]');
    const session = await core.getSession(id);
    if (!session) throw new Error(`Session not found: ${id}`);
    if (session.projectRoot !== core.root) {
      throw new Error(`This session belongs to ${session.projectRoot}; run MookaCode from that project.`);
    }
    const checkpoint = parsed.positionals[3]
      ? session.checkpoints.find((item) => item.id === parsed.positionals[3] || item.ref === parsed.positionals[3])
      : session.checkpoints[session.checkpoints.length - 1];
    if (!checkpoint) throw new Error('No checkpoint found for this session.');
    await core.applyCheckpoint(checkpoint.ref);
    process.stdout.write(`${icons.ok} Restored checkpoint ${checkpoint.id}. Git history was not rewritten.\n`);
    return;
  }
  throw new Error(`Unknown sessions subcommand: ${sub}`);
}

async function doctorCommand(core: MookaCore, parsed: ParsedArgs): Promise<void> {
  const checks: Array<{ ok: boolean; label: string; detail: string }> = [];
  checks.push({
    ok: Number(process.versions.node.split('.')[0]) >= 20,
    label: 'Node.js',
    detail: `${process.version} (${process.platform})`,
  });
  checks.push({
    ok: await core.git.isAvailable(),
    label: 'Git',
    detail: (await core.git.isAvailable()) ? 'available' : 'not found in PATH',
  });
  checks.push({ ok: true, label: 'Workspace', detail: core.root });
  checks.push({
    ok: await core.git.isRepository(),
    label: 'Repository',
    detail: (await core.git.isRepository()) ? 'Git repository detected' : 'not a Git repository',
  });
  const models = await core.models();
  const configured = models.filter((model) => model.configured);
  checks.push({
    ok: configured.length > 0,
    label: 'Models',
    detail: configured.length ? `${configured.length} configured model(s)` : 'no API key/configured model',
  });
  checks.push({ ok: true, label: 'Key store', detail: await core.authBackend() });
  checks.push({
    ok: !core.snapshot.hasProjectConfig || core.snapshot.projectTrusted,
    label: 'Project trust',
    detail: !core.snapshot.hasProjectConfig
      ? 'no project config'
      : core.snapshot.projectTrusted
        ? 'trusted'
        : 'project config is ignored until trusted',
  });
  for (const server of await core.lspStatuses()) {
    checks.push({
      ok: server.available,
      label: `LSP ${server.id}`,
      detail: server.available ? (server.path ?? 'available') : `${server.command} not found`,
    });
  }
  const mcp = await core.mcpStatuses();
  for (const server of mcp) {
    checks.push({
      ok: server.connected,
      label: `MCP ${server.name}`,
      detail: server.error ?? `${server.tools} tool(s)`,
    });
  }
  for (const check of checks) {
    process.stdout.write(
      `${check.ok ? icons.ok : icons.warn} ${theme.bold(check.label.padEnd(14))} ${theme.gray(check.detail)}\n`,
    );
  }
  if (flagBool(parsed, 'verbose')) {
    const providerId = flagString(parsed, 'provider') ?? core.config.defaultProvider;
    const result = await core.probeProvider(providerId);
    process.stdout.write(`${result.ok ? icons.ok : icons.error} API probe: ${result.message}\n`);
  }
  if (checks.some((check) => !check.ok)) process.exitCode = 1;
}

function getPath(target: Record<string, unknown>, path: string): unknown {
  let current: unknown = target;
  for (const part of path.split('.')) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function nestedPatch(path: string, value: unknown): Record<string, unknown> {
  const parts = path.split('.').filter(Boolean);
  const root: Record<string, unknown> = {};
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index] ?? '';
    if (index === parts.length - 1) current[part] = value;
    else {
      const next: Record<string, unknown> = {};
      current[part] = next;
      current = next;
    }
  }
  return root;
}
