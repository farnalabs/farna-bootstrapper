import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCheck } from '../../src/cli/commands/check.js';
import { runGenerate } from '../../src/cli/commands/generate.js';
import { FarnaError } from '../../src/core/errors.js';
import { UpstreamRenderTarget } from '../../src/render/upstream.js';
import { MutatingRenderTarget, readOutput, writeOutput } from '../support/mutating-renderer.js';
import { createTempRepo, hashTree, type TempRepo } from '../support/temp-repo.js';

const PLUGIN = '.opencode/plugins/rulesync-hooks.js';

type Hook = {
  id: string;
  command: string;
  matcher?: string;
  phase?: 'before-tool' | 'after-tool' | 'session-start';
};

/**
 * A profile repo whose live persona declares exactly the hooks given. The
 * fixture's builder already declares an MCP server, a skill and a command; they
 * are replaced so the hook set is the only variable.
 */
async function repoWithHooks(hooks: readonly Hook[]): Promise<TempRepo> {
  const repo = await createTempRepo('profile');
  await writeFile(
    join(repo.root, '.farna/personas/builder.yaml'),
    [
      'kind: persona',
      'id: builder',
      'displayName: Builder',
      'purpose: Runs the declared hooks.',
      'resources:',
      ...hooks.map((hook) => `  - hook/${hook.id}`),
      '',
    ].join('\n'),
    'utf8',
  );
  for (const hook of hooks) {
    await writeFile(
      join(repo.root, `.farna/resources/hooks/${hook.id}.jsonc`),
      `${JSON.stringify(
        {
          kind: 'hook',
          id: hook.id,
          phase: hook.phase ?? 'before-tool',
          ...(hook.matcher === undefined ? {} : { matcher: hook.matcher }),
          command: hook.command,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }
  return repo;
}

async function expectGate(
  repo: TempRepo,
  mutate: (outputRoot: string) => Promise<void>,
  message: string,
): Promise<void> {
  const before = await hashTree(repo.root);
  let failure: FarnaError | undefined;
  try {
    await runGenerate(
      { cwd: repo.root, dryRun: false },
      new MutatingRenderTarget(async (request, result) => {
        await mutate(request.outputRoot);
        return result;
      }),
    );
  } catch (error) {
    expect(error).toBeInstanceOf(FarnaError);
    failure = error as FarnaError;
  }
  expect(failure?.code).toBe('F008_DECLARED_NOT_EMITTED');
  expect(failure?.message).toContain(message);
  expect(await hashTree(repo.root)).toBe(before);
}

describe('hooks plugin containment', () => {
  it('accepts a matcher-less hook that follows a hook with a matcher', async () => {
    // rulesync sorts the registrations by command, so `aaa` is emitted first.
    // The second hook declares no matcher and must not inherit the first's.
    const repo = await repoWithHooks([
      { id: 'first', command: 'aaa with matcher', matcher: 'Edit|Write' },
      { id: 'second', command: 'mmm without matcher' },
    ]);
    try {
      const result = await runGenerate(
        { cwd: repo.root, dryRun: false },
        new UpstreamRenderTarget(),
      );
      expect(result.ok).toBe(true);
      const plugin = await readOutput(join(repo.root, '.opencode/plugins'), 'rulesync-hooks.js');
      expect(plugin).toContain('aaa with matcher');
      expect(plugin).toContain('mmm without matcher');
      const check = await runCheck(repo.root, new UpstreamRenderTarget());
      expect(check.ok).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it('generates an after-tool hook with a matcher and checks clean', async () => {
    // The `execute.after` registration also carries `label: "postToolUse"` in
    // the same run call, AFTER the matcher guard. That label must not reset the
    // matcher window: doing so made every after-tool matcher invisible.
    const repo = await repoWithHooks([
      { id: 'after', phase: 'after-tool', command: 'echo after', matcher: 'Edit' },
    ]);
    try {
      const result = await runGenerate(
        { cwd: repo.root, dryRun: false },
        new UpstreamRenderTarget(),
      );
      expect(result.ok).toBe(true);
      const plugin = await readOutput(join(repo.root, '.opencode/plugins'), 'rulesync-hooks.js');
      expect(plugin).toContain('execute.after');
      expect(plugin).toContain('new RegExp("Edit")');
      expect((await runCheck(repo.root, new UpstreamRenderTarget())).ok).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses a dropped matcher on an after-tool hook', async () => {
    const repo = await repoWithHooks([
      { id: 'after', phase: 'after-tool', command: 'echo after', matcher: 'Edit' },
    ]);
    try {
      await expectGate(
        repo,
        async (outputRoot) => {
          const text = await readOutput(outputRoot, PLUGIN);
          const guard = ' && __rulesyncMatchesTool(new RegExp("Edit"), event.tool)';
          expect(text).toContain(guard);
          await writeOutput(outputRoot, PLUGIN, text.replace(guard, ''));
        },
        'registers',
      );
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses a dropped matcher on the second of two hooks that share one', async () => {
    const repo = await repoWithHooks([
      { id: 'first', command: 'aaa with matcher', matcher: 'Bash' },
      { id: 'second', command: 'bbb with matcher', matcher: 'Bash' },
    ]);
    try {
      await expectGate(
        repo,
        async (outputRoot) => {
          const text = await readOutput(outputRoot, PLUGIN);
          const needle = 'new RegExp("Bash")';
          const last = text.lastIndexOf(needle);
          expect(last).toBeGreaterThan(0);
          await writeOutput(
            outputRoot,
            PLUGIN,
            text.slice(0, last) + text.slice(last + needle.length),
          );
        },
        'registers',
      );
    } finally {
      await repo.cleanup();
    }
  });

  it('accepts a matcher containing a literal backslash', async () => {
    // The matcher is a regex that matches a backslash; rulesync embeds it with
    // backslashes doubled, and that is its only escaping layer.
    const repo = await repoWithHooks([
      { id: 'regex', command: 'aaa regex matcher', matcher: 'a\\\\b' },
    ]);
    try {
      const result = await runGenerate(
        { cwd: repo.root, dryRun: false },
        new UpstreamRenderTarget(),
      );
      expect(result.ok).toBe(true);
      expect((await runCheck(repo.root, new UpstreamRenderTarget())).ok).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it('accepts a command with a backslash', async () => {
    const repo = await repoWithHooks([
      { id: 'backslash', command: 'echo "a\\b"', matcher: 'Edit' },
    ]);
    try {
      const result = await runGenerate(
        { cwd: repo.root, dryRun: false },
        new UpstreamRenderTarget(),
      );
      expect(result.ok).toBe(true);
      expect((await runCheck(repo.root, new UpstreamRenderTarget())).ok).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it('accepts a command with a substitution', async () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal `${` is exactly what the gate must unescape
    const command = 'echo "${HOME}/bin"';
    const repo = await repoWithHooks([{ id: 'substitution', command, matcher: 'Edit' }]);
    try {
      const result = await runGenerate(
        { cwd: repo.root, dryRun: false },
        new UpstreamRenderTarget(),
      );
      expect(result.ok).toBe(true);
      expect((await runCheck(repo.root, new UpstreamRenderTarget())).ok).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it('accepts a command that ends in a backslash', async () => {
    const repo = await repoWithHooks([
      { id: 'trailing', command: 'echo "trail\\"', matcher: 'Edit' },
    ]);
    try {
      const result = await runGenerate(
        { cwd: repo.root, dryRun: false },
        new UpstreamRenderTarget(),
      );
      expect(result.ok).toBe(true);
      expect((await runCheck(repo.root, new UpstreamRenderTarget())).ok).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });
});
