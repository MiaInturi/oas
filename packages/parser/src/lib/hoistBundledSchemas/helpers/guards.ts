import { LIKELY_SCHEMA_KEYS } from './constants.js';

export function isObject(value: unknown): value is object {
  return !!value && typeof value === 'object';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return isObject(value) && !Array.isArray(value);
}

export function isLikelySchemaObject(value: Record<string, unknown>): boolean {
  return LIKELY_SCHEMA_KEYS.some(key => key in value);
}
