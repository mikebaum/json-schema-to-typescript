import { whiteBright } from 'cli-color'
import { JSONSchema4Type, JSONSchema4TypeName } from 'json-schema'
import { findKey, includes, isPlainObject, map } from 'lodash'
import { typeOfSchema } from './typeOfSchema'
import { AST, hasStandaloneName, T_ANY, T_ANY_ADDITIONAL_PROPERTIES, TInterface, TInterfaceParam, TNamedInterface } from './types/AST'
import { JSONSchema, JSONSchemaWithDefinitions, SchemaSchema } from './types/JSONSchema'
import { error, generateName, log } from './utils'

export type Processed = Map<JSONSchema | JSONSchema4Type, AST>

export type UsedNames = Set<string>

export function parse(
  schema: JSONSchema | JSONSchema4Type,
  rootSchema = schema as JSONSchema,
  keyName?: string,
  isSchema = true,
  processed: Processed = new Map<JSONSchema | JSONSchema4Type, AST>(),
  usedNames = new Set<string>()
): AST {

  // If we've seen this node before, return it.
  if (processed.has(schema)) {
    return processed.get(schema)!
  }

  const definitions = getDefinitions(rootSchema)
  const keyNameFromDefinition = findKey(definitions, _ => _ === schema)

  // Cache processed ASTs before they are actually computed, then update
  // them in place using set(). This is to avoid cycles.
  // TODO: Investigate alternative approaches (lazy-computing nodes, etc.)
  let ast = {} as AST
  processed.set(schema, ast)
  const set = (_ast: AST) => Object.assign(ast, _ast)

  return isSchema
    ? parseNonLiteral(schema as SchemaSchema, rootSchema, keyName, keyNameFromDefinition, set, processed, usedNames)
    : parseLiteral(schema, keyName, keyNameFromDefinition, set)
}

function parseLiteral(
  schema: JSONSchema4Type,
  keyName: string | undefined,
  keyNameFromDefinition: string | undefined,
  set: (ast: AST) => AST
) {
  return set({
    keyName,
    params: schema,
    standaloneName: keyNameFromDefinition,
    type: 'LITERAL'
  })
}

function parseNonLiteral(
  schema: JSONSchema,
  rootSchema: JSONSchema,
  keyName: string | undefined,
  keyNameFromDefinition: string | undefined,
  set: (ast: AST) => AST,
  processed: Processed,
  usedNames: UsedNames
) {

  log(whiteBright.bgBlue('parser'), schema, '<-' + typeOfSchema(schema), processed.has(schema) ? '(FROM CACHE)' : '')

  switch (typeOfSchema(schema)) {
    case 'ALL_OF':
      return set({
        comment: schema.description,
        keyName,
        params: schema.allOf!.map(_ => parse(_, rootSchema, undefined, true, processed, usedNames)),
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames),
        type: 'INTERSECTION'
      })
    case 'ANY':
      return set({
        comment: schema.description,
        keyName,
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames),
        type: 'ANY'
      })
    case 'ANY_OF':
      return set({
        comment: schema.description,
        keyName,
        params: schema.anyOf!.map(_ => parse(_, rootSchema, undefined, true, processed, usedNames)),
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames),
        type: 'UNION'
      })
    case 'BOOLEAN':
      return set({
        comment: schema.description,
        keyName,
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames),
        type: 'BOOLEAN'
      })
    case 'NAMED_ENUM':
      return set({
        comment: schema.description,
        keyName,
        params: schema.enum!.map((_, n) => ({
          ast: parse(_, rootSchema, undefined, false, processed, usedNames),
          keyName: schema.tsEnumNames![n]
        })),
        standaloneName: standaloneName(schema, keyName, usedNames)!,
        type: 'ENUM'
      })
    case 'NAMED_SCHEMA':
      return set(newInterface(schema as SchemaSchema, rootSchema, processed, usedNames, keyName))
    case 'NULL':
      return set({
        comment: schema.description,
        keyName,
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames),
        type: 'NULL'
      })
    case 'NUMBER':
      return set({
        comment: schema.description,
        keyName,
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames),
        type: 'NUMBER'
      })
    case 'OBJECT':
      return set({
        comment: schema.description,
        keyName,
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames),
        type: 'OBJECT'
      })
    case 'ONE_OF':
      return set({
        comment: schema.description,
        keyName,
        params: schema.oneOf!.map(_ => parse(_, rootSchema, undefined, true, processed, usedNames)),
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames),
        type: 'UNION'
      })
    case 'REFERENCE':
      throw error('Refs should have been resolved by the resolver!', schema)
    case 'STRING':
      return set({
        comment: schema.description,
        keyName,
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames),
        type: 'STRING'
      })
    case 'TYPED_ARRAY':
      if (Array.isArray(schema.items)) {
        return set({
          comment: schema.description,
          keyName,
          params: schema.items.map(_ => parse(_, rootSchema, undefined, true, processed, usedNames)),
          standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames),
          type: 'TUPLE'
        })
      } else {
        return set({
          comment: schema.description,
          keyName,
          params: parse(schema.items!, rootSchema, undefined, true, processed, usedNames),
          standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames),
          type: 'ARRAY'
        })
      }
    case 'UNION':
      return set({
        comment: schema.description,
        keyName,
        params: (schema.type as JSONSchema4TypeName[]).map(_ => parse({ type: _ }, rootSchema, undefined, true, processed, usedNames)),
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames),
        type: 'UNION'
      })
    case 'UNNAMED_ENUM':
      return set({
        comment: schema.description,
        keyName,
        params: schema.enum!.map(_ => parse(_, rootSchema, undefined, false, processed, usedNames)),
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames),
        type: 'UNION'
      })
    case 'UNNAMED_SCHEMA':
      return set(newInterface(schema as SchemaSchema, rootSchema, processed, usedNames, keyName, keyNameFromDefinition))
    case 'UNTYPED_ARRAY':
      return set({
        comment: schema.description,
        keyName,
        params: T_ANY,
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames),
        type: 'ARRAY'
      })
  }
}

/**
 * Compute a schema name using a series of fallbacks
 */
function standaloneName(
  schema: JSONSchema,
  keyNameFromDefinition: string | undefined,
  usedNames: UsedNames
) {
  let name = schema.title || schema.id || keyNameFromDefinition
  if (name) {
    return generateName(name, usedNames)
  }
}

function newInterface(
  schema: SchemaSchema,
  rootSchema: JSONSchema,
  processed: Processed,
  usedNames: UsedNames,
  keyName?: string,
  keyNameFromDefinition?: string
): TInterface {
  return {
    comment: schema.description,
    keyName,
    params: parseSchema(schema, rootSchema, processed, usedNames),
    standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames),
    superTypes: parseSuperTypes(schema, processed, usedNames),
    type: 'INTERFACE'
  }
}

function parseSuperTypes(
  schema: SchemaSchema,
  processed: Processed,
  usedNames: UsedNames
): TNamedInterface[] {
  // Type assertion needed because of dereferencing step
  // TODO: Type it upstream
  const superTypes = schema.extends as SchemaSchema | SchemaSchema[] | undefined
  if (!superTypes) {
    return []
  }
  if (Array.isArray(superTypes)) {
    return superTypes.map(_ => newNamedInterface(_, _, processed, usedNames))
  }
  return [newNamedInterface(superTypes, superTypes, processed, usedNames)]
}

function newNamedInterface(
  schema: SchemaSchema,
  rootSchema: JSONSchema,
  processed: Processed,
  usedNames: UsedNames
): TNamedInterface {
  const namedInterface = newInterface(schema, rootSchema, processed, usedNames)
  if (hasStandaloneName(namedInterface)) {
    return namedInterface
  }
  // TODO: Generate name if it doesn't have one
  throw error('Supertype must have standalone name!', namedInterface)
}

/**
 * Helper to parse schema properties into params on the parent schema's type
 */
function parseSchema(
  schema: SchemaSchema,
  rootSchema: JSONSchema,
  processed: Processed,
  usedNames: UsedNames
): TInterfaceParam[] {

  const asts = map(schema.properties, (value, key: string) => ({
    ast: parse(value, rootSchema, key, true, processed, usedNames),
    isRequired: includes(schema.required || [], key),
    keyName: key
  }))

  // handle additionalProperties
  switch (schema.additionalProperties) {
    case undefined:
    case true:
      return asts.concat({
        ast: T_ANY_ADDITIONAL_PROPERTIES,
        isRequired: true,
        keyName: '[k: string]'
      })

    case false:
      return asts

    // pass "true" as the last param because in TS, properties
    // defined via index signatures are already optional
    default:
      return asts.concat({
        ast: parse(schema.additionalProperties, rootSchema, '[k: string]', true, processed, usedNames),
        isRequired: true,
        keyName: '[k: string]'
      })
  }
}

type Definitions = { [k: string]: JSONSchema }

/**
 * TODO: Memoize
 */
function getDefinitions(
  schema: JSONSchema,
  isSchema = true,
  processed = new Set<JSONSchema>()
): Definitions {
  if (processed.has(schema)) {
    return {}
  }
  processed.add(schema)
  if (Array.isArray(schema)) {
    return schema.reduce((prev, cur) => ({
      ...prev,
      ...getDefinitions(cur, false, processed)
    }), {})
  }
  if (isPlainObject(schema)) {
    return {
      ...(isSchema && hasDefinitions(schema) ? schema.definitions : {}),
      ...Object.keys(schema).reduce<Definitions>((prev, cur) => ({
        ...prev,
        ...getDefinitions(schema[cur], false, processed)
      }), {})
    }
  }
  return {}
}

/**
 * TODO: Reduce rate of false positives
 */
function hasDefinitions(schema: JSONSchema): schema is JSONSchemaWithDefinitions {
  return 'definitions' in schema
}
