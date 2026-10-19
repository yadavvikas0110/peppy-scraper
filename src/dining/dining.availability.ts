import type { DiningAvailabilityStatus } from './dining.types';

/*
 * Effective availability of a stored menu item.
 *   availabilityStatus 'unknown'     → unknown (isAvailable is absent by contract)
 *   isAvailable true / false         → available / unavailable (every legacy document)
 *   status without a matching flag,
 *   or neither field                 → unknown; availability is never assumed
 */
export function resolveAvailabilityStatus(doc: { isAvailable?: unknown; availabilityStatus?: unknown }): DiningAvailabilityStatus {
  const status = doc.availabilityStatus;
  if (status === 'unknown') return 'unknown';
  if (status !== undefined && status !== 'available' && status !== 'unavailable') return 'unknown';
  if (doc.isAvailable === true) return status === 'unavailable' ? 'unknown' : 'available';
  if (doc.isAvailable === false) return status === 'available' ? 'unknown' : 'unavailable';
  return 'unknown';
}
