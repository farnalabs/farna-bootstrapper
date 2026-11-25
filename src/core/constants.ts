/**
 * Every on-disk name, exit code and fixed vocabulary the tool uses.
 * A name appears here once; no other module restates one. The comment is a
 * claim, so a duplicated literal is a defect: imports below are the only
 * spelling of each name.
 */

export const PRODUCT_NAME = 'farna-bootstrapper';
export const PRODUCT_VERSION = '0.2.0';

/**
 * The source config format: `.farna/config.jsonc` and the value `init` writes.
 * It is unrelated to the lockfile and to the CLI payload, which each have their
 * own version below; one number for three formats made every change to one look
 * like a change to all three.
 */
export const CONFIG_SCHEMA_VERSION = 1 as const;
/**
 * The `.farna/lock.json` document. A version 1 document is still read and
 * normalised to the version 2 in-memory shape; writing always produces version
 * 2, so the first `generate` after an upgrade rewrites the file.
 */
export const LOCKFILE_SCHEMA_VERSION = 2 as const;
/** The `--json` payload envelope every command emits. */
export const CLI_SCHEMA_VERSION = 2 as const;

/**
 * The OpenCode major each OpenCode target is measured against. `opencode` is
 * OpenCode 2.x (`@opencode/cli`): the V2 per-agent file (`description`, `mode`,
 * `model`, ordered permission records, no `name`), the `mcp.servers` envelope
 * and the `{ id, setup }` plugin. `opencodev1` is OpenCode 1.x (`opencode-ai`):
 * V1 agent frontmatter with `name`, the per-tool `permission` map, the flat
 * `mcp.<name>` map and the `RulesyncHooksPlugin` module. Both write the same
 * paths. This is documentation for the user, not a runtime probe: the tool
 * never shells out to OpenCode.
 */
export const OPENCODE_SUPPORTED_MAJOR = '2';
export const OPENCODE_V1_SUPPORTED_MAJOR = '1';

/**
 * The render modes this build can write. `agent` is the default: every persona
 * is live and carried per agent. `profile` is selected by
 * `targets.<target>.active` or the `--persona` override, makes exactly one
 * persona live, and lets it own the workspace at the repository root.
 */
export const RENDER_MODES = ['agent', 'profile'] as const;
export type RenderMode = (typeof RENDER_MODES)[number];
export const MODE_AGENT: RenderMode = 'agent';
export const MODE_PROFILE: RenderMode = 'profile';

/**
 * The OpenCode per-agent `mode` values a persona may declare. `primary` makes
 * the agent selectable as the main agent, `subagent` makes it callable only by
 * another agent, and `all` makes it both. The value is OpenCode-facing: Claude
 * Code has no such concept, so a declared mode there is reported (W117) and not
 * emitted. `subagent` is the default when a persona declares no mode, which is
 * the same default this tool emitted before the field existed.
 */
export const PERSONA_MODES = ['primary', 'subagent', 'all'] as const;
export type PersonaMode = (typeof PERSONA_MODES)[number];
export const DEFAULT_PERSONA_MODE: PersonaMode = 'subagent';

/** The source root, relative to the repository root. */
export const ROOT_DIR = '.farna';
export const CONFIG_FILE = 'config.jsonc';
export const CONFIG_PATH = `${ROOT_DIR}/${CONFIG_FILE}`;
export const LOCK_FILE = 'lock.json';
export const LOCK_PATH = `${ROOT_DIR}/${LOCK_FILE}`;

/**
 * The exclusive run lock: a **directory** created with `mkdir` (atomic on every
 * supported filesystem), with the owner pid inside. Two `generate` runs in one
 * repository would each plan from the same lockfile and each remove and rewrite
 * the managed set, so the second could delete what the first just wrote (or
 * commit a plan it computed before the first changed the tree). The lock is
 * local-only state, never committed, and its presence is not a managed output.
 */
export const GENERATE_LOCK_FILE = '.generate.lock';
export const GENERATE_LOCK_PATH = `${ROOT_DIR}/${GENERATE_LOCK_FILE}`;
/** How long a lockfile whose owner pid is still alive is honoured before it is treated as orphaned. */
export const GENERATE_LOCK_STALE_MS = 24 * 60 * 60 * 1000;

/** Generated files are `0644`, generated directories `0755`, whatever the umask. */
export const OUTPUT_FILE_MODE = 0o644;
export const OUTPUT_DIR_MODE = 0o755;
export const PERSONAS_DIR = 'personas';
export const RESOURCES_DIR = 'resources';
export const RULES_DIR = 'rules';
export const PERMISSIONS_DIR = 'permissions';
export const MCP_DIR = 'mcp';
export const SKILLS_DIR = 'skills';
export const COMMANDS_DIR = 'commands';
export const HOOKS_DIR = 'hooks';

/** The extensions each source kind uses, and the one emitted artefacts use. */
export const PERSONA_FILE_EXT = '.yaml';
export const RULE_FILE_EXT = '.md';
export const PERMISSION_FILE_EXT = '.jsonc';
export const COMMAND_FILE_EXT = '.md';
export const STRUCTURED_RESOURCE_FILE_EXT = '.jsonc';
export const SKILL_FILE_NAME = 'SKILL.md';
export const AGENT_FILE_EXT = '.md';

/** The one base persona a composed persona may extend. */
export const MAX_EXTENDS_DEPTH = 32;

/**
 * The targets this build renders. A config may name several, at most one per
 * output-path family: the location-collision guard refuses two targets that
 * would write the same locations, because the lockfile records ownership by
 * path.
 */
export const DEFAULT_TARGET = 'claudecode' as const;
export const OPENCODE_TARGET = 'opencode' as const;
export const OPENCODE_V1_TARGET = 'opencodev1' as const;
export type SupportedTarget =
  | typeof DEFAULT_TARGET
  | typeof OPENCODE_TARGET
  | typeof OPENCODE_V1_TARGET;
/** The supported targets as a tuple, so a schema can validate against exactly them. */
export const TARGET_ENUM = [DEFAULT_TARGET, OPENCODE_TARGET, OPENCODE_V1_TARGET] as const;
export const SUPPORTED_TARGETS: readonly SupportedTarget[] = TARGET_ENUM;

/**
 * Both OpenCode targets write the same paths and the same workspace kinds; only
 * the emitted shapes differ. Every branch that means "the OpenCode family"
 * consults this list rather than repeating the two ids, so a third major is one
 * edit.
 */
export const OPENCODE_TARGETS: readonly SupportedTarget[] = [OPENCODE_TARGET, OPENCODE_V1_TARGET];

/** A target in the OpenCode family, so a member type cannot drift from the list. */
export type OpencodeTarget = (typeof OPENCODE_TARGETS)[number];

export function isOpencodeTarget(target: SupportedTarget): target is OpencodeTarget {
  return (OPENCODE_TARGETS as readonly SupportedTarget[]).includes(target);
}

/**
 * The targets that support profile mode in this build. Profile mode needs a
 * workspace a single persona can own end to end; the OpenCode targets'
 * workspace resource kinds (`mcp`, `skill`, `command`, `hook`) make them the
 * first targets. Claude Code's only workspace-only capability is `command`, a
 * content capability that does not force a profile, so profile mode there is
 * later work and `active` is refused rather than silently ignored.
 */
export const PROFILE_TARGETS: readonly SupportedTarget[] = [OPENCODE_TARGET, OPENCODE_V1_TARGET];

export function targetSupportsProfile(target: SupportedTarget): boolean {
  return PROFILE_TARGETS.includes(target);
}

/**
 * The capabilities that *force* profile mode rather than merely being carried
 * by it. Only a boundary capability the target can express at the workspace
 * level and nowhere else forces the mode: on OpenCode that is `mcp` and `hook`.
 * A `skill` or `command` is content the target could in principle drop with a
 * loss, so selecting profile mode for it is a choice and is reported as W109.
 */
export const PROFILE_FORCING_KINDS: readonly Capability[] = ['mcp', 'hook'];

/** The Claude Code directories, relative to the repository root. */
export const CLAUDE_DIR = '.claude';
export const CLAUDE_AGENTS_DIR = `${CLAUDE_DIR}/agents`;

/**
 * The OpenCode paths this slice writes, relative to the repository root.
 * `commands` is plural and the workspace config is `opencode.jsonc`, both
 * measured at rulesync 43.14.0.
 */
export const OPENCODE_DIR = '.opencode';
export const OPENCODE_AGENTS_DIR = `${OPENCODE_DIR}/agents`;
export const OPENCODE_COMMANDS_DIR = `${OPENCODE_DIR}/commands`;
export const OPENCODE_SKILLS_DIR = `${OPENCODE_DIR}/skills`;
export const OPENCODE_PLUGINS_DIR = `${OPENCODE_DIR}/plugins`;
export const OPENCODE_CONFIG_FILE = 'opencode.jsonc';
export const OPENCODE_HOOKS_PLUGIN = `${OPENCODE_PLUGINS_DIR}/rulesync-hooks.js`;
/** The rulesync source files a workspace resource kind needs. */
export const RULESYNC_MCP_FILE = 'mcp.jsonc';
export const RULESYNC_HOOKS_FILE = 'hooks.jsonc';

/**
 * The locations a target can own. `generate` may delete a lockfile-recorded
 * file only when it lies in one of these locations, is still a regular file,
 * and its bytes still equal the recorded digest. Everything outside them is
 * user content, never swept.
 */
const OPENCODE_OUTPUT_DIRS: readonly string[] = [
  OPENCODE_AGENTS_DIR,
  OPENCODE_COMMANDS_DIR,
  OPENCODE_SKILLS_DIR,
  OPENCODE_PLUGINS_DIR,
];

export const MANAGED_OUTPUT_DIRS: Readonly<Record<SupportedTarget, readonly string[]>> = {
  claudecode: [CLAUDE_AGENTS_DIR],
  opencode: OPENCODE_OUTPUT_DIRS,
  // Both OpenCode targets write the same locations, so a target switch rewrites
  // the recorded paths in place rather than orphaning one target's output.
  opencodev1: OPENCODE_OUTPUT_DIRS,
};

/** Whole files at the repository root that a target can own. */
export const MANAGED_OUTPUT_FILES: Readonly<Record<SupportedTarget, readonly string[]>> = {
  claudecode: [],
  opencode: [OPENCODE_CONFIG_FILE],
  opencodev1: [OPENCODE_CONFIG_FILE],
};

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

/**
 * Our own staging namespace. `commitFiles` writes hidden siblings named
 * `.<target>.farna-tmp-<pid>-<uuid>` on the same filesystem and renames them
 * into place; `check` ignores this namespace and `generate` sweeps it, so a
 * killed run can never make the tree permanently red.
 */
export const STAGING_INFIX = '.farna-tmp-';
/** The `.gitignore` pattern for the staging namespace, at any depth. */
export const STAGING_PATTERN = `**/.*${STAGING_INFIX}*`;

/**
 * The local-only paths `init` adds to `.gitignore`, plus OS metadata. The
 * staging pattern keeps a killed `generate`'s temporary sibling, which can
 * appear in any managed directory, out of a commit.
 */
export const GITIGNORE_LINES: readonly string[] = [
  `${ROOT_DIR}/local.jsonc`,
  `${ROOT_DIR}/.journal.json`,
  `/${GENERATE_LOCK_PATH}`,
  `${STAGING_PATTERN}`,
  ...OS_METADATA_NAMES,
];

/**
 * The managed paths whose line endings change their committed bytes. `check`
 * compares bytes, so a checkout that rewrites them to CRLF would report drift
 * the source never declared. `init` merges these into the consumer's
 * `.gitattributes` for every supported target, so switching target in the
 * config does not leave the new outputs unpinned.
 */
export const GITATTRIBUTES_LINES: readonly string[] = [
  // The whole source root, so a CRLF checkout cannot change `configDigest` or
  // any persona and resource byte between two machines.
  `/${ROOT_DIR}/** text eol=lf`,
  `/${CLAUDE_AGENTS_DIR}/** text eol=lf`,
  `/${OPENCODE_AGENTS_DIR}/** text eol=lf`,
  `/${OPENCODE_COMMANDS_DIR}/** text eol=lf`,
  `/${OPENCODE_SKILLS_DIR}/** text eol=lf`,
  `/${OPENCODE_PLUGINS_DIR}/** text eol=lf`,
  `/${OPENCODE_CONFIG_FILE} text eol=lf`,
  `/${LOCK_PATH} text eol=lf`,
];

/**
 * This product's own lockfile (`.farna/lock.json`) is derived and small: it
 * records the config hash, the file list and the renderer pin, so it is refused
 * rather than read above this bound. It also bounds the small package manifests
 * read to locate the installed renderer; npm's lock records use the separate
 * `NPM_LOCKFILE_MAX_BYTES` below.
 */
export const LOCKFILE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * npm's lock records (`node_modules/.package-lock.json` and a project
 * `package-lock.json`) scale with the dependency tree: a monorepo lockfile can
 * legitimately be several megabytes, far above this product's own derived
 * lockfile. The bound is generous so a real record is read, and still finite so
 * a repository-controlled path can never allocate without limit.
 *
 * The renderer's entry is searched for under any `packages` key ending in
 * `node_modules/<renderer-name>`, so a nested install
 * (`node_modules/<product>/node_modules/<renderer>`) is read rather than
 * mistaken for an absent record. The installed version is enforced regardless;
 * a found entry's integrity is compared with the pin; a record with no renderer
 * entry anywhere in it (a global install that wrote no npm lockfile) yields
 * `W114_RENDERER_INTEGRITY_UNVERIFIED` and never substitutes the compile-time
 * pin as a verified integrity. A present record that cannot be read, or is
 * above this bound, is refused (F010) instead of warning.
 */
export const NPM_LOCKFILE_MAX_BYTES = 64 * 1024 * 1024;

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

export type Capability = 'rule' | 'mcp' | 'skill' | 'command' | 'permission' | 'hook' | 'model';

/**
 * Capabilities a persona resource reference may name in this slice. `model` is
 * absent: a model is expressed with the persona's `model` class, and a
 * `model/<id>` reference is refused rather than accepted and ignored.
 */
export const SUPPORTED_RESOURCE_KINDS: readonly Capability[] = [
  'rule',
  'permission',
  'mcp',
  'skill',
  'command',
  'hook',
];

/**
 * The capability class of each resource kind. A dropped
 * boundary capability is HIGH and can refuse; a dropped content capability is
 * MEDIUM and can only produce a loss.
 */
export const BOUNDARY_CAPABILITIES: readonly Capability[] = ['permission', 'hook', 'mcp'];

/** The resource kinds the OpenCode targets carry only at the workspace level. */
export const OPENCODE_WORKSPACE_KINDS: readonly Capability[] = ['mcp', 'skill', 'command', 'hook'];

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

/**
 * The code a drift item carries when the finding is not a changed byte of ours
 * but content outside our ownership: an unrecorded file in a managed location,
 * or an extra file in a skill tree. `check` fails on it because the path is
 * live, but `generate` never deletes it.
 */
export const OUTSIDE_OWNERSHIP_CODE = 'W107_OUTSIDE_OWNERSHIP' as const;

export type ErrorCode =
  | 'F001_INVALID_CONFIG'
  | 'F002_SECRET_LITERAL'
  | 'F003_PATH_UNSAFE'
  | 'F005_CONFLICT'
  | 'F008_DECLARED_NOT_EMITTED'
  | 'F009_RENDER_FAILED'
  | 'F010_RENDERER_MISMATCH'
  | 'F011_PERMISSION_UNMAPPED'
  | 'F012_WRITE_FAILED';

/**
 * A code the CLI can report. `ErrorCode` is the exception table; `DRIFT_CODE`
 * is included because `generate` refuses to take over an unrecorded managed
 * file with F007, the same code `check` reports as a drift result. `check`
 * never throws it, so the exception table stays free of it.
 */
export type DiagnosticCode = ErrorCode | typeof DRIFT_CODE;

/** Exit code per diagnostic code. The table lives here once. F007 is absent: drift is a result. */
export const EXIT_BY_CODE: Record<ErrorCode, ExitCode> = {
  F001_INVALID_CONFIG: EXIT.invalidConfig,
  F002_SECRET_LITERAL: EXIT.invalidConfig,
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
  'W101_CAPABILITY_DROPPED',
  'W106_DENY_WINS',
  'W107_OUTSIDE_OWNERSHIP',
  'W109_PROFILE_BY_CHOICE',
  'W111_ASK_DOWNGRADED',
  'W112_PERMISSION_LOSSY',
  'W113_ALLOW_LIST_NARROWS',
  'W114_RENDERER_INTEGRITY_UNVERIFIED',
  'W115_CREDENTIAL_IN_URL',
  'W116_SECRET_IN_ARGS',
  'W117_PERSONA_MODE_IGNORED',
  'W118_PERSONA_FLAG_NOT_APPLIED',
] as const;

export type WarningCode = (typeof WARNING_CODES)[number];

/**
 * A warning's default severity is a property of its code.
 * W106 is the only code whose severity depends on what it removes: a deny that
 * takes away an allow is medium, every other stricter-wins report is info.
 *
 * W114 is medium, not high: the renderer's version is still enforced, so a
 * different renderer cannot pass. What is missing is the tarball digest that
 * ties the installed bytes to the published package, which makes this a
 * provenance caveat rather than a correctness failure. It is not info either:
 * a run whose integrity could not be checked must never look like a clean
 * integrity pass. High is reserved for a warning that records a real loss
 * (W112), which this is not.
 *
 * W101's severity is dynamic: `high` for a boundary capability (`permission`,
 * `hook`, `mcp`), `medium` for content (`rule`, `model`, `skill`, `command`).
 * The table value is the content default; every boundary emission passes
 * `high` explicitly so the classification is visible at the call site.
 */
export const WARNING_SEVERITY: Record<WarningCode, Severity> = {
  W101_CAPABILITY_DROPPED: 'medium',
  W106_DENY_WINS: 'info',
  W107_OUTSIDE_OWNERSHIP: 'low',
  W109_PROFILE_BY_CHOICE: 'info',
  W111_ASK_DOWNGRADED: 'medium',
  W112_PERMISSION_LOSSY: 'high',
  W113_ALLOW_LIST_NARROWS: 'medium',
  W114_RENDERER_INTEGRITY_UNVERIFIED: 'medium',
  W115_CREDENTIAL_IN_URL: 'high',
  W116_SECRET_IN_ARGS: 'high',
  // W117 is info: the declaration is not carried, but nothing the target
  // supports is lost. Claude Code has no primary/subagent mode, and the agent
  // file is still emitted with every capability it can carry.
  W117_PERSONA_MODE_IGNORED: 'info',
  // W118 is info: the flag was ignored for one configured target, but that
  // target still renders in its default agent mode with every persona live, so
  // nothing is lost. It is invocation-level, never source-derived, and is
  // therefore reported by the command without being recorded in the lockfile.
  W118_PERSONA_FLAG_NOT_APPLIED: 'info',
};
