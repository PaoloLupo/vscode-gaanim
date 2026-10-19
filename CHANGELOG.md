# Changelog

## 0.15.0

Gaanim workspaces: several projects in one repository that share Python
code, assets and one `.venv`. The extension asks `gaanim project --json`
what each file belongs to and keeps the answer until a `gaanim.toml` is
written; without `gaanim project` it works per project, as before.

- A workspace's own `gaanim.toml` is no longer read as a video project with a
  missing `main.py`. A member's file belongs to its member; shared modules run
  as the active member (the one whose files were opened last, or the only
  one), and preview, check, live, the status bar and the times in the code
  come from it. With none yet, a command asks which member and runs again. A
  script that imports gaanim outside the shared folders stays its own project.
- The interpreter is the workspace's `.venv`, so Check Setup no longer warns
  "No .venv in the project" for a member. The folders of `sys.path` that
  Pylance does not find on its own go to `python.analysis.extraPaths`, with
  the same consent as the interpreter.
- *Check All Members*: one `gaanim check` of the workspace, each member's
  problems on its files, invalid manifests with their error, and
  "N of M members passed".
- *Export All Members…* writes each member to `gaanim.workspace.output`
  (`exports/{member}`).
- The Projects view lists a workspace as one entry, its members grouped by
  `group` and invalid ones marked; *New Workspace…*, and *New Video* and *New
  Presentation* inside a workspace beside the members of their kind, with
  Gaanim's warning when `members` leaves the new folder out.
- Asset names resolve, complete (marked shared) and are checked in the
  workspace's shared asset folders.
- Check Setup shows the workspace, its members, the interpreter and
  `sys.path`.
- A `gaanim.toml` that names neither a project nor a workspace (only
  `assets_dir`) is skipped when looking for a file's project, as Gaanim does.

## 0.13.0

First release, for Gaanim 0.13: everything gaanim.nvim does, in VS Code.

- Times of plays, stops, segments, markers and voiceovers as inlay hints;
  lenses over each slide (Preview, Loop, Still, spoken time, time range);
  hovers, code actions, document symbols, asset and Typst math completion,
  missing asset warnings.
- The preview driven through `--listen stdio`: preview at the cursor without
  a restart, follow the cursor, loop a slide, play, pause, move it to a slide,
  stop or time; the playhead and the animating lines marked in the code.
- Live mode, number nudges, `gaanim check` on save as problems, failed
  reloads on their line, exports with cancellable progress, stills, slide
  ranges, presenting with a countdown and a monitor.
- The narration script beside the code: follows the cursor and the preview,
  jumps both ways, adds missing sections, shows spoken time against targets.
- Gaanim side bar (timeline and projects), Preview Timeline panel, take
  inspector for `vo.wait_until`, script-to-code, docs of the installed
  Gaanim, Check Setup, the project's `.venv` for Python completion.
