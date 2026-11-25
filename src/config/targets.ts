import type { SupportedTarget } from '../core/constants.js';
import { compareCodepoints } from '../core/json.js';
import type { Config } from './schema.js';

/**
 * Every configured target id, in codepoint order.
 *
 * This is the one place the configured set is computed. It lives in the config
 * layer rather than in the compose layer because the location-collision guard
 * runs at config load: a helper that lived under `compose/` would make the
 * schema loader depend on the composition pipeline, and the guard must run
 * before any source is read or any render is planned.
 *
 * The config schema validates every key against `SUPPORTED_TARGETS`, so the
 * cast is a narrowing of a set the parser has already refused otherwise.
 */
export function configuredTargets(config: Config): SupportedTarget[] {
  return (Object.keys(config.targets) as SupportedTarget[]).sort(compareCodepoints);
}
