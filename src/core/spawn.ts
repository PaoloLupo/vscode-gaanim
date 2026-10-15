// How to start a program with node's spawn on each platform.

export interface Launch {
  command: string;
  args: string[];
  shell: boolean;
}

/**
 * One argument quoted for a command line that cmd.exe passes on to a
 * program: inside double quotes, with backslashes before a quote doubled and
 * the quote escaped, as the C runtime reads them back.
 */
export function cmdQuote(arg: string): string {
  if (arg !== "" && !/[\s"&|<>^()%!,;=]/.test(arg)) {
    return arg;
  }
  const escaped = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1");
  return `"${escaped}"`;
}

/**
 * Batch files (`.cmd`, `.bat`) on Windows only start through cmd.exe, and
 * node's `shell: true` joins the command line without quoting it, so a path
 * with spaces would split. Everything else starts directly.
 */
export function launch(program: string, args: string[], platform: string = process.platform): Launch {
  if (platform === "win32" && /\.(cmd|bat)$/i.test(program)) {
    return { command: cmdQuote(program), args: args.map(cmdQuote), shell: true };
  }
  return { command: program, args, shell: false };
}
