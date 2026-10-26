import { readFileTool, writeFileTool, editFileTool } from './file-tools';
import { listFilesTool, searchFilesTool, searchTextTool } from './search-tools';
import { runCommandTool, testRunnerTool } from './command-tools';
import { gitStatusTool, gitDiffTool, gitLogTool, gitShowTool, gitBranchTool } from './git-tools';
import { diagnosticsTool } from './diagnostics-tools';
import { fetchDocumentationTool, webSearchTool } from './network-tools';
import { memorySearchTool, memoryWriteTool } from './memory-tools';
import type { AnyToolDefinition } from './types';

export function builtinTools(): AnyToolDefinition[] {
  return [
    readFileTool,
    writeFileTool,
    editFileTool,
    listFilesTool,
    searchFilesTool,
    searchTextTool,
    runCommandTool,
    gitStatusTool,
    gitDiffTool,
    gitLogTool,
    gitShowTool,
    gitBranchTool,
    testRunnerTool,
    diagnosticsTool,
    webSearchTool,
    fetchDocumentationTool,
    memorySearchTool,
    memoryWriteTool,
  ] as AnyToolDefinition[];
}
