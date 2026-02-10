import type { ParserOptions as $RefParserOptions } from '@apidevtools/json-schema-ref-parser';
import type { OpenAPIV3, OpenAPIV3_1 } from 'openapi-types';
import type { APIDocument } from '../types.js';

import nodePath from 'node:path';

import { $RefParser } from '@apidevtools/json-schema-ref-parser';

import { isOpenAPI } from './assertions.js';

const schemaContextKeys = new Set([
  '$defs',
  'additionalProperties',
  'allOf',
  'anyOf',
  'contains',
  'definitions',
  'dependentSchemas',
  'else',
  'if',
  'items',
  'not',
  'oneOf',
  'patternProperties',
  'prefixItems',
  'properties',
  'propertyNames',
  'schema',
  'schemas',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties',
]);

const ignoredPointerNameTokens = new Set([
  'allOf',
  'anyOf',
  'components',
  'content',
  'items',
  'oneOf',
  'paths',
  'post',
  'put',
  'patch',
  'get',
  'delete',
  'head',
  'trace',
  'options',
  'requestBody',
  'responses',
  'schema',
  'schemas',
]);

type SchemaRegistry = {
  schemaNames: Set<string>;
  schemaPointersByValue: WeakMap<object, string>;
  componentSchemas: Record<string, unknown>;
};

type ExternalSchemaNameResolver = {
  nameByValue: WeakMap<object, string>;
  namesByFingerprint: Map<string, Set<string>>;
  canonicalByName: Map<string, Record<string, unknown>>;
  canonicalByFingerprint: Map<string, Map<string, Record<string, unknown>>>;
  schemaBySourcePath: Map<string, Record<string, unknown>>;
  sourcePathsByBaseName: Map<string, Set<string>>;
  componentNameBySourcePath: Map<string, string>;
  sourcePathByValue: WeakMap<object, string>;
  sourcePathByComponentName: Map<string, string>;
  loadingSourcePaths: Set<string>;
};

/**
 * Hoist bundled external schema files into `components.schemas` and rewrite schema-context refs so
 * they're component-backed instead of path-backed pointers.
 *
 */
export async function hoistBundledSchemas<S extends APIDocument = APIDocument>(
  parser: $RefParser<S>,
  parserOptions?: Partial<$RefParserOptions>,
): Promise<void> {
  if (!isOpenAPI(parser.schema) || !parser.$refs) {
    return;
  }

  const registry = createSchemaRegistry(parser.schema);
  const externalNameResolver = createExternalSchemaNameResolver();

  // 1) Pre-register external schema file roots by filename.
  const resolvedPaths = parser.$refs.paths();
  if (resolvedPaths.length) {
    const rootPath = resolvedPaths[0];
    const externalSchemas = new Map<object, string>();

    resolvedPaths
      .filter(path => path !== rootPath)
      .forEach(path => {
        const value = parser.$refs?.get(path);
        if (isRecord(value)) {
          const sourceName = createSchemaNameFromSourcePath(path);
          externalSchemas.set(value, path);
          addExternalNameCandidate(externalNameResolver, value, sourceName);
          registerExternalSourcePath(externalNameResolver, path, value);
        }
      });

    collectSchemaTargets(parser.schema, externalSchemas).forEach(({ sourcePath, value }) => {
      const pointer = registerSchemaInComponents(registry, value, createSchemaNameFromSourcePath(sourcePath));
      const componentName = decodeJsonPointerToken(pointer.split('/').at(-1) || '');
      externalNameResolver.componentNameBySourcePath.set(sourcePath, componentName);
      externalNameResolver.sourcePathByComponentName.set(componentName, sourcePath);
    });
  }

  // 2) Rewrite local schema refs to component refs and hoist unresolved local targets.
  rewriteLocalSchemaRefsToComponents(parser.schema, registry, externalNameResolver);

  // 2b) Rewrite inline schema objects that came from external files into component-backed refs.
  rewriteInlineExternalSchemasToComponentRefs(parser.schema, registry, externalNameResolver);

  // 2c) Resolve mapping and source-template refs in tandem.
  // A second pass is needed because resolving one mapping can load new schemas that also need
  // mapping/source normalization.
  for (let i = 0; i < 2; i += 1) {
    await rewriteDiscriminatorMappings(parser.schema, registry, externalNameResolver, parserOptions);
    await rewriteSchemaRefsFromSourceTemplates(parser.schema, registry, externalNameResolver, parserOptions);
  }

  // 3) Replace remaining inlined schema objects (that now have component identities) with refs.
  replaceHoistedObjectsWithRefs(parser.schema, registry);
}

function createSchemaRegistry(schema: OpenAPIV3.Document | OpenAPIV3_1.Document): SchemaRegistry {
  const components = (schema.components ??= {}) as Record<string, unknown>;
  const componentSchemas = (components.schemas ??= {}) as Record<string, unknown>;

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

function collectSchemaTargets(
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

function rewriteLocalSchemaRefsToComponents(
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

function createExternalSchemaNameResolver(): ExternalSchemaNameResolver {
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

function addExternalNameCandidate(
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

function registerExternalSourcePath(
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

async function rewriteDiscriminatorMappings(
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

async function resolveDiscriminatorMappingPointer(
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

function resolveMatchingSourcePath(
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

function resolveSourcePathFromSchemaContext(
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

async function rewriteSchemaRefsFromSourceTemplates(
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

  // Keep parser schema in sync if components object identity was updated.
  if (isRecord(root) && isRecord(root.components)) {
    root.components.schemas = registry.componentSchemas;
  }
}

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

function resolveSourcePathFromSourceRef(sourcePath: string, sourceRef: string): string | undefined {
  const refPath = sourceRef.split('#')[0];
  if (!refPath) {
    return undefined;
  }

  if (nodePath.isAbsolute(refPath)) {
    return nodePath.normalize(refPath);
  }

  return nodePath.normalize(nodePath.resolve(nodePath.dirname(sourcePath), refPath));
}

async function ensureComponentPointerForSourcePath(
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

async function ensureExternalSchemaForSourcePath(
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

function looksLikeExternalFileReference(value: string): boolean {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(value) || value.startsWith('#/')) {
    return false;
  }

  return /\.(yaml|yml|json)(#.*)?$/iu.test(value);
}

function isLikelySchemaObject(value: Record<string, unknown>): boolean {
  const schemaKeys = [
    '$ref',
    'additionalProperties',
    'allOf',
    'anyOf',
    'const',
    'discriminator',
    'enum',
    'format',
    'items',
    'not',
    'oneOf',
    'patternProperties',
    'properties',
    'required',
    'type',
  ];

  return schemaKeys.some(key => key in value);
}

function rewriteInlineExternalSchemasToComponentRefs(
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

function isEquivalentRefReplacement(value: Record<string, unknown>, replacement: Record<string, unknown>): boolean {
  if (value.$ref !== replacement.$ref) {
    return false;
  }

  if (value.summary !== replacement.summary || value.description !== replacement.description) {
    return false;
  }

  const allowedKeys = new Set(['$ref', 'summary', 'description']);
  return Object.keys(value).every(key => allowedKeys.has(key));
}

function buildExternalComponentFingerprintIndex(
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

function resolveExternalComponentCandidate(
  schema: Record<string, unknown>,
  index: Map<string, Array<{ name: string; schema: Record<string, unknown> }>>,
): { name: string; schema: Record<string, unknown> } | undefined {
  const matches = index.get(createSchemaFingerprint(schema));
  if (!matches || matches.length !== 1) {
    return undefined;
  }

  return matches[0];
}

function resolveExternalSchemaCandidate(
  schema: Record<string, unknown>,
  resolver: ExternalSchemaNameResolver,
): { name: string; schema: Record<string, unknown> } | undefined {
  const byIdentityName = resolver.nameByValue.get(schema);
  if (byIdentityName) {
    const canonical = resolver.canonicalByName.get(byIdentityName);
    if (canonical) {
      return { name: byIdentityName, schema: canonical };
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

function replaceHoistedObjectsWithRefs(root: unknown, registry: SchemaRegistry): void {
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

function isComponentSchemaRootPointer(pointer: string): boolean {
  return /^#\/components\/schemas\/[^/]+$/u.test(pointer);
}

function registerSchemaInComponents(registry: SchemaRegistry, schema: object, preferredName: string): string {
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

function resolveLocalPointer(root: unknown, pointer: string): unknown {
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

function walk(
  value: unknown,
  inSchemaContext: boolean,
  pointer: string,
  seen: WeakSet<object>,
  visitor: (
    value: object,
    pointer: string,
    inSchemaContext: boolean,
    parent?: Record<string, unknown> | unknown[],
    parentKey?: string | number,
  ) => void,
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
      const childInSchemaContext = inSchemaContext || schemaContextKeys.has(key);
      walk(child, childInSchemaContext, childPointer, seen, visitor, value, key);
    });
  }

  seen.delete(value);
}

function isObject(value: unknown): value is object {
  return !!value && typeof value === 'object';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return isObject(value) && !Array.isArray(value);
}

function encodeJsonPointerToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

function decodeJsonPointerToken(token: string): string {
  try {
    return decodeURIComponent(token).replace(/~1/g, '/').replace(/~0/g, '~');
  } catch {
    return token.replace(/~1/g, '/').replace(/~0/g, '~');
  }
}

function createSchemaFingerprint(schema: Record<string, unknown>): string {
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

function createSchemaNameFromSourcePath(sourcePath: string): string {
  const fileName = nodePath.basename(sourcePath);
  const withoutExtension = fileName.replace(/\.[^./\\]+$/u, '');
  const normalized = withoutExtension.replace(/[^a-zA-Z0-9._-]/g, '-');

  return normalized || 'Schema';
}

function createSchemaNameFromPointer(pointer: string): string {
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
      ignoredPointerNameTokens.has(token) ||
      token.startsWith('application/')
    ) {
      continue;
    }

    return normalizeComponentName(token);
  }

  return tokens.length ? normalizeComponentName(tokens[tokens.length - 1]) : 'Schema';
}

function normalizeComponentName(name: string): string {
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

function createUniqueSchemaName(baseName: string, names: Set<string>): string {
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
