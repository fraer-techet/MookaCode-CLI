export function estimateTokens(text: string): number {
  if (!text) return 0;
  const ascii = (text.match(/[\x00-\x7F]/g) ?? []).length;
  const nonAscii = text.length - ascii;
  return Math.max(1, Math.ceil(ascii / 3.8 + nonAscii / 1.7));
}

export function estimateMessagesTokens(messages: Array<{ content: string; toolCalls?: unknown }>): number {
  let total = 0;
  for (const message of messages) {
    total += estimateTokens(message.content) + 6;
    if (message.toolCalls) total += estimateTokens(JSON.stringify(message.toolCalls));
  }
  return total;
}

export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 80) return text.slice(0, maxChars);
  const head = Math.ceil((maxChars - 60) * 0.62);
  const tail = Math.max(20, maxChars - 60 - head);
  return `${text.slice(0, head)}\n\n… [truncated ${text.length - head - tail} chars] …\n\n${text.slice(-tail)}`;
}

export function truncateEnd(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 40))}\n… [truncated ${text.length - maxChars} chars]`;
}
