import type { ExternalSchemaNameResolver, SchemaRegistry } from './types.js';

import nodePath from 'node:path';

import { createSchemaFingerprint } from './fingerprint.js';
import { isLikelySchemaObject, isRecord } from './guards.js';

// Create resolver state used to match external schemas by identity, fingerprint, and source path.
// Example: supports turning `./CardEvent.yaml` into a known source path and component name.
export function createExternalSchemaNameResolver(): ExternalSchemaNameResolver {
  return {
    nameByValue: new WeakMap<object, string>(),
    namesByFingerprint: new Map<string, Set<string>>(),
    canonicalByName: new Map<string, Record<string, unknown>>(),
    canonicalByFingerprint: new Map<string, Map<string, Record<string, unknown>>>(),
    schemaBySourcePath: new Map<string, Record<string, unknown>>(),
    sourcePathsByBaseName: new Map<string, Set<string>>(),
    componentNameBySourcePath: new Map<string, string>(),
    sourcePathByValue: new WeakMap<object, string>(),
    sourcePathByComponentName: new Map<string, string>(),
    loadingSourcePaths: new Set<string>(),
  };
}

// Register schema-name candidates for an external schema object.
// Example: for `Pet.yaml`, store identity->`Pet` and fingerprint->`Pet` so cloned equivalents can
// still resolve to the same canonical name.
export function addExternalNameCandidate(
  resolver: ExternalSchemaNameResolver,
  schema: Record<string, unknown>,
  schemaName: string,
): void {
  if (!isLikelySchemaObject(schema)) {
    return;
  }

  resolver.nameByValue.set(schema, schemaName);
  resolver.canonicalByName.set(schemaName, schema);

  const fingerprint = createSchemaFingerprint(schema);
  const names = resolver.namesByFingerprint.get(fingerprint) ?? new Set<string>();
  names.add(schemaName);
  resolver.namesByFingerprint.set(fingerprint, names);

  const byName = resolver.canonicalByFingerprint.get(fingerprint) ?? new Map<string, Record<string, unknown>>();
  byName.set(schemaName, schema);
  resolver.canonicalByFingerprint.set(fingerprint, byName);
}

// Register source path metadata for an external schema object.
// Example: map `/spec/schemas/User.yaml` to its object and keep basename index for later matching
// when mapping values provide only `User.yaml`.
export function registerExternalSourcePath(
  resolver: ExternalSchemaNameResolver,
  sourcePath: string,
  schema: Record<string, unknown>,
): void {
  if (!isLikelySchemaObject(schema)) {
    return;
  }

  resolver.schemaBySourcePath.set(sourcePath, schema);
  resolver.sourcePathByValue.set(schema, sourcePath);

  const baseName = nodePath.basename(sourcePath).toLowerCase();
  const paths = resolver.sourcePathsByBaseName.get(baseName) ?? new Set<string>();
  paths.add(sourcePath);
  resolver.sourcePathsByBaseName.set(baseName, paths);
}

// Resolve a schema object to canonical external candidate (name + schema), first by object
// identity, then by structural fingerprint if identity was lost.
// Example: two cloned but equivalent `Id` schemas still resolve to one canonical `Id` component.
export function resolveExternalSchemaCandidate(
  schema: Record<string, unknown>,
  resolver: ExternalSchemaNameResolver,
): { name: string; schema: Record<string, unknown> } | undefined {
  const byIdentityName = resolver.nameByValue.get(schema);
  if (byIdentityName) {
    const canonicalByIdentity = resolver.canonicalByName.get(byIdentityName);
    if (canonicalByIdentity) {
      return { name: byIdentityName, schema: canonicalByIdentity };
    }
  }

  const fingerprint = createSchemaFingerprint(schema);
  const candidates = resolver.canonicalByFingerprint.get(fingerprint);
  if (!candidates || candidates.size !== 1) {
    return undefined;
  }

  const [name, canonical] = [...candidates.entries()][0];
  return { name, schema: canonical };
}

// Build a fingerprint index from already-hoisted external component schemas.
// Example: lets inline equivalent objects be replaced with refs to existing components.
export function buildExternalComponentFingerprintIndex(
  registry: SchemaRegistry,
  resolver: ExternalSchemaNameResolver,
): Map<string, Array<{ name: string; schema: Record<string, unknown> }>> {
  const index = new Map<string, Array<{ name: string; schema: Record<string, unknown> }>>();

  Object.entries(registry.componentSchemas).forEach(([name, schema]) => {
    if (!resolver.canonicalByName.has(name) || !isRecord(schema)) {
      return;
    }

    const fingerprint = createSchemaFingerprint(schema);
    const entries = index.get(fingerprint) ?? [];
    entries.push({ name, schema });
    index.set(fingerprint, entries);
  });

  return index;
}

// Resolve inline schema object to a single external component candidate by fingerprint.
// Returns undefined when there are zero or multiple matches to avoid ambiguous rewrites.
export function resolveExternalComponentCandidate(
  schema: Record<string, unknown>,
  index: Map<string, Array<{ name: string; schema: Record<string, unknown> }>>,
): { name: string; schema: Record<string, unknown> } | undefined {
  const matches = index.get(createSchemaFingerprint(schema));
  if (!matches || matches.length !== 1) {
    return undefined;
  }

  return matches[0];
}

// Match a path ref to known source paths by basename and (when needed) unique suffix.
// Example: `./schemas/CardEvent.yaml` can match a single known path ending with that suffix.
export function resolveMatchingSourcePath(
  pathRef: string,
  baseName: string,
  resolver: ExternalSchemaNameResolver,
): string | undefined {
  const candidates = resolver.sourcePathsByBaseName.get(baseName);
  if (!candidates?.size) {
    return undefined;
  }

  if (candidates.size === 1) {
    return [...candidates][0];
  }

  const normalizedRef = pathRef.replace(/^\.\//, '').toLowerCase();
  const exactSuffixMatches = [...candidates].filter(sourcePath =>
    sourcePath.toLowerCase().endsWith(`/${normalizedRef}`),
  );
  if (exactSuffixMatches.length === 1) {
    return exactSuffixMatches[0];
  }

  return undefined;
}
