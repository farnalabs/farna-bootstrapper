export const RulesyncHooksPlugin = async ({ directory }) => {
  const __rulesyncRead = (stream, limit = 1048576) => {
    const chunks = [];
    let size = 0;
    const reader = stream.getReader();
    let reading = true;
    const done = (async () => {
      for (let read; reading && !(read = await reader.read()).done; ) {
        if (reading && (size += read.value.length) <= limit) chunks.push(read.value);
      }
    })().catch(() => {});
    const stop = () => {
      if (reading) (reading = false), reader.cancel().catch(() => {});
    };
    return { done, stop, text: () => Buffer.concat(chunks).toString(), overflow: () => size > limit };
  };
  let __rulesyncCanExec;
  let __rulesyncRetryAt = 0;
  // pid -> [ppid, start time], from procfs or else ps; a reused PID gets a new start time.
  const __rulesyncProcesses = () => {
    const processes = new Map();
    try {
      const fs = require("node:fs");
      for (const pid of fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
        try {
          const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
          const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
          processes.set(pid, [fields[1], fields[19]]);
        } catch {}
      }
      if (processes.size > 0) return processes;
    } catch {}
    try {
      // The C locale keeps `lstart` in one format; it is compared as text, never parsed.
      const env = { ...process.env, LC_ALL: "C", LANG: "C" };
      const ps = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid=,lstart="], { env, timeout: 5000 });
      if (ps.exitCode === 0) {
        for (const line of ps.stdout.toString().trim().split("\n")) {
          const [pid, ppid, ...started] = line.trim().split(/\s+/);
          processes.set(pid, [ppid, started.join(" ")]);
        }
        return processes;
      }
    } catch {}
    console.error("[rulesync-hooks] neither /proc nor ps is available: only the hook process is killed");
  };
  const __rulesyncTree = (roots, processes) => {
    const tree = [...roots];
    for (let size = -1; size !== tree.length; ) {
      size = tree.length;
      for (const [pid, [ppid]] of processes ?? []) if (tree.includes(ppid) && !tree.includes(pid)) tree.push(pid);
    }
    return tree;
  };
  // The child itself is signalled only through its handle, a no-op once Bun has reaped it, so a
  // reused PID is never signalled; its descendants only while it is running (not reaped, its PID
  // cannot be reused), and in the SIGKILL round only with both snapshots: the first snapshot's
  // descendants that are the same processes (same start time), and what they and the child,
  // if it ran across the second snapshot, have started since.
  const __rulesyncKillTree = (proc) => {
    const kill = (pids, signal) => pids.forEach((pid) => { try { process.kill(Number(pid), signal); } catch {} });
    const running = () => proc.exitCode === null && proc.signalCode === null;
    const root = String(proc.pid);
    const before = running() ? __rulesyncProcesses() : undefined;
    const first = before && running() ? __rulesyncTree([root], before).slice(1) : [];
    proc.kill("SIGTERM");
    kill(first, "SIGTERM");
    setTimeout(() => {
      const alive = running();
      const now = before && __rulesyncProcesses();
      if (!now) return proc.kill("SIGKILL");
      // Every first-snapshot descendant that is still the same process, wherever it was
      // reparented (to PID 1 or a subreaper), and the child if it survived SIGTERM, with what
      // they have started since. The child is killed first, so it starts nothing more.
      const same = first.filter((pid) => now.get(pid)?.[1] === before.get(pid)?.[1]);
      const own = alive && running() && now.get(root)?.[1] === before.get(root)?.[1];
      proc.kill("SIGKILL");
      kill(__rulesyncTree(own ? [root, ...same] : same, now).filter((pid) => pid !== root), "SIGKILL");
    }, 2000);
  };
  // `proc.kill()` is TerminateProcess on the child alone. A libuv program (node) that dies takes
  // the children it spawned along through its job object, but not ones started through another
  // program (cmd.exe) or detached. taskkill /T ends the tree as linked by parent PID at that
  // moment; System32's copy, so a taskkill earlier on PATH is never run.
  const __rulesyncKillWindowsTree = (proc) => {
    if (proc.exitCode === null && proc.signalCode === null) {
      const taskkill = (process.env.SystemRoot ?? "C:\\Windows") + "\\System32\\taskkill.exe";
      try {
        Bun.spawnSync([taskkill, "/T", "/F", "/PID", String(proc.pid)], { stdout: "ignore", stderr: "ignore", windowsHide: true, timeout: 5000 });
      } catch {}
    }
    proc.kill();
  };
  const __rulesyncRunCommand = async ({ command, input, seconds, inProcess = false, echo = false }) => {
    // A probe that printed `rulesync` is kept; one past its deadline, failing or printing
    // anything else means no Bun CLI for 5 minutes; one that threw is dropped, so the next
    // command probes again.
    if (!inProcess && (__rulesyncCanExec === undefined || (__rulesyncRetryAt && Date.now() >= __rulesyncRetryAt))) {
      __rulesyncRetryAt = 0;
      const probing = (__rulesyncCanExec = (async () => {
        const probe = Bun.spawn([process.execPath, "--no-env-file", "exec", "echo rulesync"], { cwd: directory ?? process.cwd(), env: { ...process.env, BUN_BE_BUN: "1" }, stdin: "ignore", stdout: "pipe", stderr: "ignore", windowsHide: true });
        const output = __rulesyncRead(probe.stdout, 1024);
        let timer;
        // Settles on its own, even if the probe ignores the kill or a process holds its stdout.
        const deadline = new Promise((resolve) => (timer = setTimeout(resolve, 10000, null)));
        const exited = Promise.all([probe.exited, output.done]).then(([code]) => code);
        const exitCode = await Promise.race([exited, deadline]).finally(() => clearTimeout(timer));
        if (exitCode === null) probe.kill("SIGKILL"), output.stop();
        const found = exitCode === 0 && output.text().trim() === "rulesync";
        if (!found) __rulesyncRetryAt = Date.now() + 300000;
        return found;
      })().catch(() => {
        if (__rulesyncCanExec === probing) __rulesyncCanExec = undefined;
        return false;
      }));
    }
    let timer;
    const timeout = () => new Promise((resolve) => (timer = setTimeout(resolve, seconds * 1000, null)));
    if (inProcess || !(await __rulesyncCanExec)) {
      const run = Bun.$`echo ${input} | ${{ raw: command }}`.cwd(directory ?? process.cwd()).nothrow();
      // A sessionStart command's stderr reaches the host when it ends, even after its timeout.
      const finished = echo === true ? run : run.quiet().then((done) => (echo && process.stderr.write(done.stderr), done));
      const result = await Promise.race([finished, timeout()]).finally(() => clearTimeout(timer));
      if (!result || echo === true) return result && { exitCode: result.exitCode };
      const { exitCode, stdout, stderr } = result;
      return { exitCode, stdout: stdout.toString(), stderr: stderr.toString(), overflow: stdout.length > 1048576 };
    }
    // An ordinary command writes to the host's stdout and stderr; a preToolUse one is read, and
    // a sessionStart one (`echo: "stderr"`) has its stdout read.
    const proc = Bun.spawn([process.execPath, "--no-env-file", "exec", "export BUN_BE_BUN=\n" + command], { cwd: directory ?? process.cwd(), env: { ...process.env, BUN_BE_BUN: "1" }, stdin: new TextEncoder().encode(input + "\n"), stdout: echo === true ? "inherit" : "pipe", stderr: echo ? "inherit" : "pipe", windowsHide: true });
    const stdout = echo === true ? undefined : __rulesyncRead(proc.stdout);
    const stderr = echo ? undefined : __rulesyncRead(proc.stderr);
    const exitCode = await Promise.race([proc.exited, timeout()]).finally(() => clearTimeout(timer));
    if (exitCode === null) {
      stdout?.stop(), stderr?.stop();
      if (process.platform === "win32") __rulesyncKillWindowsTree(proc);
      else __rulesyncKillTree(proc);
      return null;
    }
    if (echo === true) return { exitCode };
    await Promise.race([Promise.all([stdout.done, stderr?.done]), Bun.sleep(1000)]);
    stdout.stop(), stderr?.stop();
    return { exitCode, stdout: stdout.text(), stderr: stderr?.text() ?? "", overflow: stdout.overflow() };
  };
  const __rulesyncRunHook = async ({ label, command, input, blocking, seconds, inProcess = false, context = false }) => {
    let result;
    try {
      result = await __rulesyncRunCommand({ command, input, seconds, inProcess, echo: context ? "stderr" : true });
    } catch (error) {
      if (blocking) throw error;
      console.error("[rulesync-hooks] " + label + " hook failed:", error);
      return;
    }
    if (result === null) {
      const message = "[rulesync-hooks] " + label + " hook timed out after " + seconds + "s";
      if (blocking) throw new Error(message);
      return console.error(message);
    }
    if (result.exitCode === 0) return result;
    const message = "[rulesync-hooks] " + label + " hook exited with code " + result.exitCode;
    if (blocking) throw new Error(message);
    console.error(message);
  };

  const MAX_BLOCK_REASON_LENGTH = 2000;
  const MAX_SCANNED_REASON_LENGTH = 128_000;

  function dropTrailingLoneSurrogate(text) {
    return text.replace(/[\ud800-\udbff]$/, "");
  }

  function sanitizeBlockReason(raw) {
    const scannedTruncated = raw.length > MAX_SCANNED_REASON_LENGTH;
    const scanned = scannedTruncated
      ? dropTrailingLoneSurrogate(raw.slice(0, MAX_SCANNED_REASON_LENGTH))
      : raw;
    const sanitized = scanned
      .replace(/\r\n?/g, "\n")
      .replace(/\u001b\[[0-9;?]*[\u0020-\u002f]*[\u0040-\u007e]/g, "")
      .replace(/\u001b\][^\u0007\u001b]{0,256}(?:\u0007|\u001b\\)/g, "")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
      .replace(/[\p{Cf}\p{Zl}\p{Zp}]/gu, "")
      .trim();
    if (!sanitized) return "";
    if (sanitized.length <= MAX_BLOCK_REASON_LENGTH && !scannedTruncated) return sanitized;
    return `${dropTrailingLoneSurrogate(sanitized.slice(0, MAX_BLOCK_REASON_LENGTH))}...`;
  }

  const __rulesyncEnforcePreToolUseResult = (result, failClosed) => {
    if (result === null) {
      if (failClosed !== false) throw new Error("preToolUse hook timed out.");
      return console.error("[rulesync-hooks] preToolUse hook timed out");
    }
    if (result.overflow) throw new Error("preToolUse hook wrote more than 1 MiB to stdout.");
    const stderr = result.stderr.toString();
    if (result.exitCode === 0) {
      let parsed;
      try {
        parsed = JSON.parse(result.stdout.toString());
      } catch {
        return;
      }
      const specific = parsed && typeof parsed === "object" ? parsed.hookSpecificOutput : undefined;
      if (specific && typeof specific === "object" && specific.permissionDecision === "deny") {
        throw new Error(
          (typeof specific.permissionDecisionReason === "string" &&
            sanitizeBlockReason(specific.permissionDecisionReason)) ||
            "Blocked by a preToolUse hook.",
        );
      }
      return;
    }
    if (result.exitCode === 2) {
      throw new Error(sanitizeBlockReason(stderr) || "Blocked by a preToolUse hook.");
    }
    throw new Error(
      sanitizeBlockReason(stderr) ||
        "preToolUse hook command failed with exit code " + result.exitCode + ".",
    );
  };
  return {
    "tool.execute.before": async (input, output) => {
      let __rulesyncPreToolUseInputCache;
      const __rulesyncPreToolUseInput = () =>
        (__rulesyncPreToolUseInputCache ??= JSON.stringify({
          hook_event_name: "PreToolUse",
          session_id: input.sessionID,
          tool_use_id: input.callID,
          tool_name: input.tool,
          tool_input: output?.args,
          cwd: directory ?? process.cwd(),
        }));
      {
        const __re = new RegExp("^(?:edit|write)$");
        if (__re.test(input.tool)) {
          __rulesyncEnforcePreToolUseResult(await __rulesyncRunCommand({ command: "pnpm exec prettier --write \"$FILE\"", input: __rulesyncPreToolUseInput(), seconds: 600 }));
        }
      }
    },
  };
};
