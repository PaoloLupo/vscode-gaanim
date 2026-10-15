// Nudging a number by its own precision: `0.8` steps by `0.1`, `0.25` by `0.01`.

export interface NumberAt {
  /** 0-based start column. */
  start: number;
  /** 0-based column just after it. */
  end: number;
  text: string;
}

/** The number at or after a 0-based column of a line. */
export function numberAt(line: string, column: number): NumberAt | undefined {
  const pattern = /-?\d+\.?\d*/g;
  for (const match of line.matchAll(pattern)) {
    let start = match.index ?? 0;
    const end = start + match[0].length;
    const before = line[start - 1] ?? "";
    let identifier = /[\w]/.test(before);
    if (line[start] === "-" && /[\w)\]]/.test(before)) {
      // `x-1` subtracts: the number starts after the minus.
      start++;
      identifier = false;
    }
    if (!identifier && end > column) {
      return { start, end, text: line.slice(start, end) };
    }
  }
  return undefined;
}

/** The text of a number moved by `steps` of its own precision. */
export function step(text: string, steps: number): string {
  const decimals = (/\.(\d*)$/.exec(text)?.[1] ?? "").length;
  const value = Number(text) + steps * 10 ** -decimals;
  let result = value.toFixed(decimals);
  if (text.endsWith(".")) {
    // `1.` stays a float in Python.
    result += ".";
  }
  if (/^-0\.?0*$/.test(result)) {
    result = result.slice(1);
  }
  return result;
}
