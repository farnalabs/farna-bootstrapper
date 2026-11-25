import {
  CONFIG_PATH,
  MANAGED_OUTPUT_DIRS,
  MANAGED_OUTPUT_FILES,
  type SupportedTarget,
} from '../core/constants.js';
import { conflict } from '../core/errors.js';
import { compareCodepoints } from '../core/json.js';
import type { Config } from './schema.js';
import { configuredTargets } from './targets.js';

/** A claimed location and the target ids that claim it. */
export type LocationCollision = {
  location: string;
  targets: string[];
};

/** The locations each target claims, keyed by target id. Synthetic tables are tests. */
export type LocationClaims = Readonly<Record<string, readonly string[]>>;

/**
 * Every managed location claimed by more than one target, in location order.
 *
 * This is the invariant the config rule rests on, and it is deliberately a
 * pure function over a caller-supplied table: two targets that can both own
 * one location make the recorded ownership of that location ambiguous, so the
 * refusal must not be a hard-coded pair of target ids. A future target that
 * shares a directory with an existing one is caught with no code change.
 *
 * Locations owned twice by the SAME target are not a collision: a target's own
 * claim is one claim.
 */
export function findLocationCollisions(claims: LocationClaims): LocationCollision[] {
  const owners = new Map<string, string[]>();
  for (const [target, locations] of Object.entries(claims)) {
    for (const location of new Set(locations)) {
      const claimants = owners.get(location) ?? [];
      if (!claimants.includes(target)) {
        claimants.push(target);
      }
      owners.set(location, claimants);
    }
  }

  const collisions: LocationCollision[] = [];
  for (const [location, targets] of owners) {
    if (targets.length > 1) {
      collisions.push({ location, targets: [...targets].sort(compareCodepoints) });
    }
  }
  return collisions.sort((a, b) => compareCodepoints(a.location, b.location));
}

/** The managed directories and whole files one target can own. */
export function managedLocationsOf(target: SupportedTarget): string[] {
  return [...MANAGED_OUTPUT_DIRS[target], ...MANAGED_OUTPUT_FILES[target]];
}

/** The configured targets with the locations each can own. */
export function configuredLocationClaims(
  config: Config,
): Record<SupportedTarget, readonly string[]> {
  const claims: Partial<Record<SupportedTarget, readonly string[]>> = {};
  for (const target of configuredTargets(config)) {
    claims[target] = managedLocationsOf(target);
  }
  return claims as Record<SupportedTarget, readonly string[]>;
}

/**
 * Refuse a config whose targets claim one managed location, before any source
 * is read or any render is planned.
 *
 * Two OpenCode majors collide because their location sets are equal; the
 * diagnostic names the shared locations and the target ids that claim them
 * rather than special-casing a pair. The code is `F005_CONFLICT` with exit 2,
 * the existing code for two declarations that disagree about one thing, and
 * nothing is written.
 */
export function assertNoLocationCollisions(config: Config): void {
  const collisions = findLocationCollisions(configuredLocationClaims(config));
  if (collisions.length === 0) {
    return;
  }
  const claimed = collisions
    .map((collision) => `${collision.location} (${collision.targets.join(', ')})`)
    .join('; ');
  throw conflict(`configured targets claim the same managed location(s): ${claimed}`, {
    subject: CONFIG_PATH,
    action:
      'remove one of the colliding targets from the config; two targets cannot own one location, because the recorded output of each would be ambiguous',
  });
}
