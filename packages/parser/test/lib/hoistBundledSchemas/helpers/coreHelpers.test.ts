import { describe, expect, it } from 'vitest';

import { createSchemaFingerprint } from '../../../../src/lib/hoistBundledSchemas/helpers/fingerprint.js';
import { isLikelySchemaObject, isObject, isRecord } from '../../../../src/lib/hoistBundledSchemas/helpers/guards.js';
import {
  createSchemaNameFromPointer,
  createSchemaNameFromSourcePath,
  createUniqueSchemaName,
  normalizeComponentName,
} from '../../../../src/lib/hoistBundledSchemas/helpers/naming.js';
import {
  decodeJsonPointerToken,
  encodeJsonPointerToken,
  isComponentSchemaRootPointer,
  resolveLocalPointer,
} from '../../../../src/lib/hoistBundledSchemas/helpers/pointers.js';
import { walk } from '../../../../src/lib/hoistBundledSchemas/helpers/walk.js';

describe('hoistBundledSchemas helper utilities', () => {
  describe('guards', () => {
    it('detects objects, records, and likely schema objects', () => {
      expect(isObject({})).toBe(true);
      expect(isObject(null)).toBe(false);

      expect(isRecord({ a: 1 })).toBe(true);
      expect(isRecord([1, 2, 3])).toBe(false);

      expect(isLikelySchemaObject({ type: 'object' })).toBe(true);
      expect(isLikelySchemaObject({ title: 'Not enough keys' })).toBe(false);
    });
  });

  describe('naming', () => {
    it('builds schema names from source paths', () => {
      expect(createSchemaNameFromSourcePath('/spec/schemas/Pet.yaml')).toBe('Pet');
      expect(createSchemaNameFromSourcePath('/spec/schemas/pet schema!.yml')).toBe('pet-schema-');
    });

    it('builds schema names from pointers', () => {
      expect(createSchemaNameFromPointer('#/components/schemas/user-profile')).toBe('UserProfile');
      expect(createSchemaNameFromPointer('#/paths/~1pets/get/responses/200/content/application~1json/schema')).toBe(
        'Schema',
      );
      expect(
        createSchemaNameFromPointer('#/paths/~1pets/get/responses/200/content/application~1json/schema/Pet.yaml'),
      ).toBe('Pet');
    });

    it('normalizes and deduplicates component names', () => {
      expect(normalizeComponentName('card-event.yaml')).toBe('CardEvent');
      expect(normalizeComponentName('***')).toBe('Schema');

      const names = new Set(['Pet', 'Pet_2']);
      expect(createUniqueSchemaName('Pet', names)).toBe('Pet_3');
      expect(names.has('Pet_3')).toBe(true);
    });
  });

  describe('pointers', () => {
    it('encodes and decodes JSON pointer tokens', () => {
      expect(encodeJsonPointerToken('a/b~c')).toBe('a~1b~0c');
      expect(decodeJsonPointerToken('a~1b~0c')).toBe('a/b~c');
    });

    it('handles malformed URI tokens in decoding', () => {
      expect(decodeJsonPointerToken('%E0%A4%A~1foo')).toBe('%E0%A4%A/foo');
    });

    it('detects component schema root pointers', () => {
      expect(isComponentSchemaRootPointer('#/components/schemas/Pet')).toBe(true);
      expect(isComponentSchemaRootPointer('#/components/schemas/Pet/properties/id')).toBe(false);
    });

    it('resolves local pointers across objects and arrays', () => {
      const root = {
        'a/b': {
          '~key': [{ value: 3 }],
        },
      };

      expect(resolveLocalPointer(root, '#/a~1b/~0key/0/value')).toBe(3);
      expect(resolveLocalPointer(root, '#/a~1b/~0key/not-a-number')).toBeUndefined();
      expect(resolveLocalPointer(root, 'http://example.com/schema')).toBeUndefined();
      expect(resolveLocalPointer(root, '#')).toBe(root);
    });
  });

  describe('fingerprint', () => {
    it('ignores root summary/description and key order', () => {
      const first = {
        type: 'object',
        summary: 'A',
        description: 'one',
        properties: {
          b: { type: 'string' },
          a: { type: 'number' },
        },
      };

      const second = {
        description: 'two',
        summary: 'B',
        properties: {
          a: { type: 'number' },
          b: { type: 'string' },
        },
        type: 'object',
      };

      expect(createSchemaFingerprint(first)).toBe(createSchemaFingerprint(second));
    });

    it('keeps nested summary/description differences', () => {
      const first = {
        type: 'object',
        properties: {
          child: { type: 'string', summary: 'A' },
        },
      };

      const second = {
        type: 'object',
        properties: {
          child: { type: 'string', summary: 'B' },
        },
      };

      expect(createSchemaFingerprint(first)).not.toBe(createSchemaFingerprint(second));
    });
  });

  describe('walk', () => {
    it('tracks schema context through schema keys', () => {
      const root = {
        properties: {
          user: { type: 'object' },
        },
        examples: [{ foo: 'bar' }],
      };

      const visited = new Map<string, boolean>();
      walk(root, false, '#', new WeakSet<object>(), (_value, pointer, inSchemaContext) => {
        visited.set(pointer, inSchemaContext);
      });

      expect(visited.get('#/properties/user')).toBe(true);
      expect(visited.get('#/examples/0')).toBe(false);
    });

    it('does not recurse forever with circular structures', () => {
      const root: Record<string, unknown> = { properties: {} };
      (root.properties as Record<string, unknown>).self = root;

      let visits = 0;
      walk(root, false, '#', new WeakSet<object>(), () => {
        visits += 1;
      });

      expect(visits).toBeGreaterThan(0);
      expect(visits).toBeLessThan(20);
    });
  });
});
