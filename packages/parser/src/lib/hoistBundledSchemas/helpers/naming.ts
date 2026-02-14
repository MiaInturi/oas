import nodePath from 'node:path';

import { IGNORED_POINTER_NAME_TOKENS } from './constants.js';
import { decodeJsonPointerToken } from './pointers.js';

export function createSchemaNameFromSourcePath(sourcePath: string): string {
  const fileName = nodePath.basename(sourcePath);
  const withoutExtension = fileName.replace(/\.[^./\\]+$/u, '');
  const normalized = withoutExtension.replace(/[^a-zA-Z0-9._-]/g, '-');

  return normalized || 'Schema';
}

export function createSchemaNameFromPointer(pointer: string): string {
  const tokens = pointer
    .slice(2)
    .split('/')
    .map(token => decodeJsonPointerToken(token));

  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const token = tokens[i];
    if (
      !token ||
      /^\d+$/u.test(token) ||
      token.includes('/') ||
      IGNORED_POINTER_NAME_TOKENS.has(token) ||
      token.startsWith('application/')
    ) {
      continue;
    }

    return normalizeComponentName(token);
  }

  return tokens.length ? normalizeComponentName(tokens[tokens.length - 1]) : 'Schema';
}

export function normalizeComponentName(name: string): string {
  const withoutExtension = name.replace(/\.[^./\\]+$/u, '');
  const sanitized = withoutExtension.replace(/[^a-zA-Z0-9]+/g, ' ').trim();
  if (!sanitized) {
    return 'Schema';
  }

  return sanitized
    .split(/\s+/u)
    .filter(Boolean)
    .map(part => part[0].toUpperCase() + part.slice(1))
    .join('');
}

export function createUniqueSchemaName(baseName: string, names: Set<string>): string {
  const safeBaseName = baseName || 'Schema';
  let uniqueName = safeBaseName;
  let index = 2;

  while (names.has(uniqueName)) {
    uniqueName = `${safeBaseName}_${index}`;
    index += 1;
  }

  names.add(uniqueName);

  return uniqueName;
}
