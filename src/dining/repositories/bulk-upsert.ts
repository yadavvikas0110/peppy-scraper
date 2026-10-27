import { AnyBulkWriteOperation, Collection, Document, Filter, MongoBulkWriteError, ObjectId, WithId } from 'mongodb';
import { DocumentUpdate, toMongoUpdate, UpsertStatus, upsertStatus } from './document-update';
import type { RejectedRecord } from './repository.types';

// One planned upsert per record: identity filter + field-level update, plus the in-memory
// result of applying it (already validated by the caller).
export interface PlannedUpsert<T extends Document> {
  sourceKey: string;
  filter: Filter<T>;
  update: DocumentUpdate;
  existing: WithId<T> | null;
  merged: T;
}

export interface BulkExecution {
  statuses: UpsertStatus[];
  rejected: RejectedRecord[];
}

export const BULK_CHUNK_SIZE = 500;

function writeErrorsOf(err: MongoBulkWriteError): Array<{ index: number; code: number; errmsg?: string }> {
  const list = Array.isArray(err.writeErrors) ? err.writeErrors : err.writeErrors ? [err.writeErrors] : [];
  return list.map(e => ({ index: e.index, code: e.code, errmsg: e.errmsg }));
}

/*
 * Unordered bulk upserts in chunks: one round trip per chunk, and a failing operation (e.g. a
 * duplicate key) never prevents the others in the chunk from being written. Errors other than
 * per-operation write errors (connection loss, auth) are rethrown.
 */
export async function executeBulkUpserts<T extends Document>(
  collection: Collection<T>,
  planned: PlannedUpsert<T>[],
  options: { dryRun?: boolean; chunkSize?: number } = {}
): Promise<BulkExecution> {
  const statuses: UpsertStatus[] = [];
  const rejected: RejectedRecord[] = [];

  if (options.dryRun) {
    for (const p of planned) statuses.push(upsertStatus(p.existing, p.merged));
    return { statuses, rejected };
  }

  const size = options.chunkSize ?? BULK_CHUNK_SIZE;
  for (let start = 0; start < planned.length; start += size) {
    const chunk = planned.slice(start, start + size);
    const ops: AnyBulkWriteOperation<T>[] = chunk.map(p => ({
      updateOne: { filter: p.filter, update: toMongoUpdate<T>(p.update), upsert: true },
    }));

    let upsertedIds: Record<number, unknown> = {};
    const failed = new Map<number, { code: number; errmsg?: string }>();
    try {
      const res = await collection.bulkWrite(ops, { ordered: false });
      upsertedIds = res.upsertedIds;
    } catch (err) {
      if (!(err instanceof MongoBulkWriteError)) throw err;
      upsertedIds = err.upsertedIds ?? {};
      const writeErrors = writeErrorsOf(err);
      if (writeErrors.length === 0) throw err;
      for (const e of writeErrors) failed.set(e.index, e);
    }

    chunk.forEach((p, i) => {
      const failure = failed.get(i);
      if (failure) {
        rejected.push({
          sourceKey: p.sourceKey,
          code: failure.code === 11000 ? 'DUPLICATE_KEY' : 'WRITE_ERROR',
          message: (failure.errmsg ?? `Write failed with code ${failure.code}`).slice(0, 500),
        });
        return;
      }
      if (i in upsertedIds) statuses.push('created');
      else statuses.push(p.existing ? upsertStatus(p.existing, p.merged) : 'updated');
    });
  }
  return { statuses, rejected };
}

export function countStatuses(statuses: UpsertStatus[]): { created: number; updated: number; unchanged: number } {
  return {
    created: statuses.filter(s => s === 'created').length,
    updated: statuses.filter(s => s === 'updated').length,
    unchanged: statuses.filter(s => s === 'unchanged').length,
  };
}

// sourceKey → _id after the write; in dry runs, existing ids or placeholders for would-be inserts.
export async function resolveIds<T extends Document>(
  collection: Collection<T>,
  restaurantId: ObjectId,
  planned: PlannedUpsert<T>[],
  rejected: RejectedRecord[],
  dryRun: boolean
): Promise<Map<string, ObjectId>> {
  const failed = new Set(rejected.map(r => r.sourceKey));
  const keys = planned.map(p => p.sourceKey).filter(k => !failed.has(k));
  const ids = new Map<string, ObjectId>();
  if (dryRun) {
    for (const p of planned) if (!failed.has(p.sourceKey)) ids.set(p.sourceKey, (p.existing?._id as ObjectId | undefined) ?? new ObjectId());
    return ids;
  }
  if (keys.length === 0) return ids;
  const docs = await collection
    .find({ restaurantId, sourceKey: { $in: keys } } as unknown as Filter<T>, { projection: { _id: 1, sourceKey: 1 } })
    .toArray();
  for (const d of docs) ids.set((d as unknown as { sourceKey: string }).sourceKey, d._id as unknown as ObjectId);
  return ids;
}
