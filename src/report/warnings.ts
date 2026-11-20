import {
  type Capability,
  type Severity,
  WARNING_SEVERITY,
  type WarningCode,
} from '../core/constants.js';
import { compareCodepoints } from '../core/json.js';

export type Warning = {
  code: WarningCode;
  severity: Severity;
  persona: string;
  target: string;
  capability?: Capability;
  message: string;
};

export type WarningInput = {
  code: WarningCode;
  persona: string;
  target: string;
  capability?: Capability;
  message: string;
  severity?: Severity;
};

/** One warning record. Severity defaults to the code's table value. */
export function warning(input: WarningInput): Warning {
  return {
    code: input.code,
    severity: input.severity ?? WARNING_SEVERITY[input.code],
    persona: input.persona,
    target: input.target,
    ...(input.capability === undefined ? {} : { capability: input.capability }),
    message: input.message,
  };
}

/** Stable order for the lockfile and the report: code, then persona, then text. */
export function sortWarnings(warnings: readonly Warning[]): Warning[] {
  return [...warnings].sort((a, b) => {
    const byCode = compareCodepoints(a.code, b.code);
    if (byCode !== 0) {
      return byCode;
    }
    const byPersona = compareCodepoints(a.persona, b.persona);
    return byPersona === 0 ? compareCodepoints(a.message, b.message) : byPersona;
  });
}
