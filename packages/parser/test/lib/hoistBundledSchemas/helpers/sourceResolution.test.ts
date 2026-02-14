import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  addExternalNameCandidate,
  createExternalSchemaNameResolver,
  registerExternalSourcePath,
} from '../../../../src/lib/hoistBundledSchemas/helpers/externalResolver.js';
import { createSchemaRegistry } from '../../../../src/lib/hoistBundledSchemas/helpers/registry.js';
import {
  ensureComponentPointerForSourcePath,
  ensureExternalSchemaForSourcePath,
  looksLikeExternalFileReference,
  resolveDiscriminatorMappingPointer,
  resolveSourcePathFromSchemaContext,
  resolveSourcePathFromSourceRef,
} from '../../../../src/lib/hoistBundledSchemas/helpers/sourceResolution.js';

const idSchemaPath = fileURLToPath(
  new URL('../../../specs/bundling/mock-multifile/components/schemas/Id.yaml', import.meta.url),
);

describe('sourceResolution helpers', () => {
  it('detects external file reference strings', () => {
    expect(looksLikeExternalFileReference('./schemas/Pet.yaml')).toBe(true);
    expect(looksLikeExternalFileReference('schemas/Pet.json#/properties/id')).toBe(true);
    expect(looksLikeExternalFileReference('#/components/schemas/Pet')).toBe(false);
    expect(looksLikeExternalFileReference('https://example.com/Pet.yaml')).toBe(false);
  });

  it('resolves source paths from source refs', () => {
    expect(resolveSourcePathFromSourceRef('/spec/schemas/EventBase.yaml', './CardEvent.yaml')).toBe(
      nodePath.normalize('/spec/schemas/CardEvent.yaml'),
    );
    expect(resolveSourcePathFromSourceRef('/spec/schemas/EventBase.yaml', '/tmp/CardEvent.yaml')).toBe(
      nodePath.normalize('/tmp/CardEvent.yaml'),
    );
  });

  it('resolves schema-context paths from value, component pointer, and fingerprint fallback', () => {
    const resolver = createExternalSchemaNameResolver();

    const sourceSchema = { type: 'object' };
    registerExternalSourcePath(resolver, '/spec/schemas/EventBase.yaml', sourceSchema);
    expect(resolveSourcePathFromSchemaContext('./CardEvent.yaml', sourceSchema, '#/any', resolver)).toBe(
      nodePath.normalize('/spec/schemas/CardEvent.yaml'),
    );

    resolver.sourcePathByComponentName.set('EventBase', '/spec/schemas/EventBase.yaml');
    expect(resolveSourcePathFromSchemaContext('./CardEvent.yaml', {}, '#/components/schemas/EventBase', resolver)).toBe(
      nodePath.normalize('/spec/schemas/CardEvent.yaml'),
    );

    const canonical = { type: 'object', properties: { id: { type: 'string' } } };
    addExternalNameCandidate(resolver, canonical, 'Canonical');
    registerExternalSourcePath(resolver, '/spec/schemas/Canonical.yaml', canonical);
    expect(
      resolveSourcePathFromSchemaContext(
        './Target.yaml',
        { type: 'object', properties: { id: { type: 'string' } } },
        '#/unknown',
        resolver,
      ),
    ).toBe(nodePath.normalize('/spec/schemas/Target.yaml'));
  });

  it('loads and caches external schemas by source path', async () => {
    const resolver = createExternalSchemaNameResolver();

    const first = await ensureExternalSchemaForSourcePath(idSchemaPath, resolver);
    const second = await ensureExternalSchemaForSourcePath(idSchemaPath, resolver);

    expect(first).toBeDefined();
    expect(first).toBe(second);
    expect((first as Record<string, unknown>).type).toBe('string');
    expect(resolver.schemaBySourcePath.get(idSchemaPath)).toBe(first);
  });

  it('creates component pointers for source paths', async () => {
    const resolver = createExternalSchemaNameResolver();
    const doc: any = {
      openapi: '3.0.3',
      info: { title: 't', version: '1.0.0' },
      paths: {},
      components: { schemas: {} },
    };
    const registry = createSchemaRegistry(doc);

    const pointer = await ensureComponentPointerForSourcePath(idSchemaPath, registry, resolver);

    expect(pointer).toBe('#/components/schemas/Id');
    expect(doc.components.schemas.Id).toBeDefined();
  });

  it('resolves discriminator mapping pointers from known source paths', async () => {
    const resolver = createExternalSchemaNameResolver();
    const cardSchema = { type: 'object' };
    addExternalNameCandidate(resolver, cardSchema, 'CardEvent');
    registerExternalSourcePath(resolver, '/spec/schemas/CardEvent.yaml', cardSchema);

    const doc: any = {
      openapi: '3.0.3',
      info: { title: 't', version: '1.0.0' },
      paths: {},
      components: { schemas: {} },
    };
    const registry = createSchemaRegistry(doc);

    const pointer = await resolveDiscriminatorMappingPointer(
      'CardEvent.yaml',
      { type: 'object' },
      '#/components/schemas/EventBase',
      registry,
      resolver,
    );

    expect(pointer).toBe('#/components/schemas/CardEvent');
  });

  it('uses existing component as fallback when source path cannot be resolved', async () => {
    const resolver = createExternalSchemaNameResolver();
    const doc: any = {
      openapi: '3.0.3',
      info: { title: 't', version: '1.0.0' },
      paths: {},
      components: { schemas: { Unknown: { type: 'object' } } },
    };
    const registry = createSchemaRegistry(doc);

    const pointer = await resolveDiscriminatorMappingPointer(
      'Unknown.yaml',
      {},
      '#/components/schemas/Base',
      registry,
      resolver,
    );

    expect(pointer).toBe('#/components/schemas/Unknown');
  });
});
