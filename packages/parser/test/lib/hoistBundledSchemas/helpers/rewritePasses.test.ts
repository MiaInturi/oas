import { describe, expect, it } from 'vitest';

import {
  addExternalNameCandidate,
  createExternalSchemaNameResolver,
  registerExternalSourcePath,
} from '../../../../src/lib/hoistBundledSchemas/helpers/externalResolver.js';
import { createSchemaRegistry } from '../../../../src/lib/hoistBundledSchemas/helpers/registry.js';
import {
  collectSchemaTargets,
  rewriteDiscriminatorMappings,
  rewriteInlineExternalSchemasToComponentRefs,
  rewriteLocalSchemaRefsToComponents,
  rewriteSchemaRefsFromSourceTemplates,
} from '../../../../src/lib/hoistBundledSchemas/helpers/rewritePasses.js';

describe('rewrite passes', () => {
  it('collects schema targets from schema-context usage and skips component roots', () => {
    const external = { type: 'object' };
    const root = {
      components: { schemas: { External: external } },
      properties: {
        external,
      },
      examples: {
        external,
      },
    };

    const targets = collectSchemaTargets(root, new Map<object, string>([[external, '/spec/schemas/External.yaml']]));

    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ sourcePath: '/spec/schemas/External.yaml', value: external });
  });

  it('rewrites local schema refs to component refs', () => {
    const petSchema = { type: 'object' };
    const root: any = {
      openapi: '3.0.3',
      info: { title: 't', version: '1.0.0' },
      paths: {
        '/pets': {
          get: {
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: petSchema,
                  },
                },
              },
            },
          },
        },
      },
      components: { schemas: {} },
      properties: {
        pet: {
          $ref: '#/paths/~1pets/get/responses/200/content/application~1json/schema',
        },
      },
    };

    const resolver = createExternalSchemaNameResolver();
    addExternalNameCandidate(resolver, petSchema, 'Pet');

    const registry = createSchemaRegistry(root);
    rewriteLocalSchemaRefsToComponents(root, registry, resolver);

    expect(root.properties.pet.$ref).toBe('#/components/schemas/Pet');
    expect(root.components.schemas.Pet).toBe(petSchema);
  });

  it('rewrites inline external-equivalent schemas to refs and preserves summary', () => {
    const canonical = { type: 'object', properties: { id: { type: 'string' } } };
    const root: any = {
      openapi: '3.0.3',
      info: { title: 't', version: '1.0.0' },
      paths: {},
      components: { schemas: {} },
      properties: {
        user: {
          type: 'object',
          properties: { id: { type: 'string' } },
          summary: 'User shape',
        },
      },
    };

    const resolver = createExternalSchemaNameResolver();
    addExternalNameCandidate(resolver, canonical, 'User');

    const registry = createSchemaRegistry(root);
    rewriteInlineExternalSchemasToComponentRefs(root, registry, resolver);

    expect(root.properties.user).toStrictEqual({
      $ref: '#/components/schemas/User',
      summary: 'User shape',
    });
  });

  it('rewrites discriminator mapping filenames to component refs', async () => {
    const root: any = {
      openapi: '3.0.3',
      info: { title: 't', version: '1.0.0' },
      paths: {},
      components: {
        schemas: {
          EventBase: {
            type: 'object',
            discriminator: {
              propertyName: 'kind',
              mapping: {
                card: 'CardEvent.yaml',
              },
            },
          },
        },
      },
    };

    const resolver = createExternalSchemaNameResolver();
    const cardSchema = { type: 'object' };
    addExternalNameCandidate(resolver, cardSchema, 'CardEvent');
    registerExternalSourcePath(resolver, '/spec/schemas/CardEvent.yaml', cardSchema);

    const registry = createSchemaRegistry(root);
    await rewriteDiscriminatorMappings(root, registry, resolver);

    expect(root.components.schemas.EventBase.discriminator.mapping.card).toBe('#/components/schemas/CardEvent');
    expect(root.components.schemas.CardEvent).toBe(cardSchema);
  });

  it('rewrites schemas from source templates back to component refs', async () => {
    const sourcePath = '/spec/schemas/EventBase.yaml';
    const childSourcePath = '/spec/schemas/CardEvent.yaml';

    const root: any = {
      openapi: '3.0.3',
      info: { title: 't', version: '1.0.0' },
      paths: {},
      components: {
        schemas: {
          EventBase: {
            properties: {
              event: {
                type: 'object',
                summary: 'from bundled output',
              },
            },
          },
        },
      },
    };

    const registry = createSchemaRegistry(root);
    const resolver = createExternalSchemaNameResolver();

    resolver.sourcePathByComponentName.set('EventBase', sourcePath);
    resolver.schemaBySourcePath.set(sourcePath, {
      properties: {
        event: {
          $ref: './CardEvent.yaml',
        },
      },
    });

    const cardSchema = { type: 'object' };
    addExternalNameCandidate(resolver, cardSchema, 'CardEvent');
    registerExternalSourcePath(resolver, childSourcePath, cardSchema);

    await rewriteSchemaRefsFromSourceTemplates(root, registry, resolver);

    expect((registry.componentSchemas.EventBase as Record<string, unknown>).properties).toStrictEqual({
      event: {
        $ref: '#/components/schemas/CardEvent',
        summary: 'from bundled output',
      },
    });
    expect(root.components.schemas).toBe(registry.componentSchemas);
  });
});
