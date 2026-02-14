import type { ParserOptions as $RefParserOptions } from '@apidevtools/json-schema-ref-parser';
import type { ExternalSchemaNameResolver, SchemaRegistry } from './types.js';

import nodePath from 'node:path';

import { $RefParser } from '@apidevtools/json-schema-ref-parser';

import { addExternalNameCandidate, registerExternalSourcePath, resolveMatchingSourcePath } from './externalResolver.js';
import { createSchemaFingerprint } from './fingerprint.js';
import { isLikelySchemaObject, isRecord } from './guards.js';
import { createSchemaNameFromSourcePath } from './naming.js';
import { decodeJsonPointerToken, encodeJsonPointerToken, isComponentSchemaRootPointer } from './pointers.js';
import { registerSchemaInComponents } from './registry.js';

export function looksLikeExternalFileReference(value: string): boolean {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(value) || value.startsWith('#/')) {
    return false;
  }

  return /\.(yaml|yml|json)(#.*)?$/iu.test(value);
}

// Resolve a relative path reference using the closest known source schema context.
// Example: while processing a schema from `/spec/schemas/EventBase.yaml`, mapping value
// `./CardEvent.yaml` resolves to `/spec/schemas/CardEvent.yaml`.
export function resolveSourcePathFromSchemaContext(
  pathRef: string,
  schema: Record<string, unknown>,
  schemaPointer: string,
  resolver: ExternalSchemaNameResolver,
): string | undefined {
  let sourcePath =
    resolver.sourcePathByValue.get(schema) ||
    (isComponentSchemaRootPointer(schemaPointer)
      ? resolver.sourcePathByComponentName.get(decodeJsonPointerToken(schemaPointer.split('/').at(-1) || ''))
      : undefined);

  if (!sourcePath) {
    const fingerprintCandidates = resolver.canonicalByFingerprint.get(createSchemaFingerprint(schema));
    if (fingerprintCandidates?.size === 1) {
      const [, candidateSchema] = [...fingerprintCandidates.entries()][0];
      sourcePath = resolver.sourcePathByValue.get(candidateSchema);
    }
  }

  if (!sourcePath) {
    return undefined;
  }

  if (nodePath.isAbsolute(pathRef)) {
    return nodePath.normalize(pathRef);
  }

  return nodePath.normalize(nodePath.resolve(nodePath.dirname(sourcePath), pathRef));
}

export function resolveSourcePathFromSourceRef(sourcePath: string, sourceRef: string): string | undefined {
  const refPath = sourceRef.split('#')[0];
  if (!refPath) {
    return undefined;
  }

  if (nodePath.isAbsolute(refPath)) {
    return nodePath.normalize(refPath);
  }

  return nodePath.normalize(nodePath.resolve(nodePath.dirname(sourcePath), refPath));
}

// Load and cache an external schema file so all passes share one canonical object for matching.
// Example: first lookup of `/spec/schemas/Pet.yaml` parses the file and stores identity/fingerprint;
// next lookups reuse the cached schema object.
export async function ensureExternalSchemaForSourcePath(
  sourcePath: string,
  resolver: ExternalSchemaNameResolver,
  parserOptions?: Partial<$RefParserOptions>,
): Promise<Record<string, unknown> | undefined> {
  const existing = resolver.schemaBySourcePath.get(sourcePath);
  if (existing) {
    return existing;
  }

  if (resolver.loadingSourcePaths.has(sourcePath)) {
    return undefined;
  }

  resolver.loadingSourcePaths.add(sourcePath);

  try {
    const nestedParser = new $RefParser<Record<string, unknown>>();
    await nestedParser.parse(sourcePath, undefined, parserOptions);

    if (!isRecord(nestedParser.schema) || !isLikelySchemaObject(nestedParser.schema)) {
      return undefined;
    }

    addExternalNameCandidate(resolver, nestedParser.schema, createSchemaNameFromSourcePath(sourcePath));
    registerExternalSourcePath(resolver, sourcePath, nestedParser.schema);

    return nestedParser.schema;
  } catch {
    return undefined;
  } finally {
    resolver.loadingSourcePaths.delete(sourcePath);
  }
}

// Ensure a source file has a component pointer, creating the component entry if needed.
// Example: `/spec/schemas/User.yaml` -> `#/components/schemas/User`.
export async function ensureComponentPointerForSourcePath(
  sourcePath: string,
  registry: SchemaRegistry,
  resolver: ExternalSchemaNameResolver,
  parserOptions?: Partial<$RefParserOptions>,
): Promise<string | undefined> {
  const externalSchema = await ensureExternalSchemaForSourcePath(sourcePath, resolver, parserOptions);
  if (!externalSchema) {
    return undefined;
  }

  const preferredName =
    resolver.componentNameBySourcePath.get(sourcePath) || createSchemaNameFromSourcePath(sourcePath);
  const pointer = registerSchemaInComponents(registry, externalSchema, preferredName);

  const componentName = decodeJsonPointerToken(pointer.split('/').at(-1) || preferredName);
  resolver.componentNameBySourcePath.set(sourcePath, componentName);
  resolver.sourcePathByComponentName.set(componentName, sourcePath);

  return pointer;
}

// Convert one discriminator mapping value into a component pointer when possible.
// Example: `CardEvent.yaml` can resolve by basename, by schema-context path, or by existing
// component fallback; successful result is `#/components/schemas/CardEvent`.
export async function resolveDiscriminatorMappingPointer(
  mappingValue: string,
  schema: Record<string, unknown>,
  schemaPointer: string,
  registry: SchemaRegistry,
  resolver: ExternalSchemaNameResolver,
  parserOptions?: Partial<$RefParserOptions>,
): Promise<string | undefined> {
  if (mappingValue.startsWith('#/components/schemas/')) {
    return mappingValue;
  }

  if (!looksLikeExternalFileReference(mappingValue)) {
    return undefined;
  }

  const withoutFragment = mappingValue.split('#')[0].replace(/\\/g, '/');
  const baseName = nodePath.basename(withoutFragment).toLowerCase();
  if (!baseName) {
    return undefined;
  }

  let sourcePath = resolveMatchingSourcePath(withoutFragment, baseName, resolver);
  if (!sourcePath) {
    sourcePath = resolveSourcePathFromSchemaContext(withoutFragment, schema, schemaPointer, resolver);
  }

  if (!sourcePath) {
    const fallbackName = createSchemaNameFromSourcePath(withoutFragment);
    if (fallbackName in registry.componentSchemas) {
      return `#/components/schemas/${encodeJsonPointerToken(fallbackName)}`;
    }

    return undefined;
  }

  const externalSchema = await ensureExternalSchemaForSourcePath(sourcePath, resolver, parserOptions);
  if (!externalSchema) {
    return undefined;
  }

  const preferredName =
    resolver.componentNameBySourcePath.get(sourcePath) || createSchemaNameFromSourcePath(sourcePath);
  const pointer = registerSchemaInComponents(registry, externalSchema, preferredName);
  const componentName = decodeJsonPointerToken(pointer.split('/').at(-1) || preferredName);
  resolver.componentNameBySourcePath.set(sourcePath, componentName);
  resolver.sourcePathByComponentName.set(componentName, sourcePath);

  return pointer;
}
