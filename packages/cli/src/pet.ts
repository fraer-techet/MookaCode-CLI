const RESET = '\u001b[0m';
const BODY = '\u001b[38;2;64;200;255m';
const DARK = '\u001b[38;2;15;25;35m';

// Compact 15-cell wide companion (~1/3 of the original size).
// '#' = body, 'o' = dark pixels (eyes), ' ' = empty.
const PET_CELLS = [
  '###         ###',
  '###############',
  '###oo#####oo###',
  '###############',
  '##  ##   ##  ##',
  '##  ##   ##  ##',
];

function colorEnabled(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && !process.argv.includes('--no-color');
}

function cell(value: string, colored: boolean): string {
  if (value === 'o') return colored ? `${DARK}█${RESET}` : ' ';
  if (value === '#') return colored ? `${BODY}█${RESET}` : '█';
  return ' ';
}

export function petLines(colored = colorEnabled()): string[] {
  return PET_CELLS.map((row) => {
    const cells = [...row];
    const parts: string[] = [];
    let current = cells[0] ?? ' ';
    let run = 0;
    const flush = () => {
      if (!run) return;
      parts.push(cell(current, colored).repeat(run));
      run = 0;
    };
    for (const value of cells) {
      if (value === current) {
        run += 1;
      } else {
        flush();
        current = value;
        run = 1;
      }
    }
    flush();
    return ` ${parts.join('')}`;
  });
}

export function printPet(): void {
  process.stdout.write(`\n${petLines().join('\n')}\n\n`);
}

export function petWidth(): number {
  return 15 + 1;
}
