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
  /** `gaanim project --json`, and with it workspaces. */
  project: boolean;
  /** `gaanim init --message-format json`: what was created and its warnings as JSON. */
  initJson: boolean;
}

export const NO_CAPS: Caps = { listen: false, json: false, inspect: false, names: false, project: false, initJson: false };

/** What `gaanim --help`, `gaanim export --help` and `gaanim init --help` say the executable supports. */
export function parseCaps(general: string, exportHelp: string, initHelp = ""): Caps {
  return {
    listen: general.includes("--listen"),
    json: (general + exportHelp).includes("--message-format"),
    inspect: /\n\s+inspect\s/.test(general),
    names: exportHelp.includes("<SECONDS|NAME>"),
    project: /\n\s+project\s/.test(general),
    initJson: initHelp.includes("--message-format"),
  };
}
