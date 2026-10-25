![Gaanim for VS Code](images/banner.png)

# Gaanim for VS Code

Write [Gaanim](https://paololupo.github.io/gaanim/) videos and slides in VS
Code. The extension drives the `gaanim` command: it creates projects, keeps
the live preview on the line you are editing, puts problems on their lines,
exports, presents, and keeps the narration script beside the code. It brings
everything [gaanim.nvim](https://github.com/PaoloLupo/gaanim.nvim) does to VS
Code, and uses Gaanim's editor channel (`--listen`), JSON messages,
`gaanim inspect` and, for workspaces, `gaanim project`.

| Command | What it does |
|---|---|
| **Gaanim: New Project…** | `gaanim init` a slides or video project and open it |
| **Gaanim: New Workspace…** | `gaanim init workspace`: several projects that share code, assets and Python |
| **Gaanim: Check All Members** | one `gaanim check` of the workspace, each member's problems on its lines |
| **Gaanim: Preview at Cursor** | the preview rests at the instant of the cursor's line, without a restart; in the script, at the stop where the line is said |
| **Gaanim: Toggle Preview Follows Cursor** | the preview follows the cursor through the code |
| **Gaanim: Toggle Live Mode** | saves as you type, so every change reaches the preview |
| **Gaanim: Toggle Loop of the Slide at Cursor** | plays the slide over and over, across reloads |
| **Gaanim: Open Narration Script Beside** | `narration/script.md` beside the code, on the slide you are on |
| **Gaanim: Export Still at Cursor** | a PNG of the cursor's instant, opened beside the code |
| **Gaanim: Export the Slide at Cursor…** | any preset limited to the slide under the cursor |
| **Gaanim: Present…** | from the start or the cursor, with a countdown and a monitor |

## What it does

- **Times in the code.** The time of each `play`, `stop`, segment, marker
  and voiceover at the end of its line (`▤ 0:00.0–0:01.0 · 1.0s`,
  `⏸ 0:01.3`), from the timeline Gaanim reports. An open preview sends it
  with every reload, so nothing runs twice; without one, `gaanim inspect`
  runs after a save. The status bar shows the cursor's instant.
- **Lenses over each slide**: `▶ Preview`, `⟲ Loop` (or `Unloop` while it
  loops), `Still`, how long its script takes to say against its `target=`
  (`≈0:42 / 1:00`, or *Write script*) and its time range; over each
  voiceover, whether its take is recorded and how long it is.
- **Hovers**: what a line makes on the timeline; the size, pixels or length
  of an asset file; where a `vo.wait_until("word")` lands in its take.
- **Code actions**: write a slide's missing script, name an unnamed stop, add
  a marker, preview the line, export its frame or its slide as a draft.
- **Outline and breadcrumbs**: slides with their stops, markers and
  voiceovers as document symbols. *Next/Previous Slide* and *Stop* move the
  cursor between them; *Go to Slide, Stop or Marker…* and *Go to Timeline
  Entry…* jump across the project and move the preview there.
- **Completion** of asset names inside `media.image("…")`, `svg`, `audio`,
  `video`… and of Typst math inside `equation(...)` strings and `$…$`: every
  codex 0.3.0 symbol with the character it draws (`α alpha`,
  `⇒ arrow.r.double`, `.` for variants), math functions as snippets,
  accents, operators and spaces.
- **Problems on their lines.** Saving runs `gaanim check` in the background;
  a failed reload puts the Python error on its line. Asset names that resolve
  to no file get a warning.
- **The preview, driven from the code.** Where the preview rests is marked in
  the code; while it plays, the lines whose `play` animates are highlighted.
  Gaanim's own *Open in the editor* (inspector, console, animation timeline,
  error panel, *Open and complete*) opens the line in this window.
- **Narration script.** The script beside the code follows the slide under
  the cursor, or the slide the preview shows. Where the cursor or the preview
  rests it shows the text said there (on a stop, the text before its mark);
  while the preview plays through a slide's stops it stays put, since that
  text goes on being said after the stop. Lenses over each `##` heading and
  `[stop]` mark move the preview to that slide or stop, or go to its code.
  *Go Between Slide and Its Script* jumps both ways and adds a missing
  section with a `[stop]` mark per stop. Each section shows how long it takes
  to say against its slide's `target=` (green, amber, red), and the title the
  whole talk against `scene.slides.target()`.
- **Exports** with a cancellable progress bar in percent: MP4, draft,
  production, WebM, MOV, GIF, WebP, PDF, PDF with notes, `.gaanim` bundle, a
  bundle made lighter for the web (`gaanim pack --web`), and stills.
- **Nudging numbers** (`Ctrl+Alt+A` / `Ctrl+Alt+X`): `0.8` → `0.9`,
  `0.25` → `0.26`; with live mode each nudge shows in the preview.
- **Docs of the installed Gaanim**: *Search Documentation…* and *Open API
  Entry at Cursor* read the docs bundled with the project's `.venv`, so they
  match its version.
- **Python completion**: points the Python extension at the project's
  `.venv`, where `gaanim init` installed the authoring package and its stubs.
- **Snippets**: `gslides`, `gvideo`, `gseg`, `gstop`, `gplay`, `gvo`,
  `gmark`, `gwait` in Python; `gsec`, `gstop`, `gnote` in Markdown.
- **Check Setup** reports `gaanim` and what it supports, FFmpeg, uv, the
  Python extension, the project's `.venv`, docs and script.

### Workspaces

A [workspace](https://paololupo.github.io/gaanim/guias/proyectos/#workspaces)
is several projects in one repository that share Python code, assets and one
`.venv`: a `gaanim.toml` with a `[workspace]` table at the root says where
its members are and what they share. The extension asks
`gaanim project <file> --json` in the background what each file belongs to,
without running Python, and keeps the answer until a `gaanim.toml` is
written. It needs a Gaanim with `gaanim project`; without it everything works
per project, as before.

- **Members and shared modules.** A member's file belongs to that member. The
  workspace's own files, the shared modules above all, run as the *active
  member*: the one whose files you opened last (or the only one). Preview,
  check, live, the status bar and the times in the code come from it; the
  status bar shows which member it is, and a click picks another. With no
  member opened yet, a command asks which one and runs again. A script that
  imports gaanim outside the shared folders stays a project of its own.
  Saving a shared module marks every member's timeline stale.
- **Python.** The interpreter is the workspace's `.venv` (or a member's own),
  with the same consent as a project's (`gaanim.python.useProjectEnvironment`).
  The folders of the member's `sys.path` that Pylance does not search on its
  own (it already searches the window's root and its `src`) are added to
  `python.analysis.extraPaths` in the folder's settings, after yours, so the
  shared code completes. `python.analysis.extraPaths` is one list for the
  whole folder, so it grows with the members you open.
- **Check All Members** runs one `gaanim check` of the workspace: each member
  gets its own problems, an invalid manifest its error, and a summary says
  `2 of 3 members passed · failed: videos/outro`.
- **Export All Members…** exports each member with a preset to
  `gaanim.workspace.output` (`exports/{member}`, so `exports/videos/intro.mp4`);
  a member's own *Export…* goes to its `output_dir` as usual.
- **Projects view.** A workspace is one entry with its members grouped by
  `group`, invalid ones in red with their error and the last check's result,
  with *New Video*, *New Presentation*, *Check All Members* and *Export All
  Members…*; on a member, *Check*, *Export…* and *Run Shared Files as This
  Member*. The workspace open in the window heads the list even without
  `gaanim.projectsDir`.
- **New.** *New Workspace…* runs `gaanim init workspace`. Inside a workspace,
  *New Project…*, *New Video* and *New Presentation* create a member beside
  the others of its kind (`gaanim init video videos/ep2`) and show Gaanim's
  warning when `members` leaves it out.
- **Assets.** Names resolve, complete (marked *shared*) and are checked in the
  workspace's shared asset folders too, after the member's own.
- **Check Setup** shows the workspace, its members, the active one, the
  interpreter and the folders of `sys.path`.

### Beyond gaanim.nvim

- **Gaanim side bar**: the project's real timeline as a tree (times,
  stops, markers, voiceovers; click to go there and move the preview, with
  Preview, Loop, Still, Export and Script on each entry), and your projects.
- **Preview Timeline panel**: the scene to scale (slides, stops, markers,
  voiceovers, the loop and the playhead) with play, loop, follow, live and
  still buttons. Click to move the preview, Alt+click to loop a slide,
  double-click to open its code.
- **Take inspector**: each `vo.wait_until("…")` and `vo.until("…")` is
  resolved the way Gaanim does (tapped mark, transcript, proportional place in
  the script); a word that lands nowhere gets a warning, and one that falls
  back to the script's proportion an information.
- **Script to code**: *Add the Script's Missing Slides to the Code* writes the
  `segment` (slides) or `voiceover` (video) calls that the script's `##`
  sections ask for, with a stop per `[stop]` mark.
- **Present…** asks where to start, how long the talk lasts and which
  monitor to use; stills open beside the code.
- File paths reach the preview the way Python spells them, so following the
  cursor works on Windows whatever the drive letter's case.

## Requirements

- VS Code 1.90 or newer (or Cursor, VSCodium).
- `gaanim` on `PATH`, or `gaanim.path` set. Gaanim 0.15 has everything
  (workspaces need its `gaanim project`); older versions work with less (see
  below).
- The Python extension (with Pylance or basedpyright) for completion of the
  Gaanim API.

The extension reads `gaanim --help` once and uses what the installed version
offers. Driving the preview (*Preview at Cursor* without a restart, *Follow*,
*Loop*, *Move Preview To…*, the playhead) needs `--listen`; exact problem
lines and export percent need `--message-format json`; times in the code and
the timeline need `inspect`; stills and ranges by slide name need `export` to
take names. Without them *Preview at Cursor* restarts the preview from the
cursor's slide and the rest reads the CLI's text.

## Keys

All under `Ctrl+Alt+G` (`Cmd+Alt+G` on macOS), in a Gaanim project:

| Then | Command | Then | Command |
|---|---|---|---|
| `P` | Preview at Cursor | `I` | Export Still at Cursor |
| `F` | Follow the cursor | `E` | Export… |
| `L` | Live mode | `C` | Check Project |
| `R` | Loop the slide | `T` | Narration script |
| `Space` | Play or pause | `G` | Slide ↔ script |
| `S` | Timeline entries | `K` | API entry at cursor |
| `Shift+P` | Present… | `Q` | Close preview |
| `↓` / `↑` | Next / previous slide | | |

## Settings

| Setting | Default | |
|---|---|---|
| `gaanim.path` | `gaanim` | the executable |
| `gaanim.projectsDir` | | where new projects go and the Projects view looks |
| `gaanim.preview.listen` | `true` | drive the preview with `--listen stdio` |
| `gaanim.preview.editor` | `true` | Gaanim's *Open in the editor* opens lines here |
| `gaanim.preview.followDelay` | `120` | ms the cursor settles before a following preview moves |
| `gaanim.present.duration` | | planned length (`20m`) |
| `gaanim.check.onSave` | `true` | check after saving |
| `gaanim.export.open` | `stills` | open stills beside the code, offer the rest |
| `gaanim.export.presets` | | extra or changed presets |
| `gaanim.script.wpm` | `150` | words per minute for spoken time |
| `gaanim.outline.patterns` | | teach the outline a project's own way of naming slides |
| `gaanim.live.delay` | `700` | ms after the last change before live mode saves |
| `gaanim.python.useProjectEnvironment` | `ask` | point the Python extension at the `.venv`, and Pylance at a workspace's shared code |
| `gaanim.workspace.output` | `exports/{member}` | where *Export All Members* writes, relative to the workspace |

`gaanim.outline.patterns` covers decks with one module per slide, such as
`NAME = "Cover"` in each:

```json
"gaanim.outline.patterns": [{ "kind": "segment", "pattern": "\\nNAME\\s*=\\s*\"([^\"]+)\"" }]
```

The timeline view needs none of this: it lists what the scene really made.

## Develop

```
npm install
npm run build          # dist/extension.js
npm test               # unit tests of the parsers, without VS Code
npm run package        # gaanim-<version>.vsix
```

`npm run test:integration` runs `test/integration/suite.ts` (a project) and
`test/integration/workspace.ts` (a copy of `test/fixtures/channel`) inside VS
Code against a stand-in `gaanim`; with `GAANIM_TEST_BIN` (a real `gaanim`)
and `GAANIM_TEST_PROJECT` (a project from `gaanim init`) it drives the real
one, whose preview needs a display and a GPU (Xvfb and Mesa's lavapipe work).
`GAANIM_TEST_WORKSPACE`, a copy of `test/fixtures/channel` with a `.venv`,
adds the workspace suite to a real run; `GAANIM_TEST_ONLY=project` or
`workspace` runs one suite. `test/fixtures/channel.project.json` and
`channel.check.jsonl` are what Gaanim printed for the fixture.
`scripts/gen_typst_symbols.py` regenerates the Typst symbol table from codex.
