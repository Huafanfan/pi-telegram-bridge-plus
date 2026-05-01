import path from 'node:path';
import fs from 'node:fs';

export function resolveProjectPath(workspaceRoot: string, input: string): string {
  const root = path.resolve(expandHome(workspaceRoot));
  const raw = input.trim();
  if (!raw) return root;

  const candidate = path.isAbsolute(raw) ? path.resolve(expandHome(raw)) : path.resolve(root, raw);
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Project must stay inside WORKSPACE_ROOT (${root})`);
  }
  return candidate;
}

export function ensureProjectDirectory(projectPath: string): void {
  if (!fs.existsSync(projectPath)) {
    throw new Error(`Project does not exist: ${projectPath}`);
  }
  const stat = fs.statSync(projectPath);
  if (!stat.isDirectory()) {
    throw new Error(`Project is not a directory: ${projectPath}`);
  }
}

export function displayProject(workspaceRoot: string, projectPath: string): string {
  const root = path.resolve(expandHome(workspaceRoot));
  const resolved = path.resolve(expandHome(projectPath));
  const relative = path.relative(root, resolved);
  return relative ? relative : '.';
}

function expandHome(value: string): string {
  if (value === '~') return process.env.HOME ?? value;
  if (value.startsWith('~/')) return path.join(process.env.HOME ?? '', value.slice(2));
  return value;
}
