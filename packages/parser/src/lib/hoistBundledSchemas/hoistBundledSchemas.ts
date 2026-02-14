import type { $RefParser, ParserOptions as $RefParserOptions } from '@apidevtools/json-schema-ref-parser';
import type { APIDocument } from '../../types.js';

import { isOpenAPI } from '../assertions.js';
import {
  addExternalNameCandidate,
  createExternalSchemaNameResolver,
  registerExternalSourcePath,
} from './helpers/externalResolver.js';
import { isRecord } from './helpers/guards.js';
import { createSchemaNameFromSourcePath } from './helpers/naming.js';
import { decodeJsonPointerToken } from './helpers/pointers.js';
import { createSchemaRegistry, registerSchemaInComponents, replaceHoistedObjectsWithRefs } from './helpers/registry.js';
import {
  collectSchemaTargets,
  rewriteDiscriminatorMappings,
  rewriteInlineExternalSchemasToComponentRefs,
  rewriteLocalSchemaRefsToComponents,
  rewriteSchemaRefsFromSourceTemplates,
} from './helpers/rewritePasses.js';

// Quick glossary (plain language):
// - "external schema": a schema that came from another file via `$ref`.
//   Example: `$ref: './schemas/Pet.yaml'`.
// - "registry": a map of schemas we already placed in `components.schemas`.
//   Example: once `Pet` is registered, every later match can reuse
//   `#/components/schemas/Pet`.
// - "resolver": helper maps that remember where external schemas came from.
//   Example: it can connect `CardEvent.yaml` -> real file path -> component name.
// - "component pointer": a normal OpenAPI ref like `#/components/schemas/Id`.
// - "inline schema": full schema JSON placed directly at a usage site instead of `$ref`.
//   Example: `schema: { type: 'object', properties: { id: { type: 'string' } } }`.

// Main post-bundle cleanup.
// We take parser output and normalize refs so the final document is easier to read and reuse.
export async function hoistBundledSchemas<S extends APIDocument = APIDocument>(
  parser: $RefParser<S>,
  parserOptions?: Partial<$RefParserOptions>,
): Promise<void> {
  // Step 0: only process OpenAPI documents with available ref metadata.
  if (!isOpenAPI(parser.schema) || !parser.$refs) {
    return;
  }

  // Step 1: create working state.
  // - registry: what is already in `components.schemas`.
  // - resolver: lookup tables for external files and schema identities.
  const registry = createSchemaRegistry(parser.schema);
  const externalNameResolver = createExternalSchemaNameResolver();

  // Step 2: look at every file/url that json-schema-ref-parser loaded.
  // `parser.$refs` is metadata created by json-schema-ref-parser during bundle().
  // `parser.$refs.paths()` returns all loaded resources.
  // First item is usually the main OpenAPI file; the rest are referenced files.
  const resolvedPaths = parser.$refs.paths();
  if (resolvedPaths.length) {
    const rootPath = resolvedPaths[0];
    const externalSchemas = new Map<object, string>();

    // Step 2a: save each referenced file schema in resolver maps.
    // This lets later passes answer: "which file did this schema come from?"
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

    // Step 2b: hoist external schemas that are actually used as schemas in the final document.
    // Important detail: we do NOT hoist every loaded file blindly.
    // We only hoist objects that appear in schema positions (request/response schemas, `properties`,
    // `items`, `allOf`, etc). That avoids creating useless components for non-schema files.
    //
    // Why this filtering matters:
    // - loaded refs can include things that are not reusable schema definitions
    // - some loaded schema files might never be referenced in actual schema context
    // - only "actually used as schema" objects should become components
    //
    // Concrete before/after:
    // - Before bundle output might have a schema object inlined under a response:
    //   `paths -> /pets -> get -> responses -> 200 -> ... -> schema = { type: 'object', ... }`
    // - After this step, that same object gets a component identity:
    //   `components.schemas.Pet = { type: 'object', ... }`
    //   and later refs can point to `#/components/schemas/Pet`.
    collectSchemaTargets(parser.schema, externalSchemas).forEach(({ sourcePath, value }) => {
      const pointer = registerSchemaInComponents(registry, value, createSchemaNameFromSourcePath(sourcePath));
      const componentName = decodeJsonPointerToken(pointer.split('/').at(-1) || '');
      externalNameResolver.componentNameBySourcePath.set(sourcePath, componentName);
      externalNameResolver.sourcePathByComponentName.set(componentName, sourcePath);
    });
  }

  // Step 3: rewrite local refs that still point to deep path locations.
  // Example: `#/paths/.../schema` -> `#/components/schemas/...`.
  rewriteLocalSchemaRefsToComponents(parser.schema, registry, externalNameResolver);

  // Step 4: replace inline schema bodies with refs when we can prove they are the same external
  // schema (by object identity or by fingerprint match).
  //
  // Why inline schemas happen in the first place:
  // 1) bundling can materialize external refs as concrete objects at usage sites
  // 2) composition (`allOf`/`oneOf`) and deep rewrites can duplicate/copy schema subtrees
  // 3) two inline objects can be "the same schema" logically but not the same JS object instance
  //
  // Why this matters:
  // - bundling often duplicates the same schema body in multiple places
  // - duplicated inline copies are hard to maintain and make output noisy
  //
  // Concrete examples:
  // - Before: two operations each contain a full `{ type: 'object', properties: ... }` copy of User
  // - After: both operations contain `{ $ref: '#/components/schemas/User' }`
  //
  // - Before: `allOf` branch contains a full inline `CardRequisites` object copied from another file
  // - After: branch becomes `{ $ref: '#/components/schemas/CardRequisites' }`
  // We preserve sibling `summary` / `description` when converting.
  rewriteInlineExternalSchemasToComponentRefs(parser.schema, registry, externalNameResolver);

  // Step 5: normalize discriminator mappings and "source-template refs".
  //
  // What is a source-template ref?
  // - During bundling, some `$ref` structure can be flattened into inline objects.
  // - We re-read the original source schema files (template) and compare shape against bundled
  //   output. If source had a file ref, we restore ref-style composition in output.
  //
  // Example:
  // - Source file: `allOf: [{ $ref: './BaseEvent.yaml' }, { type: 'object', ... }]`
  // - Bundled output may inline `BaseEvent` into a large object
  // - This step restores: `allOf: [{ $ref: '#/components/schemas/BaseEvent' }, ...]`
  //
  // We run twice because pass 1 can discover or load new schemas (for mappings/templates), and
  // those new discoveries may need one more normalization pass.
  for (let i = 0; i < 2; i += 1) {
    await rewriteDiscriminatorMappings(parser.schema, registry, externalNameResolver, parserOptions);
    await rewriteSchemaRefsFromSourceTemplates(parser.schema, registry, externalNameResolver, parserOptions);
  }

  // Step 6: final safety dedupe pass.
  // Why we still need this after previous rewrites:
  // - earlier passes may register components and rewrite many places, but some shared object
  //   instances can still remain inline due to traversal order or late-discovered identities.
  // - some refs/components are discovered in step 5; this final pass catches leftovers created
  //   before those discoveries existed.
  // - step 4 is "external-match focused" (identity/fingerprint); step 6 is a generic
  //   "if object already has component identity, force ref" sweep.
  // - this pass guarantees consistency: if an inline object already has a component pointer in the
  //   registry, replace it with that pointer.
  //
  // Practical result:
  // - fewer duplicate inline schema blobs
  // - a single canonical location for each reusable schema under `components.schemas`
  replaceHoistedObjectsWithRefs(parser.schema, registry);
}
