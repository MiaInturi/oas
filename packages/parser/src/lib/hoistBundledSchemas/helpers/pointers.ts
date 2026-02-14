import { isRecord } from './guards.js';

export function encodeJsonPointerToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

export function decodeJsonPointerToken(token: string): string {
  try {
    return decodeURIComponent(token).replace(/~1/g, '/').replace(/~0/g, '~');
  } catch {
    return token.replace(/~1/g, '/').replace(/~0/g, '~');
  }
}

export function isComponentSchemaRootPointer(pointer: string): boolean {
  return /^#\/components\/schemas\/[^/]+$/u.test(pointer);
}

export function resolveLocalPointer(root: unknown, pointer: string): unknown {
  if (pointer === '#') {
    return root;
  }

  if (!pointer.startsWith('#/')) {
    return undefined;
  }

  const tokens = pointer
    .slice(2)
    .split('/')
    .map(token => decodeJsonPointerToken(token));

  let current: unknown = root;

  for (const token of tokens) {
    if (Array.isArray(current)) {
      const index = Number(token);
      if (!Number.isInteger(index)) {
        return undefined;
      }

      current = current[index];
      continue;
    }

    if (!isRecord(current)) {
      return undefined;
    }

    current = current[token];
  }

  return current;
}
