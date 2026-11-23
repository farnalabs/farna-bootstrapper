import { SNAPSHOT, verifySnapshot } from '../../matrix/snapshot.js';
import { RENDERER_PIN } from '../../render/upstream.js';
import { buildCapabilityReport, type CapabilityReport } from '../../report/capability.js';

/**
 * Print the measured capability matrix. This command reads no source tree and
 * writes nothing: the matrix is a property of this build and its pinned
 * renderer, so it is useful in an empty directory and in CI.
 *
 * The snapshot is verified against the pinned renderer before it is printed.
 * A promised target with an unmeasured cell fails with F010 rather than
 * rendering an `unknown` as a tick.
 */
export function runReport(): CapabilityReport {
  verifySnapshot(SNAPSHOT, RENDERER_PIN.version);
  return buildCapabilityReport(SNAPSHOT);
}
