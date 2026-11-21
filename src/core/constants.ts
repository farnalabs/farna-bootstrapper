/**
 * Every on-disk name, exit code and fixed vocabulary the tool uses.
 * A name appears here once; no other module restates one. The comment is a
 * claim, so a duplicated literal is a defect: imports below are the only
 * spelling of each name.
 */

export const PRODUCT_NAME = 'farna-bootstrapper';
export const PRODUCT_VERSION = '0.1.0';
/** The one source/schema version this build understands. */
export const SCHEMA_VERSION = 1 as const;
/** The one lockfile mode this slice writes. */
export const MODE = 'agent' as const;

/** The source root, relative to the repository root. */
export const ROOT_DIR = '.farna';
export const CONFIG_FILE = 'config.jsonc';
export const CONFIG_PATH = `${ROOT_DIR}/${CONFIG_FILE}`;
export const LOCK_FILE = 'lock.json';
export const LOCK_PATH = `${ROOT_DIR}/${LOCK_FILE}`;
export const PERSONAS_DIR = 'personas';
export const RESOURCES_DIR = 'resources';
export const RULES_DIR = 'rules';
export const PERMISSIONS_DIR = 'permissions';

/** The extensions each source kind uses, and the one emitted artefacts use. */
export const PERSONA_FILE_EXT = '.yaml';
export const RULE_FILE_EXT = '.md';
export const PERMISSION_FILE_EXT = '.jsonc';
export const AGENT_FILE_EXT = '.md';

/** The one base persona a composed persona may extend. */
export const MAX_EXTENDS_DEPTH = 32;

/** The only target implemented in this slice. */
export const DEFAULT_TARGET = 'claudecode' as const;
export const SUPPORTED_TARGETS: readonly string[] = [DEFAULT_TARGET];

/** The harness directory and the rendered agent files, relative to the repository root. */
export const CLAUDE_DIR = '.claude';
export const CLAUDE_AGENTS_DIR = `${CLAUDE_DIR}/agents`;

/**
 * Operating-system metadata a checkout can create in a source directory. These
 * are not source: a source tree that has been on macOS or Windows must not stop
 * compiling because Finder wrote `.DS_Store`. Every other unexpected file stays a
 * hard error.
 */
export const OS_METADATA_NAMES: readonly string[] = ['.DS_Store', 'Thumbs.db', 'desktop.ini'];

export function isOsMetadataName(name: string): boolean {
  return OS_METADATA_NAMES.includes(name);
}

/** The local-only paths `init` adds to `.gitignore`, plus OS metadata. */
export const GITIGNORE_LINES: readonly string[] = [
  `${ROOT_DIR}/local.jsonc`,
  `${ROOT_DIR}/.journal.json`,
  ...OS_METADATA_NAMES,
];

/**
 * The two paths whose line endings change their committed bytes. `check`
 * compares bytes, so a checkout that rewrites them to CRLF would report drift
 * the source never declared. `init` merges these into the consumer's
 * `.gitattributes`.
 */
export const GITATTRIBUTES_LINES: readonly string[] = [
  `/${CLAUDE_AGENTS_DIR}/** text eol=lf`,
  `/${LOCK_PATH} text eol=lf`,
];

/**
 * Our own staging namespace. `commitFiles` writes hidden siblings named
 * `.<target>.farna-tmp-<pid>-<uuid>` on the same filesystem and renames them
 * into place; `check` ignores this namespace and `generate` sweeps it, so a
 * killed run can never make the tree permanently red.
 */
export const STAGING_INFIX = '.farna-tmp-';

/**
 * A lockfile is derived and small. Both this product's own lockfile
 * (`.farna/lock.json`) and an npm lock record the installed renderer identity
 * is read from are refused rather than read above this bound: a present record
 * that cannot be read is never treated as absent. Only a genuinely missing npm
 * record (a global install) falls back to the compile-time pin.
 */
export const LOCKFILE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * A managed file and a source file are bounded for the same reason: a
 * repository-controlled path must never make the process allocate until the JS
 * string limit throws an untyped `Invalid string length`.
 */
export const MANAGED_FILE_MAX_BYTES = 4 * 1024 * 1024;
export const SOURCE_MAX_BYTES = 4 * 1024 * 1024;

/** A staging sibling older than this is swept even when its pid was reused. */
export const STAGING_MAX_AGE_MS = 60 * 60 * 1000;

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
  /** `F008_DECLARED_NOT_EMITTED`: the renderer lost or invented declared content. */
  declaredNotEmitted: 4,
  /** `check` reports drift as exit 1. Drift is not an exception, so it has no F-code. */
  drift: 1,
  renderFailed: 5,
} as const satisfies Record<string, ExitCode>;

/** The code a drift item carries in a `check` payload. Not an error code. */
export const DRIFT_CODE = 'F007_DRIFT' as const;

export type ErrorCode =
  | 'F001_INVALID_CONFIG'
  | 'F003_PATH_UNSAFE'
  | 'F005_CONFLICT'
  | 'F008_DECLARED_NOT_EMITTED'
  | 'F009_RENDER_FAILED'
  | 'F010_RENDERER_MISMATCH'
  | 'F011_PERMISSION_UNMAPPED'
  | 'F012_WRITE_FAILED';

/** Exit code per diagnostic code. The table lives here once. F007 is absent: drift is a result. */
export const EXIT_BY_CODE: Record<ErrorCode, ExitCode> = {
  F001_INVALID_CONFIG: EXIT.invalidConfig,
  F003_PATH_UNSAFE: EXIT.invalidConfig,
  F005_CONFLICT: EXIT.conflict,
  F008_DECLARED_NOT_EMITTED: EXIT.declaredNotEmitted,
  F009_RENDER_FAILED: EXIT.renderFailed,
  F010_RENDERER_MISMATCH: EXIT.renderFailed,
  F011_PERMISSION_UNMAPPED: EXIT.refused,
  F012_WRITE_FAILED: EXIT.renderFailed,
};

export type Severity = 'error' | 'high' | 'medium' | 'low' | 'info';

export const WARNING_CODES = [
  'W106_DENY_WINS',
  'W111_ASK_DOWNGRADED',
  'W112_PERMISSION_LOSSY',
  'W113_ALLOW_LIST_NARROWS',
] as const;

export type WarningCode = (typeof WARNING_CODES)[number];

/**
 * A warning's default severity is a property of its code (schema.md section 7.2).
 * W106 is the only code whose severity depends on what it removes: a deny that
 * takes away an allow is medium, every other stricter-wins report is info.
 */
export const WARNING_SEVERITY: Record<WarningCode, Severity> = {
  W106_DENY_WINS: 'info',
  W111_ASK_DOWNGRADED: 'medium',
  W112_PERMISSION_LOSSY: 'high',
  W113_ALLOW_LIST_NARROWS: 'medium',
};
