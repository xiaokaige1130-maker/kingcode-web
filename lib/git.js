const { exec } = require("child_process");

function runGit(workspaceRoot, args) {
  return new Promise((resolve) => {
    const command = `git ${args.map((arg) => JSON.stringify(String(arg))).join(" ")}`;
    exec(command, {
      cwd: workspaceRoot,
      timeout: 20000,
      maxBuffer: 512 * 1024
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error && typeof error.code === "number" ? error.code : 0,
        stdout,
        stderr,
        combined: [stdout, stderr].filter(Boolean).join("\n").trim()
      });
    });
  });
}

async function ensureGitRepo(workspaceRoot) {
  const result = await runGit(workspaceRoot, ["rev-parse", "--is-inside-work-tree"]);
  if (!result.ok || result.stdout.trim() !== "true") {
    throw new Error("Current scope is not inside a Git repository.");
  }
}

async function readGitSnapshot(workspaceRoot) {
  await ensureGitRepo(workspaceRoot);

  const [repoRoot, branch, status, remotes] = await Promise.all([
    runGit(workspaceRoot, ["rev-parse", "--show-toplevel"]),
    runGit(workspaceRoot, ["rev-parse", "--abbrev-ref", "HEAD"]),
    runGit(workspaceRoot, ["status", "--short", "--branch"]),
    runGit(workspaceRoot, ["remote", "-v"])
  ]);

  return {
    ok: true,
    repoRoot: repoRoot.stdout.trim(),
    branch: branch.stdout.trim(),
    statusText: status.stdout.trim() || "Working tree clean.",
    remotesText: remotes.stdout.trim() || "(no remotes)"
  };
}

async function commitAll(workspaceRoot, message) {
  await ensureGitRepo(workspaceRoot);

  const addResult = await runGit(workspaceRoot, ["add", "-A"]);
  if (!addResult.ok) {
    return addResult;
  }

  return runGit(workspaceRoot, ["commit", "-m", message]);
}

async function pushCurrentBranch(workspaceRoot) {
  await ensureGitRepo(workspaceRoot);
  return runGit(workspaceRoot, ["push"]);
}

module.exports = {
  commitAll,
  pushCurrentBranch,
  readGitSnapshot,
  runGit
};
