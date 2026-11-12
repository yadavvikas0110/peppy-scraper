import type { CustomSite, PlatformAdapter } from '../core/types';
import { jumboAdapter } from './jumbo.adapter';
import { letstangoAdapter } from './letstango.adapter';
import { mumzworldAdapter } from './mumzworld.adapter';
import { namshiAdapter } from './namshi.adapter';

export const ADAPTERS: Record<CustomSite, PlatformAdapter> = {
  namshi: namshiAdapter,
  mumzworld: mumzworldAdapter,
  jumbo: jumboAdapter,
  letstango: letstangoAdapter,
};
