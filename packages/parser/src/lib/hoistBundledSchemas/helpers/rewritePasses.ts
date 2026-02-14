import type { ParserOptions as $RefParserOptions } from '@apidevtools/json-schema-ref-parser';
import type { ExternalSchemaNameResolver, SchemaRegistry } from './types.js';

import { REF_REPLACEMENT_ALLOWED_KEYS } from './constants.js';
import {
  buildExternalComponentFingerprintIndex,
  resolveExternalComponentCandidate,
  resolveExternalSchemaCandidate,
} from './externalResolver.js';
import { isRecord } from './guards.js';
import { createSchemaNameFromPointer } from './naming.js';
import { isComponentSchemaRootPointer, resolveLocalPointer } from './pointers.js';
import { registerSchemaInComponents } from './registry.js';
import {
  ensureComponentPointerForSourcePath,
  ensureExternalSchemaForSourcePath,
  looksLikeExternalFileReference,
  resolveDiscriminatorMappingPointer,
  resolveSourcePathFromSourceRef,
} from './sourceResolution.js';
import { walk } from './walk.js';

// Collect schema objects that came from external roots and are used in schema-context locations.
// Example: external `Pet.yaml` object referenced from a response schema gets captured for hoisting.
export function collectSchemaTargets(
  root: unknown,
  externalSchemas: Map<object, string>,
): Array<{ sourcePath: string; value: Record<string, unknown> }> {
  const found = new Map<object, string>();

  walk(root, false, '#', new WeakSet<object>(), (value, pointer, inSchemaContext) => {
    if (!inSchemaContext || !externalSchemas.has(value) || pointer.startsWith('#/components/schemas/')) {
      return;
    }

    if (!found.has(value)) {
      found.set(value, externalSchemas.get(value) as string);
    }
  });

  return [...found.entries()]
    .map(([value, sourcePath]) => ({ value: value as Record<string, unknown>, sourcePath }))
    .sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
}

// Rewrite local refs that still point into document structure (`#/paths/...`) so they point to
// `#/components/schemas/...`.
// Example: `#/paths/~1pets/get/.../schema` -> `#/components/schemas/Pet`.
export function rewriteLocalSchemaRefsToComponents(
  root: unknown,
  registry: SchemaRegistry,
  externalNameResolver: ExternalSchemaNameResolver,
): void {
  walk(root, false, '#', new WeakSet<object>(), (value, _pointer, inSchemaContext) => {
    if (!inSchemaContext || !isRecord(value) || typeof value.$ref !== 'string') {
      return;
    }

    const ref = value.$ref;
    if (!ref.startsWith('#/') || ref.startsWith('#/components/schemas/')) {
      return;
    }

    const resolved = resolveLocalPointer(root, ref);
    if (!isRecord(resolved)) {
      return;
    }

    const externalMatch = resolveExternalSchemaCandidate(resolved, externalNameResolver);
    const preferredName = externalMatch?.name || createSchemaNameFromPointer(ref);
    const schemaForComponent = externalMatch?.schema || resolved;

    const componentPointer = registerSchemaInComponents(registry, schemaForComponent, preferredName);
    if (ref !== componentPointer) {
      value.$ref = componentPointer;
    }
  });
}

// Replace inline schema objects that match known external schemas with component refs.
//
// Why inline objects are common after bundle:
// - `$ref` targets from other files can be materialized as full objects
// - composed schemas can copy/clone parts of other schemas
// - equivalent schemas may lose object identity across transforms
//
// Matching strategy:
// 1) try identity/canonical match against resolver state
// 2) fallback to fingerprint match against already-hoisted external components
//
// Example: an inline object equivalent to `User.yaml` becomes
// `{ $ref: '#/components/schemas/User' }`.
export function rewriteInlineExternalSchemasToComponentRefs(
  root: unknown,
  registry: SchemaRegistry,
  resolver: ExternalSchemaNameResolver,
): void {
  let changed = true;

  while (changed) {
    changed = false;
    const externalComponentFingerprints = buildExternalComponentFingerprintIndex(registry, resolver);

    walk(root, false, '#', new WeakSet<object>(), (value, pointer, inSchemaContext, parent, parentKey) => {
      if (
        !inSchemaContext ||
        isComponentSchemaRootPointer(pointer) ||
        !parent ||
        parentKey === undefined ||
        !isRecord(value)
      ) {
        return;
      }

      const matched = resolveExternalSchemaCandidate(value, resolver);
      const componentMatched = !matched
        ? resolveExternalComponentCandidate(value, externalComponentFingerprints)
        : undefined;
      const selected = matched || componentMatched;

      if (!selected) {
        return;
      }

      const componentPointer = registerSchemaInComponents(registry, selected.schema, selected.name);

      const replacement: Record<string, unknown> = { $ref: componentPointer };
      if (typeof value.summary === 'string') {
        replacement.summary = value.summary;
      }
      if (typeof value.description === 'string') {
        replacement.description = value.description;
      }

      if (isEquivalentRefReplacement(value, replacement)) {
        return;
      }

      if (Array.isArray(parent)) {
        parent[parentKey as number] = replacement;
      } else {
        parent[parentKey as string] = replacement;
      }

      changed = true;
    });
  }
}

// Rewrite `discriminator.mapping` filename values to component refs.
// Example: `card: CardEvent.yaml` -> `card: '#/components/schemas/CardEvent'`.
export async function rewriteDiscriminatorMappings(
  root: unknown,
  registry: SchemaRegistry,
  resolver: ExternalSchemaNameResolver,
  parserOptions?: Partial<$RefParserOptions>,
): Promise<void> {
  let changed = true;

  while (changed) {
    changed = false;

    const mappingsToRewrite: Array<{
      schema: Record<string, unknown>;
      schemaPointer: string;
      mapping: Record<string, unknown>;
      mappingKey: string;
      mappingValue: string;
    }> = [];

    walk(root, false, '#', new WeakSet<object>(), (value, pointer, inSchemaContext) => {
      if (!inSchemaContext || !isRecord(value) || !isRecord(value.discriminator)) {
        return;
      }

      const discriminator = value.discriminator as Record<string, unknown>;
      if (!isRecord(discriminator.mapping)) {
        return;
      }

      const mapping = discriminator.mapping as Record<string, unknown>;

      Object.entries(mapping).forEach(([mappingKey, mappingValue]) => {
        if (typeof mappingValue !== 'string' || !looksLikeExternalFileReference(mappingValue)) {
          return;
        }

        mappingsToRewrite.push({
          schema: value,
          schemaPointer: pointer,
          mapping,
          mappingKey,
          mappingValue,
        });
      });
    });

    for (const rewrite of mappingsToRewrite) {
      const componentPointer = await resolveDiscriminatorMappingPointer(
        rewrite.mappingValue,
        rewrite.schema,
        rewrite.schemaPointer,
        registry,
        resolver,
        parserOptions,
      );
      if (componentPointer && rewrite.mapping[rewrite.mappingKey] !== componentPointer) {
        rewrite.mapping[rewrite.mappingKey] = componentPointer;
        changed = true;
      }
    }
  }
}

// Use original source schema files as templates to restore ref-based composition where bundling
// may have inlined too aggressively.
// Example: if source used `allOf: [{ $ref: './Base.yaml' }, ...]`, restore a component ref form.
export async function rewriteSchemaRefsFromSourceTemplates(
  root: unknown,
  registry: SchemaRegistry,
  resolver: ExternalSchemaNameResolver,
  parserOptions?: Partial<$RefParserOptions>,
): Promise<void> {
  const componentSourcePairs = [...resolver.sourcePathByComponentName.entries()];

  for (const [componentName, sourcePath] of componentSourcePairs) {
    const sourceSchema = await ensureExternalSchemaForSourcePath(sourcePath, resolver, parserOptions);
    const bundledSchema = registry.componentSchemas[componentName];

    if (!isRecord(sourceSchema) || !isRecord(bundledSchema)) {
      continue;
    }

    const rewritten = await rewriteFromSourceTemplate(
      sourceSchema,
      bundledSchema,
      sourcePath,
      registry,
      resolver,
      parserOptions,
    );
    registry.componentSchemas[componentName] = rewritten;
  }

  if (isRecord(root) && isRecord(root.components)) {
    root.components.schemas = registry.componentSchemas;
  }
}

// Recursive template-guided rewrite.
// It walks source and bundled nodes in parallel and replaces bundled inline subtrees with
// component refs when source explicitly references another file.
async function rewriteFromSourceTemplate(
  sourceNode: unknown,
  bundledNode: unknown,
  sourcePath: string,
  registry: SchemaRegistry,
  resolver: ExternalSchemaNameResolver,
  parserOptions?: Partial<$RefParserOptions>,
): Promise<unknown> {
  if (!isRecord(sourceNode) || !isRecord(bundledNode)) {
    if (Array.isArray(sourceNode) && Array.isArray(bundledNode)) {
      const next = [...bundledNode];

      for (let i = 0; i < sourceNode.length; i += 1) {
        if (i >= next.length) {
          break;
        }

        next[i] = await rewriteFromSourceTemplate(
          sourceNode[i],
          next[i],
          sourcePath,
          registry,
          resolver,
          parserOptions,
        );
      }

      return next;
    }

    return bundledNode;
  }

  if (typeof sourceNode.$ref === 'string' && looksLikeExternalFileReference(sourceNode.$ref)) {
    const targetSourcePath = resolveSourcePathFromSourceRef(sourcePath, sourceNode.$ref);
    if (targetSourcePath) {
      const componentPointer = await ensureComponentPointerForSourcePath(
        targetSourcePath,
        registry,
        resolver,
        parserOptions,
      );

      if (componentPointer) {
        const replacement: Record<string, unknown> = { $ref: componentPointer };
        if (typeof bundledNode.summary === 'string') {
          replacement.summary = bundledNode.summary;
        }
        if (typeof bundledNode.description === 'string') {
          replacement.description = bundledNode.description;
        }

        return replacement;
      }
    }
  }

  const next: Record<string, unknown> = { ...bundledNode };

  for (const [key, sourceChild] of Object.entries(sourceNode)) {
    if (!(key in next)) {
      continue;
    }

    next[key] = await rewriteFromSourceTemplate(sourceChild, next[key], sourcePath, registry, resolver, parserOptions);
  }

  return next;
}

function isEquivalentRefReplacement(value: Record<string, unknown>, replacement: Record<string, unknown>): boolean {
  if (value.$ref !== replacement.$ref) {
    return false;
  }

  if (value.summary !== replacement.summary || value.description !== replacement.description) {
    return false;
  }

  return Object.keys(value).every(key => REF_REPLACEMENT_ALLOWED_KEYS.has(key));
}
