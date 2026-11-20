/**
 * Every on-disk name, exit code and fixed vocabulary the tool uses.
 * A name appears here once; no other module restates one.
 */

export const PRODUCT_NAME = 'farna-bootstrapper';
export const PRODUCT_VERSION = '0.1.0';
export const SCHEMA_VERSION = 1;

/** The source root, relative to the repository root. */
export const ROOT_DIR = '.farna';
export const CONFIG_FILE = 'config.jsonc';
export const LOCK_FILE = 'lock.json';
export const PERSONAS_DIR = 'personas';
export const RESOURCES_DIR = 'resources';
export const RULES_DIR = 'rules';
export const PERMISSIONS_DIR = 'permissions';
export const MODELS_DIR = 'models';

/** The one base persona a composed persona may extend. */
export const MAX_EXTENDS_DEPTH = 32;

/** The only target implemented in this slice. */
export const DEFAULT_TARGET = 'claudecode';
export const SUPPORTED_TARGETS: readonly string[] = [DEFAULT_TARGET];

/** Where the rendered Claude Code agent files land, relative to the repository root. */
export const CLAUDE_AGENTS_DIR = '.claude/agents';

export const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const ID_MAX_LENGTH = 64;

export type Capability = 'rule' | 'permission' | 'model';

/** Capabilities a persona resource reference may name in this slice. */
export const SUPPORTED_RESOURCE_KINDS: readonly Capability[] = ['rule', 'model', 'permission'];

export type ExitCode = 0 | 1 | 2 | 3 | 4 | 5;

export const EXIT = {
  ok: 0,
  invalidConfig: 1,
  conflict: 2,
  refused: 3,
  drift: 4,
  renderFailed: 5,
} as const satisfies Record<string, ExitCode>;

export type ErrorCode =
  | 'F001_INVALID_CONFIG'
  | 'F003_PATH_UNSAFE'
  | 'F005_CONFLICT'
  | 'F007_DRIFT'
  | 'F008_DECLARED_NOT_EMITTED'
  | 'F009_RENDER_FAILED'
  | 'F010_RENDERER_MISMATCH'
  | 'F011_PERMISSION_UNMAPPED';

/** Exit code per diagnostic code. The table lives here once. */
export const EXIT_BY_CODE: Record<ErrorCode, ExitCode> = {
  F001_INVALID_CONFIG: EXIT.invalidConfig,
  F003_PATH_UNSAFE: EXIT.invalidConfig,
  F005_CONFLICT: EXIT.conflict,
  F007_DRIFT: EXIT.drift,
  F008_DECLARED_NOT_EMITTED: EXIT.drift,
  F009_RENDER_FAILED: EXIT.renderFailed,
  F010_RENDERER_MISMATCH: EXIT.renderFailed,
  F011_PERMISSION_UNMAPPED: EXIT.refused,
};

export type Severity = 'error' | 'high' | 'medium' | 'low' | 'info';

export type WarningCode = 'W106_DENY_WINS' | 'W111_ASK_DOWNGRADED' | 'W112_PERMISSION_LOSSY';

/**
 * A warning's default severity is a property of its code (schema.md section 7.2).
 * W106 is the only code whose severity depends on what it removes: a deny that
 * takes away an allow is medium, every other stricter-wins report is info.
 */
export const WARNING_SEVERITY: Record<WarningCode, Severity> = {
  W106_DENY_WINS: 'info',
  W111_ASK_DOWNGRADED: 'medium',
  W112_PERMISSION_LOSSY: 'high',
};
