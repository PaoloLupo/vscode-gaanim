// What the installed gaanim can do, from its help text.

export interface Caps {
  /** `--listen stdio`: drive the preview and hear the playhead. */
  listen: boolean;
  /** `--message-format json`. */
  json: boolean;
  /** `gaanim inspect --json`. */
  inspect: boolean;
  /** `export --frame/--from/--to` take segment and stop names. */
  names: boolean;
}

export const NO_CAPS: Caps = { listen: false, json: false, inspect: false, names: false };

/** What `gaanim --help` and `gaanim export --help` say the executable supports. */
export function parseCaps(general: string, exportHelp: string): Caps {
  return {
    listen: general.includes("--listen"),
    json: (general + exportHelp).includes("--message-format"),
    inspect: /\n\s+inspect\s/.test(general),
    names: exportHelp.includes("<SECONDS|NAME>"),
  };
}
