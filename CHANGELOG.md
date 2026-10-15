# Changelog

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
