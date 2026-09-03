import assert from 'node:assert/strict';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createGitignoreEntryFilter } from './gitignore.js';

test('gitignore-aware walkers skip ignored files and do not enter ignored directories', async () => {
  const projectRoot = path.resolve('tmp/cloudcli/gitignore-walker-project');
  await fsPromises.rm(projectRoot, { recursive: true, force: true });
  await fsPromises.mkdir(path.join(projectRoot, 'ignored-dir', 'nested'), { recursive: true });
  await fsPromises.mkdir(path.join(projectRoot, 'src'), { recursive: true });
  await fsPromises.writeFile(path.join(projectRoot, '.gitignore'), 'ignored-dir/\n*.log\n');
  await fsPromises.writeFile(path.join(projectRoot, 'ignored-dir', 'nested', 'secret.txt'), 'secret');
  await fsPromises.writeFile(path.join(projectRoot, 'debug.log'), 'ignored');
  await fsPromises.writeFile(path.join(projectRoot, 'src', 'index.ts'), 'included');

  try {
    const includeEntry = createGitignoreEntryFilter(
      projectRoot,
      await fsPromises.readFile(path.join(projectRoot, '.gitignore'), 'utf8'),
    );
    const visitedDirectories = [];
    const files = [];

    const walk = async (directoryPath) => {
      visitedDirectories.push(path.relative(projectRoot, directoryPath) || '.');
      const entries = await fsPromises.readdir(directoryPath, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = path.join(directoryPath, entry.name);
        if (!includeEntry(entryPath, entry.isDirectory())) {
          continue;
        }
        if (entry.isDirectory()) {
          await walk(entryPath);
        } else {
          files.push(path.relative(projectRoot, entryPath));
        }
      }
    };

    await walk(projectRoot);

    assert.deepEqual(visitedDirectories, ['.', 'src']);
    assert.deepEqual(files, ['.gitignore', 'src/index.ts']);
  } finally {
    await fsPromises.rm(projectRoot, { recursive: true, force: true });
  }
});
