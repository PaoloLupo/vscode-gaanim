// The top-level keys of gaanim.toml.

export type TomlValue = string | number | boolean;

/**
 * Reads the top-level `key = value` pairs of a TOML file. gaanim.toml only
 * needs strings, numbers and booleans there; the first table ends the read.
 */
export function readTopLevel(text: string): Record<string, TomlValue> {
  const result: Record<string, TomlValue> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimStart();
    if (line.startsWith("[")) {
      break;
    }
    const match = /^([\w-]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) {
      continue;
    }
    const [, key, value] = match;
    const quoted = /^"((?:[^"\\]|\\.)*)"/.exec(value) ?? /^'([^']*)'/.exec(value);
    if (quoted) {
      result[key] = value.startsWith('"') ? quoted[1].replace(/\\(["\\])/g, "$1") : quoted[1];
    } else if (value.startsWith("true")) {
      result[key] = true;
    } else if (value.startsWith("false")) {
      result[key] = false;
    } else {
      const number = /^[-+]?[\d.]+/.exec(value);
      if (number && !Number.isNaN(Number(number[0]))) {
        result[key] = Number(number[0]);
      }
    }
  }
  return result;
}
