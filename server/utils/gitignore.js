import path from 'node:path';

import ignore from 'ignore';

/**
 * Build a synchronous filter for file-tree entries from a project's
 * .gitignore contents. Directory paths include a trailing slash so directory
 * rules (for example, `coverage/`) prevent traversal into the ignored tree.
 */
export function createGitignoreEntryFilter(projectRoot, gitignoreContent) {
  const gitignore = ignore().add(gitignoreContent);

  return (entryPath, isDirectory) => {
    const relativePath = path.relative(projectRoot, entryPath).split(path.sep).join('/');
    const matchPath = isDirectory ? `${relativePath}/` : relativePath;
    return !gitignore.ignores(matchPath);
  };
}
