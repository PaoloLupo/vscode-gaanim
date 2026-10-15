// The project's timeline, from a preview's `ready` or from `gaanim inspect --json`.

import * as cli from "./cli";
import { findTimeline, Timeline } from "./core/timeline";
import { timelineChanged } from "./events";
import type { Project } from "./project";

interface Entry {
  data?: Timeline;
  stale: boolean;
  waiting?: ((data: Timeline | undefined) => void)[];
  fallback?: NodeJS.Timeout;
}

const cache = new Map<string, Entry>();

/** Whether a running preview of the project sends its timeline with each `ready`. */
let previewSends: (root: string) => boolean = () => false;

export function setPreviewSends(check: (root: string) => boolean): void {
  previewSends = check;
}

function entryFor(root: string): Entry {
  let entry = cache.get(root);
  if (!entry) {
    entry = { stale: true };
    cache.set(root, entry);
  }
  return entry;
}

function deliver(root: string, entry: Entry, data: Timeline | undefined): void {
  if (entry.fallback) {
    clearTimeout(entry.fallback);
    entry.fallback = undefined;
  }
  const waiting = entry.waiting ?? [];
  entry.waiting = undefined;
  for (const callback of waiting) {
    callback(data ?? entry.data);
  }
  timelineChanged.fire(root);
}

function runInspect(project: Project, entry: Entry): void {
  const job = cli.run(["inspect", project.target, "--json"], {
    cwd: project.root,
    key: `inspect:${project.root}`,
    onExit: (_code, _lines, objects) => {
      const data = findTimeline(objects);
      if (data) {
        entry.data = data;
        entry.stale = false;
      }
      deliver(project.root, entry, data);
    },
  });
  if (!job) {
    deliver(project.root, entry, undefined);
  }
}

/** The cached timeline, even when a save made it stale. */
export function cached(project: Project): Timeline | undefined {
  return cache.get(project.root)?.data;
}

export function isStale(project: Project): boolean {
  return cache.get(project.root)?.stale ?? true;
}

/** Takes the timeline a preview sent with `ready`: it is fresh, and whoever waits gets it. */
export function store(project: Project, data: Timeline): void {
  const entry = entryFor(project.root);
  entry.data = data;
  entry.stale = false;
  deliver(project.root, entry, data);
}

/**
 * The project's timeline. When the cache is stale it waits for the next
 * `ready` of a preview that sends timelines (running `inspect` if none comes
 * within a few seconds), else runs `inspect`. Without either it resolves to
 * the cached timeline or undefined.
 */
export async function get(project: Project): Promise<Timeline | undefined> {
  const entry = entryFor(project.root);
  if (entry.data && !entry.stale) {
    return entry.data;
  }
  if (entry.waiting) {
    return new Promise((resolve) => entry.waiting!.push(resolve));
  }
  const canInspect = (await cli.caps()).inspect;
  if (entry.waiting) {
    return new Promise((resolve) => entry.waiting!.push(resolve));
  }
  return new Promise((resolve) => {
    if (previewSends(project.root)) {
      entry.waiting = [resolve];
      entry.fallback = setTimeout(() => {
        entry.fallback = undefined;
        if (entry.waiting && canInspect) {
          runInspect(project, entry);
        } else if (entry.waiting) {
          deliver(project.root, entry, undefined);
        }
      }, 5000);
      return;
    }
    if (!canInspect || !cli.executable(true)) {
      resolve(entry.data);
      return;
    }
    entry.waiting = [resolve];
    runInspect(project, entry);
  });
}

/** Marks a project's timeline stale after a save. */
export function invalidate(root: string): void {
  const entry = cache.get(root);
  if (entry && !entry.stale) {
    entry.stale = true;
    timelineChanged.fire(root);
  }
}

const timers = new Map<string, NodeJS.Timeout>();

/** Once saves settle, fetches the new timeline (from the preview's next `ready`, else `inspect`). */
export function refreshSoon(project: Project, delay = 600): void {
  clearTimeout(timers.get(project.root));
  timers.set(
    project.root,
    setTimeout(() => {
      timers.delete(project.root);
      void get(project);
    }, delay),
  );
}
