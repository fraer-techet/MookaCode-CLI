import { createTwoFilesPatch } from 'diff';

export interface FileDiff {
  patch: string;
  additions: number;
  deletions: number;
}

export function createUnifiedDiff(relativePath: string, before: string, after: string, contextLines = 3): FileDiff {
  const patch = createTwoFilesPatch(`a/${relativePath}`, `b/${relativePath}`, before, after, '', '', {
    context: contextLines,
  });
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { patch, additions, deletions };
}

export function countDiffLines(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { additions, deletions };
}
