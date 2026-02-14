export interface SchemaRegistry {
  schemaNames: Set<string>;
  schemaPointersByValue: WeakMap<object, string>;
  componentSchemas: Record<string, unknown>;
}

export interface ExternalSchemaNameResolver {
  nameByValue: WeakMap<object, string>;
  namesByFingerprint: Map<string, Set<string>>;
  canonicalByName: Map<string, Record<string, unknown>>;
  canonicalByFingerprint: Map<string, Map<string, Record<string, unknown>>>;
  schemaBySourcePath: Map<string, Record<string, unknown>>;
  sourcePathsByBaseName: Map<string, Set<string>>;
  componentNameBySourcePath: Map<string, string>;
  sourcePathByValue: WeakMap<object, string>;
  sourcePathByComponentName: Map<string, string>;
  loadingSourcePaths: Set<string>;
}
