import type { DiningPlatform } from '../dining.types';
import { deliverooAdapter } from './deliveroo/deliveroo.adapter';
import { deliverooMapper } from './deliveroo/deliveroo.mapper';
import type { DiningPlatformMapper } from './platform.mapper';
import type { DiningPlatformAdapter } from './platform.types';

// Platform name → adapter (URLs, fetch options, parsing, identity) + mapper (canonical DTOs).
// Adding Talabat/Careem means adding an entry here; the orchestration flow does not change.
export interface DiningPlatformModule<TParseResult = unknown> {
  adapter: DiningPlatformAdapter<TParseResult>;
  mapper: DiningPlatformMapper<TParseResult>;
}

export type DiningPlatformRegistry = (platform: string) => DiningPlatformModule | undefined;

const MODULES: Partial<Record<DiningPlatform, DiningPlatformModule<any>>> = {
  deliveroo: { adapter: deliverooAdapter, mapper: deliverooMapper },
};

export const getDiningPlatformModule: DiningPlatformRegistry = platform =>
  Object.prototype.hasOwnProperty.call(MODULES, platform) ? MODULES[platform as DiningPlatform] : undefined;

export function getSupportedDiningPlatforms(): DiningPlatform[] {
  return Object.keys(MODULES) as DiningPlatform[];
}
