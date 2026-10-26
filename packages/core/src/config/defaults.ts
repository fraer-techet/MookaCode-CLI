import type { MookaConfig, ProviderConfig } from '@mookacode/protocol';

export const DEFAULT_PROVIDERS: ProviderConfig[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    type: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    apiKeyRef: 'anthropic',
    timeoutMs: 120_000,
    maxRetries: 2,
    models: [
      {
        id: 'claude-sonnet-4-5',
        providerModelId: 'claude-sonnet-4-5',
        name: 'Claude Sonnet 4.5',
        contextWindow: 200_000,
        maxOutputTokens: 16_384,
        supportsTools: true,
        supportsStreaming: true,
        supportsVision: true,
        supportsPromptCaching: true,
      },
      {
        id: 'claude-haiku-4-5',
        providerModelId: 'claude-haiku-4-5',
        name: 'Claude Haiku 4.5',
        contextWindow: 200_000,
        maxOutputTokens: 8_192,
        supportsTools: true,
        supportsStreaming: true,
        supportsVision: true,
        supportsPromptCaching: true,
      },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    type: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    apiKeyRef: 'openai',
    timeoutMs: 120_000,
    maxRetries: 2,
    models: [
      {
        id: 'gpt-4.1',
        providerModelId: 'gpt-4.1',
        name: 'GPT-4.1',
        contextWindow: 1_000_000,
        maxOutputTokens: 16_384,
        supportsTools: true,
        supportsStreaming: true,
        supportsVision: true,
      },
      {
        id: 'gpt-4.1-mini',
        providerModelId: 'gpt-4.1-mini',
        name: 'GPT-4.1 mini',
        contextWindow: 1_000_000,
        maxOutputTokens: 16_384,
        supportsTools: true,
        supportsStreaming: true,
        supportsVision: true,
      },
    ],
  },
  {
    id: 'ollama',
    name: 'Ollama (local)',
    type: 'ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    timeoutMs: 180_000,
    maxRetries: 0,
    allowLocalNetwork: true,
    models: [
      {
        id: 'qwen2.5-coder:7b',
        providerModelId: 'qwen2.5-coder:7b',
        name: 'Qwen 2.5 Coder 7B',
        contextWindow: 32_768,
        supportsTools: true,
        supportsStreaming: true,
      },
    ],
  },
];

const LEGACY_UI_DEFAULTS = {
  fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif',
  fontSize: 14,
  accent: '#8b7cf6',
  sidebarWidth: 264,
};

export function migrateConfig(config: MookaConfig): MookaConfig {
  const fresh = defaultConfig();
  if (config.ui.fontFamily === LEGACY_UI_DEFAULTS.fontFamily) config.ui.fontFamily = fresh.ui.fontFamily;
  if (config.ui.fontSize === LEGACY_UI_DEFAULTS.fontSize) config.ui.fontSize = fresh.ui.fontSize;
  if (config.ui.accent === LEGACY_UI_DEFAULTS.accent) config.ui.accent = fresh.ui.accent;
  if (config.ui.sidebarWidth === LEGACY_UI_DEFAULTS.sidebarWidth) config.ui.sidebarWidth = fresh.ui.sidebarWidth;
  return config;
}

export function defaultConfig(): MookaConfig {
  return {
    version: 1,
    defaultProvider: 'anthropic',
    defaultModel: 'claude-sonnet-4-5',
    mode: 'build',
    preference: 'balanced',
    providers: structuredClone(DEFAULT_PROVIDERS),
    permissions: {
      read: 'allow',
      edit: 'ask',
      command: 'ask',
      network: 'allow',
      gitWrite: 'ask',
      mcp: 'ask',
      commandRules: [
        { pattern: 'git status*', decision: 'allow' },
        { pattern: 'git diff*', decision: 'allow' },
        { pattern: 'git log*', decision: 'allow' },
        { pattern: 'git show*', decision: 'allow' },
        { pattern: 'git branch --list*', decision: 'allow' },
        { pattern: 'node --version*', decision: 'allow' },
        { pattern: 'npm --version*', decision: 'allow' },
        { pattern: 'git reset --hard*', decision: 'deny', reason: 'Destructive Git operation' },
        { pattern: 'git clean*', decision: 'deny', reason: 'Destructive Git operation' },
        { pattern: 'git push --force*', decision: 'deny', reason: 'Destructive Git operation' },
        { pattern: 'rm -rf /*', decision: 'deny', reason: 'Destructive filesystem operation' },
        { pattern: 'Remove-Item* -Recurse*', decision: 'deny', reason: 'Destructive filesystem operation' },
      ],
      toolOverrides: {},
    },
    mcpServers: [],
    lspServers: [
      {
        id: 'typescript',
        languages: ['typescript', 'javascript'],
        command: 'typescript-language-server',
        args: ['--stdio'],
        fileExtensions: ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts'],
        enabled: true,
      },
    ],
    agent: {
      maxIterations: 32,
      maxToolCalls: 80,
      maxRunMs: 30 * 60_000,
      maxOutputTokens: 8192,
      temperature: 0.2,
      duplicateCallLimit: 2,
      effort: 'auto',
      autoCheckpoint: true,
      verifyAfterEdit: true,
    },
    context: {
      maxInputTokens: 96_000,
      compactAtPercent: 82,
      reserveOutputTokens: 8_192,
      memoryMaxEntries: 80,
      includeGitStatus: true,
      maxToolResultChars: 24_000,
    },
    ui: {
      theme: 'dark',
      accent: '#a594ff',
      fontFamily: '"Cascadia Code", "JetBrains Mono", "SFMono-Regular", Consolas, monospace',
      fontSize: 13,
      scale: 1,
      sidebarWidth: 248,
      rightPanelWidth: 340,
      rightPanelOpen: false,
      showReasoning: false,
    },
    logging: {
      level: 'error',
      redact: true,
    },
    ignoreDirectories: [
      '.git',
      '.hg',
      '.svn',
      'node_modules',
      'dist',
      'build',
      'out',
      'target',
      '.next',
      '.nuxt',
      '.turbo',
      '.cache',
      'coverage',
      '.venv',
      'venv',
      '__pycache__',
      '.idea',
      '.vscode',
      'vendor',
    ],
    instructions: ['AGENTS.md', 'CLAUDE.md', '.mookacode/instructions.md'],
  };
}

export const PREFERENCE_PRESETS = {
  quality: {
    maxIterations: 48,
    maxToolCalls: 140,
    contextPercent: 92,
    maxToolResultChars: 48_000,
    duplicateCallLimit: 3,
  },
  balanced: {
    maxIterations: 32,
    maxToolCalls: 80,
    contextPercent: 82,
    maxToolResultChars: 24_000,
    duplicateCallLimit: 2,
  },
  economy: {
    maxIterations: 20,
    maxToolCalls: 45,
    contextPercent: 68,
    maxToolResultChars: 12_000,
    duplicateCallLimit: 2,
  },
} as const;
