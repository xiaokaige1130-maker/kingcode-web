const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const { assertInsideWorkspace, normalizeRelativePath } = require("./workspace");

function shellQuote(value) {
  const text = String(value);
  if (process.platform === "win32") {
    return `'${text.replace(/'/g, "''")}'`;
  }
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function runCommand(cwd, command, timeout = 120000) {
  return new Promise((resolve) => {
    const shellCommand = process.platform === "win32"
      ? `powershell.exe -NoProfile -Command ${JSON.stringify(command)}`
      : command;

    exec(shellCommand, {
      cwd,
      timeout,
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

    const result = await runCommand(cwd, step.command, step.timeout || 120000);
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
    case "python-script":
      if (!serviceTarget) {
        throw new Error("A script path is required for python-script mode.");
      }
      return `pm2 start python3 --name ${namePart} --cwd ${cwdPart} -- ${shellQuote(serviceTarget)}`;
    default:
      throw new Error("Unsupported PM2 service mode.");
  }
}

function buildServiceExecCommand(serviceMode, serviceTarget) {
  switch (serviceMode) {
    case "npm-start":
      return "npm start";
    case "npm-script":
      return `npm run ${serviceTarget || "start"}`;
    case "pnpm-start":
      return "pnpm start";
    case "pnpm-script":
      return `pnpm run ${serviceTarget || "start"}`;
    case "node-script":
      if (!serviceTarget) {
        throw new Error("A script path is required for node-script mode.");
      }
      return `node ${serviceTarget}`;
    case "python-script":
      if (!serviceTarget) {
        throw new Error("A script path is required for python-script mode.");
      }
      return `python3 ${serviceTarget}`;
    default:
      throw new Error("Unsupported service mode.");
  }
}

function systemdTemplate(projectRoot, serviceName, serviceMode, serviceTarget) {
  const execStart = buildServiceExecCommand(serviceMode, serviceTarget);
  return [
    "[Unit]",
    `Description=${serviceName}`,
    "After=network.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${projectRoot}`,
    `ExecStart=/bin/bash -lc ${shellQuote(execStart)}`,
    "Restart=always",
    "RestartSec=3",
    "Environment=NODE_ENV=production",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    ""
  ].join("\n");
}

async function readDeployStatus(root, projectPath, serviceName, runtime = "pm2") {
  const project = ensureDirectory(root, projectPath || ".");
  const statusSteps = [
    { command: "git rev-parse --show-toplevel" },
    { command: "git status --short --branch" }
  ];

  if (serviceName) {
    if (runtime === "systemd" && process.platform !== "win32") {
      statusSteps.push({
        command: `systemctl status ${shellQuote(serviceName)} --no-pager`,
        timeout: 30000
      });
    } else {
      statusSteps.push({
        command: `pm2 describe ${shellQuote(serviceName)}`,
        timeout: 30000
      });
    }
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
    { command: startCommand },
    { command: "pm2 save" }
  ]);

  return {
    ok: result.ok,
    projectPath: project.relativePath,
    projectRoot: project.absolutePath,
    output: result.output || "(no output)"
  };
}

async function createSystemdService(root, options) {
  if (process.platform === "win32") {
    throw new Error("systemd is only available on Linux.");
  }

  const project = ensureDirectory(root, options.projectPath || ".");
  const serviceName = String(options.serviceName || "").trim();
  if (!serviceName) {
    throw new Error("Service name is required.");
  }

  const fileName = serviceName.endsWith(".service") ? serviceName : `${serviceName}.service`;
  const localServicePath = path.join(project.absolutePath, fileName);
  const content = systemdTemplate(project.absolutePath, serviceName, options.serviceMode, options.serviceTarget);
  fs.writeFileSync(localServicePath, content, "utf8");

  const outputs = [
    `Generated ${localServicePath}`,
    "",
    content
  ];

  if (options.installNow) {
    const installSteps = await runSteps(project.absolutePath, [
      { command: `sudo -n cp ${shellQuote(localServicePath)} /etc/systemd/system/${shellQuote(fileName)}` },
      { command: "sudo -n systemctl daemon-reload" },
      { command: `sudo -n systemctl enable --now ${shellQuote(fileName)}` },
      { command: `sudo -n systemctl status ${shellQuote(fileName)} --no-pager`, timeout: 30000 }
    ]);

    outputs.push(installSteps.output || "(no output)");

    return {
      ok: installSteps.ok,
      projectPath: project.relativePath,
      projectRoot: project.absolutePath,
      output: outputs.join("\n\n")
    };
  }

  outputs.push("Run with sudo to install:");
  outputs.push(`sudo cp ${shellQuote(localServicePath)} /etc/systemd/system/${shellQuote(fileName)}`);
  outputs.push("sudo systemctl daemon-reload");
  outputs.push(`sudo systemctl enable --now ${shellQuote(fileName)}`);

  return {
    ok: true,
    projectPath: project.relativePath,
    projectRoot: project.absolutePath,
    output: outputs.join("\n\n")
  };
}

async function readServiceLogs(root, options) {
  const project = ensureDirectory(root, options.projectPath || ".");
  const lines = Number(options.lines || 80);
  const source = String(options.logSource || "pm2");
  const serviceName = String(options.serviceName || "").trim();

  let command = "";
  switch (source) {
    case "pm2":
      if (!serviceName) {
        throw new Error("Service name is required for PM2 logs.");
      }
      command = `pm2 logs ${shellQuote(serviceName)} --lines ${lines} --nostream`;
      break;
    case "systemd":
      if (process.platform === "win32") {
        throw new Error("systemd logs are only available on Linux.");
      }
      if (!serviceName) {
        throw new Error("Service name is required for systemd logs.");
      }
      command = `journalctl -u ${shellQuote(serviceName)} -n ${lines} --no-pager`;
      break;
    case "docker-compose":
      command = `docker compose logs --tail ${lines}`;
      break;
    default:
      throw new Error("Unsupported log source.");
  }

  const result = await runSteps(project.absolutePath, [{ command, timeout: 30000 }]);
  return {
    ok: result.ok,
    projectPath: project.relativePath,
    projectRoot: project.absolutePath,
    output: result.output || "(no output)"
  };
}

async function runDockerCompose(root, projectPath, composeAction) {
  const project = ensureDirectory(root, projectPath || ".");
  const action = String(composeAction || "").trim();

  let command = "";
  switch (action) {
    case "up":
      command = "docker compose up -d";
      break;
    case "down":
      command = "docker compose down";
      break;
    case "pull":
      command = "docker compose pull";
      break;
    case "restart":
      command = "docker compose restart";
      break;
    case "logs":
      command = "docker compose logs --tail 80";
      break;
    default:
      throw new Error("Unsupported docker compose action.");
  }

  const result = await runSteps(project.absolutePath, [{ command, timeout: 30000 }]);
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
    steps.push({ command: String(options.installCommand).trim() });
  }

  if (options.buildCommand && String(options.buildCommand).trim()) {
    steps.push({ command: String(options.buildCommand).trim() });
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
    const runtime = String(options.runtime || "pm2");
    const outputs = [result.output];

    if (runtime === "systemd" && process.platform !== "win32") {
      const restartAttempt = await runCommand(project.absolutePath, `sudo -n systemctl restart ${shellQuote(options.serviceName)}`);
      outputs.push([
        `$ sudo -n systemctl restart ${shellQuote(options.serviceName)}`,
        restartAttempt.combined || "(no output)"
      ].join("\n"));

      return {
        ok: restartAttempt.ok,
        projectPath: project.relativePath,
        projectRoot: project.absolutePath,
        output: outputs.join("\n\n")
      };
    }

    const restartAttempt = await runCommand(project.absolutePath, `pm2 restart ${shellQuote(options.serviceName)}`);
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
  createSystemdService,
  installDependencies,
  readDeployStatus,
  readServiceLogs,
  runDockerCompose,
  updateProject
};
