export type ScalarKind = "number" | "money" | "string" | "boolean" | "date";

export type FieldType =
  | { kind: ScalarKind }
  | { kind: "enum"; name: string }
  | { kind: "list"; element: FieldType };

export interface FieldDef {
  name: string;
  type: FieldType;
  nullable: boolean;
  description: string;
}

export interface EntityDef {
  name: string;
  writable: boolean;
  fields: FieldDef[];
}

export interface EnumDef {
  name: string;
  values: string[];
}

export interface Schema {
  name: string;
  enums: Record<string, EnumDef>;
  entities: Record<string, EntityDef>;
  roots: Record<string, string>;
  output: string;
}

export function field(name: string, type: FieldType, nullable: boolean, description: string): FieldDef {
  return { name, type, nullable, description };
}

export const t = {
  number: { kind: "number" } as FieldType,
  money: { kind: "money" } as FieldType,
  string: { kind: "string" } as FieldType,
  boolean: { kind: "boolean" } as FieldType,
  date: { kind: "date" } as FieldType,
  enumOf: (name: string): FieldType => ({ kind: "enum", name }),
  listOf: (element: FieldType): FieldType => ({ kind: "list", element }),
};

export function rootEntity(schema: Schema, root: string): EntityDef | undefined {
  const entityName = schema.roots[root];
  return entityName === undefined ? undefined : schema.entities[entityName];
}

export function findField(entity: EntityDef, name: string): FieldDef | undefined {
  return entity.fields.find((f) => f.name === name);
}

export function describeFieldType(type: FieldType): string {
  switch (type.kind) {
    case "enum":
      return type.name;
    case "list":
      return `list of ${describeFieldType(type.element)}`;
    default:
      return type.kind;
  }
}

export function validateSchema(schema: Schema): string[] {
  const problems: string[] = [];
  const checkType = (where: string, type: FieldType): void => {
    if (type.kind === "enum" && schema.enums[type.name] === undefined) {
      problems.push(`${where}: unknown enum ${type.name}`);
    }
    if (type.kind === "list") checkType(where, type.element);
  };
  for (const [root, entityName] of Object.entries(schema.roots)) {
    if (schema.entities[entityName] === undefined) problems.push(`root ${root}: unknown entity ${entityName}`);
  }
  if (schema.roots[schema.output] === undefined) problems.push(`output root ${schema.output} is not declared`);
  for (const entity of Object.values(schema.entities)) {
    const seen = new Set<string>();
    for (const f of entity.fields) {
      if (seen.has(f.name)) problems.push(`${entity.name}.${f.name}: duplicate field`);
      seen.add(f.name);
      checkType(`${entity.name}.${f.name}`, f.type);
    }
  }
  for (const e of Object.values(schema.enums)) {
    if (new Set(e.values).size !== e.values.length) problems.push(`enum ${e.name}: duplicate values`);
  }
  return problems;
}
