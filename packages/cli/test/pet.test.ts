import { describe, expect, it } from 'vitest';
import { petLines, petWidth } from '../src/pet';

const ANSI = /\u001b\[[0-9;]*m/g;

describe('pet', () => {
  it('renders all rows with identical visible width', () => {
    const lines = petLines(false);
    expect(lines).toHaveLength(6);
    const widths = new Set(lines.map((line) => line.replace(ANSI, '').length));
    expect(widths.size).toBe(1);
    expect([...widths][0]).toBe(petWidth());
  });

  it('uses the requested truecolor palette and no name/version chrome', () => {
    const colored = petLines(true).join('\n');
    expect(colored).toContain('\u001b[38;2;64;200;255m');
    expect(colored).toContain('\u001b[38;2;15;25;35m');
    expect(colored).not.toContain('mookacode');
    expect(colored).not.toContain('1.0.0');
  });
});
