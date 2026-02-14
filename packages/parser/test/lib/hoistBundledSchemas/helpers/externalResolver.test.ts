import { describe, expect, it } from 'vitest';

import {
  addExternalNameCandidate,
  buildExternalComponentFingerprintIndex,
  createExternalSchemaNameResolver,
  registerExternalSourcePath,
  resolveExternalComponentCandidate,
  resolveExternalSchemaCandidate,
  resolveMatchingSourcePath,
} from '../../../../src/lib/hoistBundledSchemas/helpers/externalResolver.js';
import { createSchemaRegistry } from '../../../../src/lib/hoistBundledSchemas/helpers/registry.js';

describe('externalResolver helpers', () => {
  it('resolves candidates by object identity first', () => {
    const resolver = createExternalSchemaNameResolver();
    const schema = { type: 'object', properties: { id: { type: 'string' } } };

    addExternalNameCandidate(resolver, schema, 'User');

    const matched = resolveExternalSchemaCandidate(schema, resolver);
    expect(matched).toBeDefined();
    expect(matched?.name).toBe('User');
    expect(matched?.schema).toBe(schema);
  });

  it('resolves candidates by fingerprint when identity is different', () => {
    const resolver = createExternalSchemaNameResolver();
    const canonical = { type: 'object', properties: { id: { type: 'string' } } };

    addExternalNameCandidate(resolver, canonical, 'User');

    const clone = structuredClone(canonical);
    const matched = resolveExternalSchemaCandidate(clone, resolver);

    expect(matched).toBeDefined();
    expect(matched?.name).toBe('User');
    expect(matched?.schema).toBe(canonical);
  });

  it('returns undefined for ambiguous fingerprint matches', () => {
    const resolver = createExternalSchemaNameResolver();

    addExternalNameCandidate(resolver, { type: 'object', properties: { id: { type: 'string' } } }, 'UserA');
    addExternalNameCandidate(resolver, { type: 'object', properties: { id: { type: 'string' } } }, 'UserB');

    const matched = resolveExternalSchemaCandidate(
      { type: 'object', properties: { id: { type: 'string' } } },
      resolver,
    );
    expect(matched).toBeUndefined();
  });

  it('registers source paths and resolves unique suffix matches', () => {
    const resolver = createExternalSchemaNameResolver();
    const schemaA = { type: 'object' };
    const schemaB = { type: 'object' };

    registerExternalSourcePath(resolver, '/spec/a/User.yaml', schemaA);
    registerExternalSourcePath(resolver, '/spec/b/models/User.yaml', schemaB);

    expect(resolveMatchingSourcePath('User.yaml', 'user.yaml', resolver)).toBeUndefined();
    expect(resolveMatchingSourcePath('b/models/User.yaml', 'user.yaml', resolver)).toBe('/spec/b/models/User.yaml');
  });

  it('builds external component fingerprint index and resolves unique matches', () => {
    const resolver = createExternalSchemaNameResolver();
    const canonical = { type: 'object', properties: { id: { type: 'string' } } };
    addExternalNameCandidate(resolver, canonical, 'User');

    const doc: any = {
      openapi: '3.0.3',
      info: { title: 't', version: '1.0.0' },
      paths: {},
      components: { schemas: { User: canonical } },
    };
    const registry = createSchemaRegistry(doc);

    const index = buildExternalComponentFingerprintIndex(registry, resolver);
    const matched = resolveExternalComponentCandidate(
      { type: 'object', properties: { id: { type: 'string' } } },
      index,
    );

    expect(matched).toBeDefined();
    expect(matched?.name).toBe('User');
    expect(matched?.schema).toBe(canonical);
  });
});
