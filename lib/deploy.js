const fs = require("fs");
const { exec } = require("child_process");

const { assertInsideWorkspace, normalizeRelativePath } = require("./workspace");

function shellQuote(value) {
  const text = String(value);
  if (process.platform === "win32") {
    return `'${text.replace(/'/g, "''")}'`;
  }
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function runCommand(cwd, command) {
  return new Promise((resolve) => {
    const shellCommand = process.platform === "win32"
      ? `powershell.exe -NoProfile -Command ${JSON.stringify(command)}`
      : command;

    exec(shellCommand, {
      cwd,
      timeout: 120000,
      maxBuffer: 1024 * 1024
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

async function runSteps(cwd, steps) {
  const outputs = [];

  for (const step of steps) {
    if (!step || !step.command) {
      continue;
    }

    const result = await runCommand(cwd, step.command);
    outputs.push([
      `$ ${step.command}`,
      result.combined || "(no output)"
    ].join("\n"));

    if (!result.ok) {
      return {
        ok: false,
        code: result.code,
        output: outputs.join("\n\n")
      };
    }
  }

  return {
    ok: true,
    code: 0,
    output: outputs.join("\n\n")
  };
}

function ensureDirectory(root, relativePath) {
  const absolutePath = assertInsideWorkspace(root, relativePath || ".");
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isDirectory()) {
    throw new Error("Target directory does not exist.");
  }
  return {
    absolutePath,
    relativePath: normalizeRelativePath(relativePath || ".")
  };
}

function resolveCloneTarget(root, targetPath) {
  const relativePath = normalizeRelativePath(targetPath || ".");
  const absolutePath = assertInsideWorkspace(root, relativePath);
  if (fs.existsSync(absolutePath)) {
    throw new Error("Clone target already exists.");
  }
  return {
    absolutePath,
    relativePath
  };
}

function buildPm2StartCommand(projectRoot, serviceName, serviceMode, serviceTarget) {
  const namePart = shellQuote(serviceName);
  const cwdPart = shellQuote(projectRoot);

  switch (serviceMode) {
    case "npm-start":
      return `pm2 start npm --name ${namePart} --cwd ${cwdPart} -- start`;
    case "npm-script":
      return `pm2 start npm --name ${namePart} --cwd ${cwdPart} -- run ${shellQuote(serviceTarget || "start")}`;
    case "pnpm-start":
      return `pm2 start pnpm --name ${namePart} --cwd ${cwdPart} -- start`;
    case "pnpm-script":
      return `pm2 start pnpm --name ${namePart} --cwd ${cwdPart} -- run ${shellQuote(serviceTarget || "start")}`;
    case "node-script":
      if (!serviceTarget) {
        throw new Error("A script path is required for node-script mode.");
      }
      return `pm2 start ${shellQuote(serviceTarget)} --name ${namePart} --cwd ${cwdPart}`;
    default:
      throw new Error("Unsupported PM2 service mode.");
  }
}

async function readDeployStatus(root, projectPath, serviceName) {
  const project = ensureDirectory(root, projectPath || ".");
  const statusSteps = [
    {
      command: "git rev-parse --show-toplevel"
    },
    {
      command: "git status --short --branch"
    }
  ];

  if (serviceName) {
    statusSteps.push({
      command: `pm2 describe ${shellQuote(serviceName)}`
    });
  }

  const result = await runSteps(project.absolutePath, statusSteps);
  return {
    ok: result.ok,
    projectPath: project.relativePath,
    projectRoot: project.absolutePath,
    output: result.output || "(no output)"
  };
}

async function cloneRepository(root, repoUrl, targetPath, branch) {
  const repo = String(repoUrl || "").trim();
  if (!repo) {
    throw new Error("Repository URL is required.");
  }

  const target = resolveCloneTarget(root, targetPath || ".");
  const branchPart = branch ? ` --branch ${shellQuote(branch.trim())}` : "";
  const command = `git clone${branchPart} ${shellQuote(repo)} ${shellQuote(target.relativePath)}`;
  const result = await runSteps(root, [{ command }]);

  return {
    ok: result.ok,
    projectPath: target.relativePath,
    projectRoot: target.absolutePath,
    output: result.output || "(no output)"
  };
}

async function installDependencies(root, projectPath, installCommand) {
  const project = ensureDirectory(root, projectPath || ".");
  const command = String(installCommand || "").trim();

  if (!command) {
    throw new Error("Install command is required.");
  }

  const result = await runSteps(project.absolutePath, [{ command }]);
  return {
    ok: result.ok,
    projectPath: project.relativePath,
    projectRoot: project.absolutePath,
    output: result.output || "(no output)"
  };
}

async function createPm2Service(root, projectPath, serviceName, serviceMode, serviceTarget) {
  const project = ensureDirectory(root, projectPath || ".");
  const name = String(serviceName || "").trim();

  if (!name) {
    throw new Error("Service name is required.");
  }

  const startCommand = buildPm2StartCommand(project.absolutePath, name, serviceMode, serviceTarget);
  const result = await runSteps(project.absolutePath, [
    {
      command: startCommand
    },
    {
      command: "pm2 save"
    }
  ]);

  return {
    ok: result.ok,
    projectPath: project.relativePath,
    projectRoot: project.absolutePath,
    output: result.output || "(no output)"
  };
}

async function updateProject(root, options) {
  const project = ensureDirectory(root, options.projectPath || ".");
  const steps = [];
  const branch = String(options.branch || "").trim();

  steps.push({
    command: branch ? `git pull origin ${shellQuote(branch)}` : "git pull"
  });

  if (options.installCommand && String(options.installCommand).trim()) {
    steps.push({
      command: String(options.installCommand).trim()
    });
  }

  if (options.buildCommand && String(options.buildCommand).trim()) {
    steps.push({
      command: String(options.buildCommand).trim()
    });
  }

  const result = await runSteps(project.absolutePath, steps);
  if (!result.ok) {
    return {
      ok: false,
      projectPath: project.relativePath,
      projectRoot: project.absolutePath,
      output: result.output || "(no output)"
    };
  }

  if (options.serviceName) {
    const restartAttempt = await runCommand(project.absolutePath, `pm2 restart ${shellQuote(options.serviceName)}`);
    const outputs = [result.output];
    outputs.push([
      `$ pm2 restart ${shellQuote(options.serviceName)}`,
      restartAttempt.combined || "(no output)"
    ].join("\n"));

    if (!restartAttempt.ok) {
      const startCommand = buildPm2StartCommand(
        project.absolutePath,
        options.serviceName,
        options.serviceMode,
        options.serviceTarget
      );
      const startAttempt = await runCommand(project.absolutePath, startCommand);
      outputs.push([
        `$ ${startCommand}`,
        startAttempt.combined || "(no output)"
      ].join("\n"));

      if (!startAttempt.ok) {
        return {
          ok: false,
          projectPath: project.relativePath,
          projectRoot: project.absolutePath,
          output: outputs.join("\n\n")
        };
      }
    }

    const saveAttempt = await runCommand(project.absolutePath, "pm2 save");
    outputs.push([
      "$ pm2 save",
      saveAttempt.combined || "(no output)"
    ].join("\n"));

    return {
      ok: saveAttempt.ok,
      projectPath: project.relativePath,
      projectRoot: project.absolutePath,
      output: outputs.join("\n\n")
    };
  }

  return {
    ok: true,
    projectPath: project.relativePath,
    projectRoot: project.absolutePath,
    output: result.output || "(no output)"
  };
}

module.exports = {
  cloneRepository,
  createPm2Service,
  installDependencies,
  readDeployStatus,
  updateProject
};
