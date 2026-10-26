import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { MookaConfig, ProjectProfile } from '@mookacode/protocol';
import { GitService } from '../git/service';
import { mookaHome } from '../util/paths';
import { walkFiles } from '../workspace/walker';

const MANIFESTS: Array<{ file: string; type: string; language: string }> = [
  { file: 'package.json', type: 'Node.js', language: 'JavaScript/TypeScript' },
  { file: 'pnpm-workspace.yaml', type: 'pnpm workspace', language: 'JavaScript/TypeScript' },
  { file: 'Cargo.toml', type: 'Rust', language: 'Rust' },
  { file: 'pyproject.toml', type: 'Python', language: 'Python' },
  { file: 'requirements.txt', type: 'Python', language: 'Python' },
  { file: 'go.mod', type: 'Go', language: 'Go' },
  { file: 'pom.xml', type: 'Java Maven', language: 'Java' },
  { file: 'build.gradle', type: 'Gradle', language: 'Java/Kotlin' },
  { file: 'composer.json', type: 'PHP', language: 'PHP' },
  { file: 'Gemfile', type: 'Ruby', language: 'Ruby' },
  { file: 'CMakeLists.txt', type: 'CMake', language: 'C/C++' },
  { file: '*.sln', type: '.NET', language: 'C#' },
];

const LANG_EXTENSIONS: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.rs': 'Rust',
  '.py': 'Python',
  '.go': 'Go',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.cs': 'C#',
  '.cpp': 'C++',
  '.cc': 'C++',
  '.c': 'C',
  '.h': 'C/C++',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.swift': 'Swift',
  '.vue': 'Vue',
  '.svelte': 'Svelte',
};

export async function detectProject(root: string, config?: MookaConfig): Promise<ProjectProfile> {
  const topLevel = await readdir(root).catch(() => [] as string[]);
  const manifests: string[] = [];
  const projectTypes = new Set<string>();
  const languages = new Set<string>();
  for (const entry of topLevel) {
    const item = MANIFESTS.find((candidate) =>
      candidate.file.includes('*') ? entry.endsWith(candidate.file.slice(1)) : entry === candidate.file,
    );
    if (item) {
      manifests.push(entry);
      projectTypes.add(item.type);
      languages.add(item.language);
    }
  }

  const packageManager = await detectPackageManager(root, topLevel);
  let fileCountSample = 0;
  const extensionCounts = new Map<string, number>();
  for await (const file of walkFiles({
    root,
    maxEntries: 250,
    maxDepth: 12,
    ignoreDirectories: config?.ignoreDirectories,
  })) {
    fileCountSample++;
    const ext = path.extname(file.name).toLowerCase();
    extensionCounts.set(ext, (extensionCounts.get(ext) ?? 0) + 1);
  }
  for (const [ext, count] of extensionCounts) {
    const language = LANG_EXTENSIONS[ext];
    if (language && count > 0) languages.add(language);
  }

  const git = new GitService(root);
  const isGit = await git.isRepository();
  let branch: string | undefined;
  if (isGit) {
    try {
      branch = (await git.status()).branch;
    } catch {
      branch = undefined;
    }
  }

  const instructions: string[] = [];
  for (const candidate of ['AGENTS.md', 'CLAUDE.md', '.mookacode/instructions.md']) {
    if (await fileExists(path.join(root, candidate))) instructions.push(candidate);
  }
  const globalAgents = path.join(mookaHome(), 'AGENTS.md');
  if (await fileExists(globalAgents)) instructions.unshift(globalAgents);

  const memoryFile = path.join(root, '.mookacode', 'memory.json');
  return {
    info: {
      root,
      name: path.basename(root),
      isGit,
      branch,
      projectTypes: [...projectTypes],
      languages: [...languages],
      packageManager,
      instructions,
      memoryFile: (await fileExists(memoryFile)) ? memoryFile : undefined,
      heavyDirectories: config?.ignoreDirectories ?? [],
      fileCountSample,
    },
    topLevel: topLevel.filter((entry) => !entry.startsWith('.')).slice(0, 200),
    manifests,
    scripts: await readScripts(root, manifests),
    gitStatus: isGit
      ? await git
          .status()
          .then((s) => (s.clean ? 'clean' : `${s.files.length} changed file(s)`))
          .catch(() => undefined)
      : undefined,
  };
}

async function detectPackageManager(root: string, topLevel: string[]): Promise<string | undefined> {
  if (topLevel.includes('pnpm-lock.yaml')) return 'pnpm';
  if (topLevel.includes('yarn.lock')) return 'yarn';
  if (topLevel.includes('bun.lockb') || topLevel.includes('bun.lock')) return 'bun';
  if (topLevel.includes('package-lock.json')) return 'npm';
  if (topLevel.includes('Cargo.lock')) return 'cargo';
  if (topLevel.includes('pyproject.toml') || topLevel.includes('requirements.txt')) return 'python';
  if (await fileExists(path.join(root, 'package.json'))) return 'npm';
  return undefined;
}

async function readScripts(root: string, manifests: string[]): Promise<Record<string, string>> {
  if (!manifests.includes('package.json')) return {};
  try {
    const parsed = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    return parsed.scripts ?? {};
  } catch {
    return {};
  }
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

export function compactProjectSummary(profile: ProjectProfile): string {
  const info = profile.info;
  const parts = [
    `Project: ${info.name}`,
    `Types: ${info.projectTypes.join(', ') || 'unknown'}`,
    `Languages: ${info.languages.join(', ') || 'unknown'}`,
    info.packageManager ? `Package manager: ${info.packageManager}` : '',
    info.isGit ? `Git branch: ${info.branch ?? 'unknown'}` : 'Git: no',
    profile.scripts && Object.keys(profile.scripts).length
      ? `Scripts: ${Object.keys(profile.scripts).slice(0, 12).join(', ')}`
      : '',
    profile.topLevel.length ? `Top level: ${profile.topLevel.slice(0, 24).join(', ')}` : '',
  ];
  return parts.filter(Boolean).join('\n');
}
