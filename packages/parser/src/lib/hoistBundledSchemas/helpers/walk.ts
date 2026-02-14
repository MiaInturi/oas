import { SCHEMA_CONTEXT_KEYS } from './constants.js';
import { isObject, isRecord } from './guards.js';
import { encodeJsonPointerToken } from './pointers.js';

export type WalkVisitor = (
  value: object,
  pointer: string,
  inSchemaContext: boolean,
  parent?: Record<string, unknown> | unknown[],
  parentKey?: string | number,
) => void;

export function walk(
  value: unknown,
  inSchemaContext: boolean,
  pointer: string,
  seen: WeakSet<object>,
  visitor: WalkVisitor,
  parent?: Record<string, unknown> | unknown[],
  parentKey?: string | number,
): void {
  if (!isObject(value)) {
    return;
  }

  visitor(value, pointer, inSchemaContext, parent, parentKey);

  if (seen.has(value)) {
    return;
  }

  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      const childPointer = `${pointer}/${encodeJsonPointerToken(String(index))}`;
      walk(item, inSchemaContext, childPointer, seen, visitor, value, index);
    });
  } else if (isRecord(value)) {
    Object.entries(value).forEach(([key, child]) => {
      const childPointer = `${pointer}/${encodeJsonPointerToken(key)}`;
      const childInSchemaContext = inSchemaContext || SCHEMA_CONTEXT_KEYS.has(key);
      walk(child, childInSchemaContext, childPointer, seen, visitor, value, key);
    });
  }

  seen.delete(value);
}
