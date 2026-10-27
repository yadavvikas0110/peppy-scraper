import { createHash } from 'crypto';
import type { NormalizedOffer } from './offer.types';

// Same rule → same key, whatever the page language or the eligible item list at that moment.
export function offerKeyOf(offer: NormalizedOffer): string {
  const parts: Array<string | number> = [
    offer.type,
    offer.platformTypeName ?? '',
    offer.percentage ?? '',
    offer.minimumOrderValue ?? '',
    offer.maxDiscount ?? '',
    // Offers with no structured rule are told apart by their wording.
    offer.type === 'OTHER' ? (offer.title ?? '').trim().toLowerCase() : '',
  ];
  return createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
}
