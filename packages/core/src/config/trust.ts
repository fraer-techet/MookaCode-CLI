import path from 'node:path';
import { readJson, writeJsonAtomic } from '../util/fs';
import { mookaHome, normalizeForCompare } from '../util/paths';

interface TrustFile {
  version: 1;
  projects: Record<string, { trustedAt: number; label?: string }>;
}

function trustPath(): string {
  return path.join(mookaHome(), 'trusted-projects.json');
}

async function readTrust(): Promise<TrustFile> {
  return (await readJson<TrustFile>(trustPath())) ?? { version: 1, projects: {} };
}

export class TrustStore {
  async isTrusted(projectRoot: string): Promise<boolean> {
    const trust = await readTrust();
    return Boolean(trust.projects[normalizeForCompare(projectRoot)]);
  }

  async trust(projectRoot: string, label?: string): Promise<void> {
    const trust = await readTrust();
    const key = normalizeForCompare(projectRoot);
    trust.projects[key] = { trustedAt: Date.now(), label };
    await writeJsonAtomic(trustPath(), trust, 0o600);
  }

  async revoke(projectRoot: string): Promise<void> {
    const trust = await readTrust();
    delete trust.projects[normalizeForCompare(projectRoot)];
    await writeJsonAtomic(trustPath(), trust, 0o600);
  }

  async list(): Promise<Array<{ path: string; trustedAt: number; label?: string }>> {
    const trust = await readTrust();
    return Object.entries(trust.projects).map(([projectPath, value]) => ({ path: projectPath, ...value }));
  }
}
