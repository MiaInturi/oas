# @readme/openapi-parser (fork notes)

This package is maintained in a fork of [@readmeio/oas](https://github.com/readmeio/oas).

For full installation instructions, API surface (`parse`, `validate`, `dereference`, `bundle`), and general usage examples, see the upstream [README](https://github.com/readmeio/oas/tree/main/packages/parser#readme).

This document only covers behavior added in this fork.

## Fork-specific additions

This fork extends `bundle()` with a stronger schema normalization pipeline implemented in [`src/lib/hoistBundledSchemas/hoistBundledSchemas.ts`](src/lib/hoistBundledSchemas/hoistBundledSchemas.ts).

After bundling, output is normalized for production `OpenAPI` workflows:

- External schema files are hoisted into `#/components/schemas/...`.
- Local schema refs pointing to deep document paths (for example `#/paths/...`) are rewritten to component refs.
- Deep and composed schema structures are normalized consistently (including `allOf`, `oneOf`, `anyOf`, nested properties, and array items).
- `discriminator.mapping` filename values are converted to `#/components/schemas/...` refs.
- Top-level `x-doc-refs` metadata is preserved from source.

Additional normalization details:

- Inline schema objects matching known external or component schemas are replaced with component refs.
- `summary` and `description` are preserved when inline schemas are rewritten to `$ref`.

## Scope of impact

These fork-specific changes affect bundled output (`bundle()`). They do not change the baseline behavior of `parse()`, `dereference()`, or validation APIs beyond the fork's existing validation and error improvements.
