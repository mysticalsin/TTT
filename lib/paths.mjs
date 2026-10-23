// Where Claude Code keeps transcripts, and where TTT keeps its cache.
import os from 'node:os';
import path from 'node:path';

export function claudeHome() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

export function projectsRoot() {
  return process.env.TTT_PROJECTS_DIR || path.join(claudeHome(), 'projects');
}

export function cacheRoot() {
  return process.env.TTT_CACHE_DIR || path.join(os.homedir(), '.cache', 'ttt');
}

/** Claude Code's folder name for a cwd: every non-alphanumeric char becomes "-". */
export function slugForCwd(cwd) {
  return path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

/** Resolve the transcript folder for a cwd, a slug, or a transcript path. */
export function projectDirFor({ cwd, transcriptPath, slug } = {}) {
  if (transcriptPath) {
    // <root>/<slug>/<session>.jsonl  or  <root>/<slug>/<session>/subagents/agent-x.jsonl
    const rel = path.relative(projectsRoot(), transcriptPath);
    if (!rel.startsWith('..')) return path.join(projectsRoot(), rel.split(path.sep)[0]);
    return path.dirname(transcriptPath);
  }
  return path.join(projectsRoot(), slug || slugForCwd(cwd || process.cwd()));
}

/** Best-effort human name: "-Users-tony-Documents-Projects-TTT" -> "TTT". */
export function prettyName(slugOrCwd) {
  const base = path.basename(String(slugOrCwd));
  const parts = base.split('-').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : base;
}
