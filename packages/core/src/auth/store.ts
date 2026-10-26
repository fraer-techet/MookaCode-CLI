import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import type { ProviderConfig } from '@mookacode/protocol';
import { mookaHome } from '../util/paths';
import { readJson, writeJsonAtomic } from '../util/fs';
import { MookaError } from '../util/errors';

type Backend = 'dpapi' | 'keychain' | 'secret-service' | 'encrypted-file';

interface SecretEntry {
  backend: Backend;
  value: string;
  updatedAt: number;
}

interface SecretFile {
  version: 1;
  entries: Record<string, SecretEntry>;
}

export interface KeyResolution {
  key?: string;
  source: 'env' | 'store' | 'none';
  backend?: Backend;
}

const POWERSHELL_DPAPI = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
if ($payload.op -eq 'protect') {
  $bytes = [Text.Encoding]::UTF8.GetBytes([string]$payload.value)
  $protected = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Convert]::ToBase64String($protected))
} elseif ($payload.op -eq 'unprotect') {
  $bytes = [Convert]::FromBase64String([string]$payload.value)
  $plain = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))
} else {
  throw 'Unknown operation'
}
`;

function commandExists(command: string, args: string[] = ['--version']): boolean {
  try {
    const result = spawnSync(command, args, { stdio: 'ignore', timeout: 3000, windowsHide: true });
    return !result.error;
  } catch {
    return false;
  }
}

function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function runPowerShell(payload: Record<string, unknown>): string {
  const result = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(POWERSHELL_DPAPI)],
    {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || 'DPAPI operation failed').trim());
  return result.stdout.trim();
}

function secretFilePath(): string {
  return path.join(mookaHome(), 'secrets.json');
}

function localKeyPath(): string {
  return path.join(mookaHome(), 'secret.key');
}

function getLocalKey(): Buffer {
  const file = localKeyPath();
  if (!existsSync(file)) {
    const key = randomBytes(32);
    writeFileSync(file, key, { mode: 0o600 });
    try {
      chmodSync(file, 0o600);
    } catch {
      // Windows ACLs are used instead where chmod is a no-op.
    }
  }
  const key = readFileSync(file);
  if (key.length !== 32) throw new MookaError('SECRET_KEY_INVALID', `Invalid local secret key at ${file}`);
  return key;
}

function encryptLocal(plain: string, providerId: string): string {
  const key = scryptSync(getLocalKey(), `mookacode:${providerId}`, 32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decryptLocal(value: string, providerId: string): string {
  const data = Buffer.from(value, 'base64');
  if (data.length < 29) throw new MookaError('SECRET_DECRYPT_FAILED', 'Stored secret is corrupted');
  const key = scryptSync(getLocalKey(), `mookacode:${providerId}`, 32);
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const encrypted = data.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

export class CredentialStore {
  private backend?: Backend;

  private detectBackend(): Backend {
    if (this.backend) return this.backend;
    if (process.platform === 'win32') {
      this.backend = 'dpapi';
    } else if (process.platform === 'darwin' && commandExists('security', ['help'])) {
      this.backend = 'keychain';
    } else if (commandExists('secret-tool', ['--version'])) {
      this.backend = 'secret-service';
    } else {
      this.backend = 'encrypted-file';
    }
    return this.backend;
  }

  getBackend(): Backend {
    return this.detectBackend();
  }

  private async readSecrets(): Promise<SecretFile> {
    return (await readJson<SecretFile>(secretFilePath())) ?? { version: 1, entries: {} };
  }

  private async writeSecrets(file: SecretFile): Promise<void> {
    await writeJsonAtomic(secretFilePath(), file, 0o600);
  }

  async set(providerId: string, secret: string): Promise<Backend> {
    if (!secret.trim()) throw new MookaError('SECRET_EMPTY', 'API key cannot be empty');
    const backend = this.detectBackend();
    let stored: string;
    if (backend === 'dpapi') {
      stored = runPowerShell({ op: 'protect', value: secret });
    } else if (backend === 'keychain') {
      const result = spawnSync(
        'security',
        ['add-generic-password', '-U', '-s', 'mookacode', '-a', providerId, '-w', secret],
        { encoding: 'utf8', timeout: 15_000 },
      );
      if (result.status !== 0) {
        throw new MookaError('KEYCHAIN_SET_FAILED', (result.stderr || 'macOS Keychain write failed').trim());
      }
      stored = 'keychain';
    } else if (backend === 'secret-service') {
      const result = spawnSync(
        'secret-tool',
        ['store', '--label', `MookaCode ${providerId}`, 'service', 'mookacode', 'account', providerId],
        { input: secret, encoding: 'utf8', timeout: 15_000 },
      );
      if (result.status !== 0) {
        throw new MookaError('SECRET_SERVICE_SET_FAILED', (result.stderr || 'Secret Service write failed').trim());
      }
      stored = 'secret-service';
    } else {
      stored = encryptLocal(secret, providerId);
    }
    const file = await this.readSecrets();
    file.entries[providerId] = { backend, value: stored, updatedAt: Date.now() };
    await this.writeSecrets(file);
    return backend;
  }

  async get(providerId: string): Promise<KeyResolution> {
    const file = await this.readSecrets();
    const entry = file.entries[providerId];
    if (!entry) return { source: 'none' };
    try {
      if (entry.backend === 'dpapi') {
        if (process.platform !== 'win32') return { source: 'none' };
        return { key: runPowerShell({ op: 'unprotect', value: entry.value }), source: 'store', backend: 'dpapi' };
      }
      if (entry.backend === 'keychain') {
        const result = spawnSync('security', ['find-generic-password', '-s', 'mookacode', '-a', providerId, '-w'], {
          encoding: 'utf8',
          timeout: 15_000,
        });
        if (result.status !== 0) return { source: 'none' };
        return { key: result.stdout.trim(), source: 'store', backend: 'keychain' };
      }
      if (entry.backend === 'secret-service') {
        const result = spawnSync('secret-tool', ['lookup', 'service', 'mookacode', 'account', providerId], {
          encoding: 'utf8',
          timeout: 15_000,
        });
        if (result.status !== 0) return { source: 'none' };
        return { key: result.stdout.trim(), source: 'store', backend: 'secret-service' };
      }
      return { key: decryptLocal(entry.value, providerId), source: 'store', backend: 'encrypted-file' };
    } catch (error) {
      throw new MookaError(
        'SECRET_READ_FAILED',
        `Could not read stored API key for ${providerId}: ${(error as Error).message}`,
        {
          cause: error,
        },
      );
    }
  }

  async remove(providerId: string): Promise<boolean> {
    const file = await this.readSecrets();
    const entry = file.entries[providerId];
    if (!entry) return false;
    if (entry.backend === 'keychain') {
      spawnSync('security', ['delete-generic-password', '-s', 'mookacode', '-a', providerId], {
        encoding: 'utf8',
        timeout: 15_000,
      });
    } else if (entry.backend === 'secret-service') {
      spawnSync('secret-tool', ['clear', 'service', 'mookacode', 'account', providerId], {
        encoding: 'utf8',
        timeout: 15_000,
      });
    }
    delete file.entries[providerId];
    await this.writeSecrets(file);
    return true;
  }

  async list(): Promise<Array<{ providerId: string; backend: Backend; updatedAt: number }>> {
    const file = await this.readSecrets();
    return Object.entries(file.entries).map(([providerId, entry]) => ({
      providerId,
      backend: entry.backend,
      updatedAt: entry.updatedAt,
    }));
  }

  async resolve(provider: ProviderConfig): Promise<KeyResolution> {
    const envNames = [
      provider.apiKeyEnv,
      provider.type === 'anthropic' ? 'ANTHROPIC_API_KEY' : undefined,
      provider.type === 'openai' ? 'OPENAI_API_KEY' : undefined,
    ].filter((value): value is string => Boolean(value));
    for (const name of envNames) {
      const value = process.env[name];
      if (value?.trim()) return { key: value.trim(), source: 'env' };
    }
    const stored = await this.get(provider.apiKeyRef || provider.id);
    if (stored.key) return stored;
    return { source: 'none' };
  }
}
