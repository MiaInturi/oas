import { isObject } from './guards.js';

export function createSchemaFingerprint(schema: Record<string, unknown>): string {
  const normalized = normalizeForFingerprint(schema, true, new WeakSet<object>());

  return JSON.stringify(normalized);
}

function normalizeForFingerprint(value: unknown, isRoot: boolean, seen: WeakSet<object>): unknown {
  if (!isObject(value)) {
    return value;
  }

  if (seen.has(value)) {
    return '[Circular]';
  }

  seen.add(value);

  if (Array.isArray(value)) {
    const normalized = value.map(entry => normalizeForFingerprint(entry, false, seen));
    seen.delete(value);

    return normalized;
  }

  const result: Record<string, unknown> = {};
  Object.entries(value)
    .filter(([key]) => !(isRoot && (key === 'description' || key === 'summary')))
    .sort(([left], [right]) => left.localeCompare(right))
    .forEach(([key, entry]) => {
      result[key] = normalizeForFingerprint(entry, false, seen);
    });

  seen.delete(value);

  return result;
}
