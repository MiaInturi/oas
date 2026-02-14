import type { OpenAPIV3, OpenAPIV3_1 } from 'openapi-types';
import type { SchemaRegistry } from './types.js';

import { isObject } from './guards.js';
import { createUniqueSchemaName } from './naming.js';
import { encodeJsonPointerToken, isComponentSchemaRootPointer } from './pointers.js';
import { walk } from './walk.js';

// Build per-run component registry state from `components.schemas`.
// Example: existing `components.schemas.Error` is indexed so later passes can reuse
// `#/components/schemas/Error` instead of creating duplicates.
export function createSchemaRegistry(schema: OpenAPIV3.Document | OpenAPIV3_1.Document): SchemaRegistry {
  if (!schema.components) {
    schema.components = {};
  }

  const components = schema.components as Record<string, unknown>;

  if (!components.schemas) {
    components.schemas = {};
  }

  const componentSchemas = components.schemas as Record<string, unknown>;

  const schemaNames = new Set<string>(Object.keys(componentSchemas));
  const schemaPointersByValue = new WeakMap<object, string>();

  Object.entries(componentSchemas).forEach(([name, value]) => {
    if (isObject(value)) {
      schemaPointersByValue.set(value, `#/components/schemas/${encodeJsonPointerToken(name)}`);
    }
  });

  return {
    schemaNames,
    schemaPointersByValue,
    componentSchemas,
  };
}

// Register a schema object under `components.schemas` and return its stable pointer.
// Example: first registration of `Pet` returns `#/components/schemas/Pet`; another registration
// request for the same object returns the same pointer.
export function registerSchemaInComponents(registry: SchemaRegistry, schema: object, preferredName: string): string {
  const existingPointer = registry.schemaPointersByValue.get(schema);
  if (existingPointer) {
    return existingPointer;
  }

  const uniqueName = createUniqueSchemaName(preferredName, registry.schemaNames);
  const pointer = `#/components/schemas/${encodeJsonPointerToken(uniqueName)}`;

  registry.componentSchemas[uniqueName] = schema;
  registry.schemaPointersByValue.set(schema, pointer);

  return pointer;
}

// Final dedupe pass: if a schema object already has a component identity, replace inline usage
// with a `$ref`.
// Example: inline `{ type: 'string', pattern: ... }` already mapped as `Id` becomes
// `{ $ref: '#/components/schemas/Id' }`.
export function replaceHoistedObjectsWithRefs(root: unknown, registry: SchemaRegistry): void {
  walk(root, false, '#', new WeakSet<object>(), (value, pointer, inSchemaContext, parent, parentKey) => {
    if (!inSchemaContext || !parent || parentKey === undefined) {
      return;
    }

    const componentPointer = registry.schemaPointersByValue.get(value);
    if (!componentPointer || pointer === componentPointer || isComponentSchemaRootPointer(pointer)) {
      return;
    }

    const replacement = { $ref: componentPointer };
    if (Array.isArray(parent)) {
      parent[parentKey as number] = replacement;
    } else {
      parent[parentKey as string] = replacement;
    }
  });
}
