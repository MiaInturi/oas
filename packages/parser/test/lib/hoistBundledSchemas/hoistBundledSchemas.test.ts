import { describe, expect, it } from 'vitest';

import { hoistBundledSchemas } from '../../../src/lib/hoistBundledSchemas/hoistBundledSchemas.js';

describe('hoistBundledSchemas', () => {
  it('no-ops for non-OpenAPI schemas', async () => {
    const parser: any = {
      schema: {
        swagger: '2.0',
        info: { title: 'Swagger', version: '1.0.0' },
        paths: {},
      },
      $refs: {
        paths: () => [],
      },
    };

    await expect(hoistBundledSchemas(parser)).resolves.toBeUndefined();
    expect(parser.schema.swagger).toBe('2.0');
  });

  it('initializes components.schemas for OpenAPI docs with empty refs list', async () => {
    const parser: any = {
      schema: {
        openapi: '3.0.3',
        info: { title: 'OpenAPI', version: '1.0.0' },
        paths: {},
      },
      $refs: {
        paths: () => [],
      },
    };

    await hoistBundledSchemas(parser);

    expect(parser.schema.components).toEqual({ schemas: {} });
  });

  it('no-ops when refs metadata is missing', async () => {
    const parser: any = {
      schema: {
        openapi: '3.0.3',
        info: { title: 'OpenAPI', version: '1.0.0' },
        paths: {},
      },
    };

    await expect(hoistBundledSchemas(parser)).resolves.toBeUndefined();
    expect(parser.schema.components).toBeUndefined();
  });
});
