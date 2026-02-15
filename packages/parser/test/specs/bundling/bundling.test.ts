import { describe, expect, it } from 'vitest';

import { bundle } from '../../../src/index.js';
import { relativePath } from '../../utils.js';

describe('bundle', () => {
  it('preserves nullish example values while bundling pet schemas (example: id: null)', async () => {
    const api = await bundle(relativePath('specs/bundling/nullish-example/openapi.yaml'));
    const bundledApi: any = api;

    expect(bundledApi.paths['/pets'].get.responses['200'].content['application/json'].schema).toStrictEqual({
      type: 'array',
      items: { $ref: '#/components/schemas/Pet' },
    });
    expect(bundledApi.paths['/pets'].get.responses['200'].content['application/json'].example).toStrictEqual({
      data: { id: null, name: 'snowball' },
    });
    expect(bundledApi.components.schemas.Pet).toStrictEqual({
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
      },
      required: ['id', 'name'],
    });
  });

  it('rewrites external refs to internal refs (example: ./components/schemas/Pet.yaml -> #/components/schemas/Pet)', async () => {
    const api = await bundle(relativePath('specs/bundling/mock-multifile/openapi.yaml'));
    const bundledApi: any = api;

    expect(bundledApi.paths['/pets/{id}'].get.parameters[0].schema).toStrictEqual({ $ref: '#/components/schemas/Id' });
    expect(bundledApi.paths['/pets/{id}'].get.responses['200'].content['application/json'].schema).toStrictEqual({
      $ref: '#/components/schemas/Pet',
    });
    expect(bundledApi.components.schemas.Id).toStrictEqual({
      type: 'string',
      pattern: '^[a-zA-Z0-9_-]+$',
    });
    expect(bundledApi.components.schemas.Pet).toStrictEqual({
      type: 'object',
      required: ['id', 'name'],
      properties: {
        id: { $ref: '#/components/schemas/Id' },
        name: { type: 'string' },
        owner: { $ref: '#/components/schemas/Owner' },
      },
    });
    expect(bundledApi.components.schemas.Owner).toStrictEqual({
      type: 'object',
      required: ['id', 'email'],
      properties: {
        id: { $ref: '#/components/schemas/Id' },
        email: { type: 'string', format: 'email' },
      },
    });

    const refs = collectRefs(api);
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.every(ref => ref.startsWith('#/'))).toBe(true);
    expect(refs.some(ref => ref.startsWith('#/paths/'))).toBe(false);
  });

  it('rewrites allOf path-based refs to component refs (example: ./PetBase.yaml#/allOf/... -> #/components/schemas/Owner)', async () => {
    const api = await bundle(relativePath('specs/bundling/allof-ref-hoisting/openapi.yaml'));
    const bundledApi: any = api;

    expect(bundledApi.paths['/pets'].post.requestBody.content['application/json'].schema).toStrictEqual({
      $ref: '#/components/schemas/PetWithOwner',
    });
    expect(bundledApi.components.schemas.PetWithOwner).toStrictEqual({
      allOf: [
        { $ref: '#/components/schemas/PetBase' },
        {
          type: 'object',
          properties: {
            owner: {
              $ref: '#/components/schemas/Owner',
              description: 'Pet owner details',
            },
          },
        },
      ],
    });
    expect(bundledApi.components.schemas.PetBase).toStrictEqual({
      allOf: [
        { type: 'object' },
        {
          type: 'object',
          properties: {
            category: {
              $ref: '#/components/schemas/Owner',
              description: 'Pet category',
            },
          },
        },
      ],
    });
    expect(bundledApi.components.schemas.Owner).toStrictEqual({
      type: 'object',
      properties: {
        id: { type: 'string' },
        email: { type: 'string', format: 'email' },
      },
      required: ['id', 'email'],
    });
    expect(bundledApi.components.schemas.Category).toBeUndefined();

    const refs = collectRefs(bundledApi.components.schemas);
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.some(ref => ref.startsWith('#/paths/'))).toBe(false);
  });

  it('rewrites discriminator mapping filenames to component refs (example: PetCreatedEvent.yaml -> #/components/schemas/PetCreatedEvent)', async () => {
    const api = await bundle(relativePath('specs/bundling/discriminator-mapping/openapi.yaml'));
    const bundledApi: any = api;

    expect(bundledApi.paths['/pet-events'].get.responses['200'].content['application/json'].schema).toStrictEqual({
      $ref: '#/components/schemas/PetEventBase',
    });
    expect(bundledApi.components.schemas.PetEventBase.discriminator.mapping).toStrictEqual({
      created: '#/components/schemas/PetCreatedEvent',
      adopted: '#/components/schemas/PetAdoptedEvent',
    });

    const mappingValues = Object.values(bundledApi.components.schemas.PetEventBase.discriminator.mapping);
    expect(
      mappingValues.every((value: unknown) => typeof value === 'string' && value.startsWith('#/components/schemas/')),
    ).toBe(true);
  });

  it('keeps non-schema x-doc-refs unchanged while still bundling schema refs (example: ./docs/auth.md stays as-is)', async () => {
    const api = await bundle(relativePath('specs/bundling/x-doc-refs/openapi.yaml'));
    const bundledApi: any = api;

    expect(bundledApi['x-doc-refs']).toStrictEqual([
      {
        id: 'purpose',
        name: 'Purpose',
        $ref: './docs/purpose.md',
      },
      {
        id: 'auth',
        name: 'Authentication',
        $ref: './docs/auth.md',
      },
    ]);
    expect(bundledApi.paths['/pets'].get.responses['200'].content['application/json'].schema).toStrictEqual({
      $ref: '#/components/schemas/Pet',
    });
  });
});

function collectRefs(input: unknown): string[] {
  if (!input || typeof input !== 'object') {
    return [];
  }

  if (Array.isArray(input)) {
    return input.flatMap(collectRefs);
  }

  return Object.entries(input).flatMap(([key, value]) => {
    if (key === '$ref' && typeof value === 'string') {
      return [value];
    }

    return collectRefs(value);
  });
}
