import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { isWithin, normalizeForCompare } from '../util/paths';
import { PermissionDeniedError } from '../util/errors';

export class WorkspaceGuard {
  readonly root: string;
  private realRoot: string | null = null;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async getRealRoot(): Promise<string> {
    if (!this.realRoot) {
      try {
        this.realRoot = await realpath(this.root);
      } catch (error) {
        throw new PermissionDeniedError(`Workspace does not exist: ${this.root}`, { cause: error });
      }
    }
    return this.realRoot;
  }

  async resolve(input: string, options: { mustExist?: boolean; forWrite?: boolean } = {}): Promise<string> {
    if (!input || input.includes('\0')) throw new PermissionDeniedError('Invalid path');
    const root = await this.getRealRoot();
    const raw = path.isAbsolute(input) ? path.resolve(input) : path.resolve(root, input);
    const comparisonRoot = normalizeForCompare(root);
    const comparisonRaw = normalizeForCompare(raw);
    if (!isWithin(comparisonRoot, comparisonRaw)) {
      throw new PermissionDeniedError(
        `Path "${input}" is outside the workspace. MookaCode tools are restricted to ${root}.`,
      );
    }

    let target = raw;
    try {
      const info = await stat(raw);
      const real = await realpath(raw);
      if (!isWithin(comparisonRoot, normalizeForCompare(real))) {
        throw new PermissionDeniedError(
          `Path "${input}" resolves outside the workspace through a symlink or junction.`,
        );
      }
      if (info.isDirectory()) {
        target = real;
      } else {
        target = real;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        if (error instanceof PermissionDeniedError) throw error;
        throw new PermissionDeniedError(`Cannot access "${input}": ${(error as Error).message}`);
      }
      if (options.mustExist) throw new PermissionDeniedError(`Path does not exist: ${input}`);
      const parent = path.dirname(raw);
      let realParent: string;
      try {
        realParent = await realpath(parent);
      } catch {
        if (!options.forWrite)
          throw new PermissionDeniedError(`Parent directory does not exist: ${path.dirname(input)}`);
        const ancestor = await this.findExistingAncestor(parent);
        realParent = ancestor;
      }
      if (!isWithin(comparisonRoot, normalizeForCompare(realParent))) {
        throw new PermissionDeniedError(
          `Path "${input}" resolves outside the workspace through a symlink or junction.`,
        );
      }
      target = path.join(realParent, path.basename(raw));
    }

    if (!isWithin(comparisonRoot, normalizeForCompare(target))) {
      throw new PermissionDeniedError(`Path "${input}" is outside the workspace.`);
    }
    return target;
  }

  private async findExistingAncestor(start: string): Promise<string> {
    let current = start;
    while (true) {
      try {
        return await realpath(current);
      } catch {
        const parent = path.dirname(current);
        if (parent === current) throw new PermissionDeniedError(`Cannot resolve a parent directory for ${start}`);
        current = parent;
      }
    }
  }

  relative(target: string): string {
    const rel = path.relative(this.realRoot ?? this.root, target);
    return (rel || '.').split(path.sep).join('/');
  }
}
