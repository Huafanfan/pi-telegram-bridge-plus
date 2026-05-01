import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { displayProject, ensureProjectDirectory, resolveProjectPath } from './project.js';

describe('project path helpers', () => {
  it('resolves empty input to workspace root', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pi-bridge-root-'));
    try {
      assert.equal(resolveProjectPath(root, ''), path.resolve(root));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves relative project paths inside workspace root', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pi-bridge-root-'));
    try {
      assert.equal(resolveProjectPath(root, 'app'), path.join(root, 'app'));
      assert.equal(displayProject(root, path.join(root, 'app')), 'app');
      assert.equal(displayProject(root, root), '.');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects paths outside workspace root', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pi-bridge-root-'));
    try {
      assert.throws(() => resolveProjectPath(root, '..'), /Project must stay inside WORKSPACE_ROOT/);
      assert.throws(() => resolveProjectPath(root, path.dirname(root)), /Project must stay inside WORKSPACE_ROOT/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('ensures project exists and is a directory', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pi-bridge-root-'));
    try {
      const dir = path.join(root, 'app');
      const file = path.join(root, 'file.txt');
      mkdirSync(dir);
      writeFileSync(file, 'not a directory');

      assert.doesNotThrow(() => ensureProjectDirectory(dir));
      assert.throws(() => ensureProjectDirectory(path.join(root, 'missing')), /Project does not exist/);
      assert.throws(() => ensureProjectDirectory(file), /Project is not a directory/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
