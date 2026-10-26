import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { ConfigSnapshot, MookaConfig } from '@mookacode/protocol';
import { defaultConfig, migrateConfig } from './defaults';
import { validateConfig } from './schema';
import { mookaHome } from '../util/paths';
import { readJson, writeJsonAtomic } from '../util/fs';
import { MookaError } from '../util/errors';

export function globalConfigPath(): string {
  return path.join(mookaHome(), 'config.json');
}

export function projectConfigPath(cwd: string): string {
  return path.join(cwd, '.mookacode', 'config.json');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override === undefined ? base : (override as T);
  }
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const current = result[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      result[key] = deepMerge(current, value);
    } else {
      result[key] = value;
    }
  }
  return result as T;
}

export class ConfigManager {
  readonly cwd: string;
  readonly globalPath: string;
  readonly projectPath: string;

  constructor(cwd = process.cwd()) {
    this.cwd = path.resolve(cwd);
    this.globalPath = globalConfigPath();
    this.projectPath = projectConfigPath(this.cwd);
  }

  async load(options: { trustProject?: boolean } = {}): Promise<ConfigSnapshot> {
    const base = defaultConfig();
    const globalRaw = await this.readConfig(this.globalPath);
    let merged = globalRaw ? deepMerge(base, globalRaw) : base;
    let projectRaw: unknown | null = null;
    if (!options.trustProject) {
      projectRaw = await this.readConfig(this.projectPath, true);
    } else {
      projectRaw = await this.readConfig(this.projectPath);
      if (projectRaw) merged = deepMerge(merged, projectRaw);
    }

    const { config, issues } = validateConfig(migrateConfig(merged as MookaConfig));
    if (issues.length > 0) {
      throw new MookaError(
        'CONFIG_INVALID',
        `Invalid configuration: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`,
        { details: issues },
      );
    }
    this.validateProviderSelection(config);
    return {
      config,
      globalPath: this.globalPath,
      projectPath: projectRaw ? this.projectPath : undefined,
      projectTrusted: Boolean(options.trustProject),
      hasProjectConfig: Boolean(projectRaw),
      issues,
    };
  }

  private async readConfig(file: string, ignoreMalformed = false): Promise<unknown | null> {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new MookaError('CONFIG_READ_FAILED', `Cannot read ${file}: ${(error as Error).message}`, { cause: error });
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      if (ignoreMalformed) return null;
      throw new MookaError('CONFIG_PARSE_FAILED', `Invalid JSON in ${file}: ${(error as Error).message}`, {
        cause: error,
      });
    }
  }

  private validateProviderSelection(config: MookaConfig): void {
    const provider = config.providers.find((item) => item.id === config.defaultProvider);
    if (!provider) {
      throw new MookaError(
        'PROVIDER_NOT_FOUND',
        `Default provider "${config.defaultProvider}" does not exist. Run "mookacode providers list".`,
      );
    }
    const model = provider.models.find((item) => item.id === config.defaultModel);
    if (!model) {
      const fallback = provider.models[0];
      if (!fallback) {
        throw new MookaError(
          'MODEL_NOT_CONFIGURED',
          `Provider "${provider.id}" has no models. Run "mookacode providers add" or edit ${this.globalPath}.`,
        );
      }
      config.defaultModel = fallback.id;
    }
  }

  async saveGlobal(config: MookaConfig): Promise<void> {
    const { issues } = validateConfig(config);
    if (issues.length > 0) {
      throw new MookaError(
        'CONFIG_INVALID',
        `Refusing to save invalid config: ${issues[0]?.path} ${issues[0]?.message}`,
      );
    }
    await writeJsonAtomic(this.globalPath, config, 0o600);
  }

  async saveProject(config: MookaConfig): Promise<void> {
    const { issues } = validateConfig(config);
    if (issues.length > 0) {
      throw new MookaError(
        'CONFIG_INVALID',
        `Refusing to save invalid config: ${issues[0]?.path} ${issues[0]?.message}`,
      );
    }
    await writeJsonAtomic(this.projectPath, config, 0o600);
  }

  async initGlobal(): Promise<string> {
    const config = defaultConfig();
    await writeJsonAtomic(this.globalPath, config, 0o600);
    return this.globalPath;
  }
}

export async function configExists(file: string): Promise<boolean> {
  return (await readJson(file)) !== null;
}
