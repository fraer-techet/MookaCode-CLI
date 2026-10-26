const enabled =
  Boolean(process.stdout.isTTY) &&
  !process.env.NO_COLOR &&
  !process.argv.includes('--no-color') &&
  process.env.TERM !== 'dumb';

function style(value: string, code: string): string {
  return enabled ? `\u001b[${code}m${value}\u001b[0m` : value;
}

export const theme = {
  enabled,
  accent: (value: string) => style(value, '38;2;166;148;255'),
  accentBold: (value: string) => style(value, '1;38;2;166;148;255'),
  bold: (value: string) => style(value, '1'),
  dim: (value: string) => style(value, '2'),
  green: (value: string) => style(value, '38;2;110;210;160'),
  yellow: (value: string) => style(value, '38;2;230;190;100'),
  red: (value: string) => style(value, '38;2;240;110;120'),
  cyan: (value: string) => style(value, '38;2;120;200;225'),
  gray: (value: string) => style(value, '38;2;130;130;140'),
  inverse: (value: string) => style(value, '7'),
};

export function terminalWidth(): number {
  return Math.max(50, Math.min(140, process.stdout.columns ?? 100));
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 1) return '…';
  return `${value.slice(0, max - 1)}…`;
}

export function rule(width = terminalWidth()): string {
  return theme.gray('─'.repeat(Math.max(20, width)));
}

export const icons = {
  ok: theme.green('✓'),
  error: theme.red('✗'),
  warn: theme.yellow('!'),
  info: theme.accent('›'),
  bullet: theme.gray('·'),
  running: theme.accent('◐'),
};
