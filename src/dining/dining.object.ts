// Plain-object helpers with no database dependency (usable by mappers and repositories alike).

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Removes `undefined` values recursively from plain objects/arrays (the MongoDB driver would store
// them as null). Class instances such as Date or ObjectId are kept as-is.
export function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map(v => stripUndefined(v)) as unknown as T;
  if (!isPlainRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = stripUndefined(v);
  return out as T;
}
