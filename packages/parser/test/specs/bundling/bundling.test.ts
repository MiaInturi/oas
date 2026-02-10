import { describe, expect, it } from 'vitest';

import { bundle } from '../../../src/index.js';
import { relativePath } from '../../utils.js';

describe('bundle', () => {
  it('should bundle successfully', async () => {
    const api = await bundle(relativePath('specs/bundling/nullish-example.yaml'));

    expect(api).toStrictEqual({
      openapi: '3.0.3',
      info: {
        version: '1.0',
        title: 'API definition with a nullish example property',
      },
      paths: {
        '/anything': {
          get: {
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': {
                    schema: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/User-Information' },
                    },
                    example: { data: { first: null, last: 'lastname' } },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          'User-Information': {
            type: 'object',
            properties: { first: { type: 'boolean' }, last: { type: 'boolean' } },
          },
        },
      },
    });
  });

  it('should rewrite multi-file refs to internal refs', async () => {
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
        owner: { $ref: '#/components/schemas/User' },
      },
    });
    expect(bundledApi.components.schemas.User).toStrictEqual({
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

  it('should rewrite allOf schema refs away from path pointers', async () => {
    const api = await bundle(relativePath('specs/bundling/allof-ref-hoisting/openapi.yaml'));
    const bundledApi: any = api;

    expect(bundledApi.paths['/payment-requests'].post.requestBody.content['application/json'].schema).toStrictEqual({
      $ref: '#/components/schemas/PaymentFromCardViaIpsRequestData',
    });
    expect(bundledApi.components.schemas.PaymentFromCardViaIpsRequestData).toStrictEqual({
      allOf: [
        { $ref: '#/components/schemas/PaymentFromCardRequestData' },
        {
          type: 'object',
          properties: {
            receiverCardRequisites: {
              $ref: '#/components/schemas/CardRequisites',
              description: 'Receiver card requisites',
            },
          },
        },
      ],
    });
    expect(bundledApi.components.schemas.PaymentFromCardRequestData).toStrictEqual({
      allOf: [
        { type: 'object' },
        {
          type: 'object',
          properties: {
            senderCardRequisites: {
              $ref: '#/components/schemas/CardRequisites',
              description: 'Sender card requisites',
            },
          },
        },
      ],
    });
    expect(bundledApi.components.schemas.CardRequisites).toStrictEqual({
      type: 'object',
      properties: {
        token: { type: 'string' },
      },
    });
    expect(bundledApi.components.schemas.SenderCardRequisites).toBeUndefined();

    const refs = collectRefs(bundledApi.components.schemas);
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.some(ref => ref.startsWith('#/paths/'))).toBe(false);
  });

  it('should rewrite discriminator mapping filenames to component refs', async () => {
    const api = await bundle(relativePath('specs/bundling/discriminator-mapping/openapi.yaml'));
    const bundledApi: any = api;

    expect(bundledApi.paths['/events'].get.responses['200'].content['application/json'].schema).toStrictEqual({
      $ref: '#/components/schemas/EventBase',
    });
    expect(bundledApi.components.schemas.EventBase.discriminator.mapping).toStrictEqual({
      card: '#/components/schemas/CardEvent',
      bank: '#/components/schemas/BankEvent',
    });

    const mappingValues = Object.values(bundledApi.components.schemas.EventBase.discriminator.mapping);
    expect(
      mappingValues.every((value: unknown) => typeof value === 'string' && value.startsWith('#/components/schemas/')),
    ).toBe(true);
  });

  it('should preserve x-doc-refs exactly as source', async () => {
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
