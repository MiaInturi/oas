import { describe, expect, it } from 'vitest';

import {
  createSchemaRegistry,
  registerSchemaInComponents,
  replaceHoistedObjectsWithRefs,
} from '../../../../src/lib/hoistBundledSchemas/helpers/registry.js';

describe('registry helpers', () => {
  it('initializes missing components.schemas', () => {
    const doc: any = {
      openapi: '3.0.3',
      info: { title: 't', version: '1.0.0' },
      paths: {},
    };

    const registry = createSchemaRegistry(doc);

    expect(doc.components).toEqual({ schemas: {} });
    expect(Object.keys(registry.componentSchemas)).toHaveLength(0);
  });

  it('returns existing pointer for already-registered schema object', () => {
    const pet = { type: 'object' };
    const doc: any = {
      openapi: '3.0.3',
      info: { title: 't', version: '1.0.0' },
      paths: {},
      components: { schemas: { Pet: pet } },
    };

    const registry = createSchemaRegistry(doc);
    const pointer = registerSchemaInComponents(registry, pet, 'PetAlias');

    expect(pointer).toBe('#/components/schemas/Pet');
  });

  it('creates a collision-safe name when preferred name already exists', () => {
    const doc: any = {
      openapi: '3.0.3',
      info: { title: 't', version: '1.0.0' },
      paths: {},
      components: { schemas: { Pet: { type: 'object' } } },
    };

    const registry = createSchemaRegistry(doc);
    const pointer = registerSchemaInComponents(registry, { type: 'object' }, 'Pet');

    expect(pointer).toBe('#/components/schemas/Pet_2');
    expect(registry.componentSchemas.Pet_2).toBeDefined();
  });

  it('replaces inline duplicates with component refs', () => {
    const shared = { type: 'string' };
    const root: any = {
      openapi: '3.0.3',
      info: { title: 't', version: '1.0.0' },
      paths: {},
      components: { schemas: { Id: shared } },
      properties: {
        id: shared,
      },
    };

    const registry = createSchemaRegistry(root);
    replaceHoistedObjectsWithRefs(root, registry);

    expect(root.properties.id).toStrictEqual({ $ref: '#/components/schemas/Id' });
    expect(root.components.schemas.Id).toBe(shared);
  });
});
