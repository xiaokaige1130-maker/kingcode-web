const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { exec } = require("child_process");

const { assertInsideWorkspace, normalizeRelativePath } = require("./workspace");

const HISTORY_PATH = path.resolve(__dirname, "../data/deploy-history.json");

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

function ensureHistoryStore() {
  if (!fs.existsSync(HISTORY_PATH)) {
    fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
    fs.writeFileSync(HISTORY_PATH, JSON.stringify({ entries: [] }, null, 2));
  }
}

function readHistoryStore() {
  ensureHistoryStore();
  const raw = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8"));
  if (!Array.isArray(raw.entries)) {
    return { entries: [] };
  }
  return raw;
}

function writeHistoryStore(store) {
  fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(store, null, 2));
}

function trimOutput(value, limit = 2400) {
  const text = String(value || "").trim();
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}\n\n...(truncated)`;
}

function recordDeployEvent(event) {
  const store = readHistoryStore();
  store.entries.unshift({
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    ...event,
    output: trimOutput(event.output || "")
  });
  store.entries = store.entries.slice(0, 200);
  writeHistoryStore(store);
}

function readDeployHistory(limit = 20) {
  const store = readHistoryStore();
  return store.entries.slice(0, Math.max(1, Math.min(Number(limit) || 20, 100)));
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

async function currentHead(cwd) {
  const result = await runCommand(cwd, "git rev-parse HEAD");
  return result.ok ? result.stdout.trim() : "";
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

async function readCommitHistory(root, projectPath, limit = 15) {
  const project = ensureDirectory(root, projectPath || ".");
  const safeLimit = Math.max(1, Math.min(Number(limit) || 15, 50));
  const result = await runSteps(project.absolutePath, [
    { command: `git log --oneline -n ${safeLimit}` }
  ]);

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

  const payload = {
    ok: result.ok,
    projectPath: target.relativePath,
    projectRoot: target.absolutePath,
    output: result.output || "(no output)"
  };
  recordDeployEvent({
    action: "clone",
    ok: payload.ok,
    projectPath: payload.projectPath,
    projectRoot: payload.projectRoot,
    summary: `Cloned ${repo} into ${payload.projectPath}`,
    output: payload.output
  });
  return payload;
}

async function installDependencies(root, projectPath, installCommand) {
  const project = ensureDirectory(root, projectPath || ".");
  const command = String(installCommand || "").trim();

  if (!command) {
    throw new Error("Install command is required.");
  }

  const result = await runSteps(project.absolutePath, [{ command }]);
  const payload = {
    ok: result.ok,
    projectPath: project.relativePath,
    projectRoot: project.absolutePath,
    output: result.output || "(no output)"
  };
  recordDeployEvent({
    action: "install",
    ok: payload.ok,
    projectPath: payload.projectPath,
    projectRoot: payload.projectRoot,
    summary: `Install command: ${command}`,
    output: payload.output
  });
  return payload;
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

  const payload = {
    ok: result.ok,
    projectPath: project.relativePath,
    projectRoot: project.absolutePath,
    output: result.output || "(no output)"
  };
  recordDeployEvent({
    action: "pm2-service",
    ok: payload.ok,
    projectPath: payload.projectPath,
    projectRoot: payload.projectRoot,
    summary: `PM2 service ${name} (${serviceMode})`,
    output: payload.output
  });
  return payload;
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

    const payload = {
      ok: installSteps.ok,
      projectPath: project.relativePath,
      projectRoot: project.absolutePath,
      output: outputs.join("\n\n")
    };
    recordDeployEvent({
      action: "systemd-service",
      ok: payload.ok,
      projectPath: payload.projectPath,
      projectRoot: payload.projectRoot,
      summary: `systemd service ${serviceName}`,
      output: payload.output
    });
    return payload;
  }

  outputs.push("Run with sudo to install:");
  outputs.push(`sudo cp ${shellQuote(localServicePath)} /etc/systemd/system/${shellQuote(fileName)}`);
  outputs.push("sudo systemctl daemon-reload");
  outputs.push(`sudo systemctl enable --now ${shellQuote(fileName)}`);

  const payload = {
    ok: true,
    projectPath: project.relativePath,
    projectRoot: project.absolutePath,
    output: outputs.join("\n\n")
  };
  recordDeployEvent({
    action: "systemd-template",
    ok: true,
    projectPath: payload.projectPath,
    projectRoot: payload.projectRoot,
    summary: `Generated systemd template for ${serviceName}`,
    output: payload.output
  });
  return payload;
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
  const payload = {
    ok: result.ok,
    projectPath: project.relativePath,
    projectRoot: project.absolutePath,
    output: result.output || "(no output)"
  };
  recordDeployEvent({
    action: "logs",
    ok: payload.ok,
    projectPath: payload.projectPath,
    projectRoot: payload.projectRoot,
    summary: `Loaded ${source} logs${serviceName ? ` for ${serviceName}` : ""}`,
    output: payload.output
  });
  return payload;
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
  const payload = {
    ok: result.ok,
    projectPath: project.relativePath,
    projectRoot: project.absolutePath,
    output: result.output || "(no output)"
  };
  recordDeployEvent({
    action: "docker-compose",
    ok: payload.ok,
    projectPath: payload.projectPath,
    projectRoot: payload.projectRoot,
    summary: `docker compose ${action}`,
    output: payload.output
  });
  return payload;
}

async function runHealthCheck(targetUrl, timeout = 8000) {
  const url = String(targetUrl || "").trim();
  if (!url) {
    throw new Error("Health check URL is required.");
  }

  const parsed = new URL(url);
  const client = parsed.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const request = client.request(parsed, {
      method: "GET",
      timeout
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const payload = {
          ok: response.statusCode >= 200 && response.statusCode < 400,
          statusCode: response.statusCode,
          body: trimOutput(body, 1200),
          output: `URL: ${url}\nStatus: ${response.statusCode}\n\n${trimOutput(body, 1200)}`
        };
        recordDeployEvent({
          action: "health-check",
          ok: payload.ok,
          projectPath: ".",
          projectRoot: "",
          summary: `Health check ${url} -> ${response.statusCode}`,
          output: payload.output
        });
        resolve(payload);
      });
    });

    request.on("error", reject);
    request.on("timeout", () => {
      request.destroy(new Error("Health check timed out."));
    });
    request.end();
  });
}

async function rollbackProject(root, options) {
  const project = ensureDirectory(root, options.projectPath || ".");
  const commit = String(options.commit || "").trim();
  if (!commit) {
    throw new Error("Rollback commit is required.");
  }

  const beforeHead = await currentHead(project.absolutePath);
  const steps = [
    { command: `git reset --hard ${shellQuote(commit)}` }
  ];

  if (options.installCommand && String(options.installCommand).trim()) {
    steps.push({ command: String(options.installCommand).trim() });
  }

  if (options.buildCommand && String(options.buildCommand).trim()) {
    steps.push({ command: String(options.buildCommand).trim() });
  }

  const result = await runSteps(project.absolutePath, steps);
  const outputs = [result.output || "(no output)"];

  if (!result.ok) {
    const payload = {
      ok: false,
      projectPath: project.relativePath,
      projectRoot: project.absolutePath,
      output: outputs.join("\n\n")
    };
    recordDeployEvent({
      action: "rollback",
      ok: false,
      projectPath: payload.projectPath,
      projectRoot: payload.projectRoot,
      summary: `Rollback to ${commit} failed`,
      output: payload.output,
      fromCommit: beforeHead,
      toCommit: commit
    });
    return payload;
  }

  if (options.serviceName) {
    const runtime = String(options.runtime || "pm2");
    if (runtime === "systemd" && process.platform !== "win32") {
      const restartAttempt = await runCommand(project.absolutePath, `sudo -n systemctl restart ${shellQuote(options.serviceName)}`);
      outputs.push([
        `$ sudo -n systemctl restart ${shellQuote(options.serviceName)}`,
        restartAttempt.combined || "(no output)"
      ].join("\n"));
      if (!restartAttempt.ok) {
        const payload = {
          ok: false,
          projectPath: project.relativePath,
          projectRoot: project.absolutePath,
          output: outputs.join("\n\n")
        };
        recordDeployEvent({
          action: "rollback",
          ok: false,
          projectPath: payload.projectPath,
          projectRoot: payload.projectRoot,
          summary: `Rollback to ${commit} failed on systemd restart`,
          output: payload.output,
          fromCommit: beforeHead,
          toCommit: commit
        });
        return payload;
      }
    } else {
      const restartAttempt = await runCommand(project.absolutePath, `pm2 restart ${shellQuote(options.serviceName)}`);
      outputs.push([
        `$ pm2 restart ${shellQuote(options.serviceName)}`,
        restartAttempt.combined || "(no output)"
      ].join("\n"));
      if (!restartAttempt.ok) {
        const payload = {
          ok: false,
          projectPath: project.relativePath,
          projectRoot: project.absolutePath,
          output: outputs.join("\n\n")
        };
        recordDeployEvent({
          action: "rollback",
          ok: false,
          projectPath: payload.projectPath,
          projectRoot: payload.projectRoot,
          summary: `Rollback to ${commit} failed on PM2 restart`,
          output: payload.output,
          fromCommit: beforeHead,
          toCommit: commit
        });
        return payload;
      }
    }
  }

  const afterHead = await currentHead(project.absolutePath);
  const payload = {
    ok: true,
    projectPath: project.relativePath,
    projectRoot: project.absolutePath,
    output: outputs.join("\n\n"),
    beforeHead,
    afterHead
  };
  recordDeployEvent({
    action: "rollback",
    ok: true,
    projectPath: payload.projectPath,
    projectRoot: payload.projectRoot,
    summary: `Rollback from ${beforeHead || "(unknown)"} to ${afterHead || commit}`,
    output: payload.output,
    fromCommit: beforeHead,
    toCommit: afterHead || commit
  });
  return payload;
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
    const payload = {
      ok: false,
      projectPath: project.relativePath,
      projectRoot: project.absolutePath,
      output: result.output || "(no output)"
    };
    recordDeployEvent({
      action: "update",
      ok: false,
      projectPath: payload.projectPath,
      projectRoot: payload.projectRoot,
      summary: `Update failed${branch ? ` on ${branch}` : ""}`,
      output: payload.output
    });
    return payload;
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

      const payload = {
        ok: restartAttempt.ok,
        projectPath: project.relativePath,
        projectRoot: project.absolutePath,
        output: outputs.join("\n\n")
      };
      recordDeployEvent({
        action: "update",
        ok: payload.ok,
        projectPath: payload.projectPath,
        projectRoot: payload.projectRoot,
        summary: `Updated project and restarted systemd ${options.serviceName}`,
        output: payload.output
      });
      return payload;
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
        const payload = {
          ok: false,
          projectPath: project.relativePath,
          projectRoot: project.absolutePath,
          output: outputs.join("\n\n")
        };
        recordDeployEvent({
          action: "update",
          ok: false,
          projectPath: payload.projectPath,
          projectRoot: payload.projectRoot,
          summary: `Update failed when restarting ${options.serviceName}`,
          output: payload.output
        });
        return payload;
      }
    }

    const saveAttempt = await runCommand(project.absolutePath, "pm2 save");
    outputs.push([
      "$ pm2 save",
      saveAttempt.combined || "(no output)"
    ].join("\n"));

    const payload = {
      ok: saveAttempt.ok,
      projectPath: project.relativePath,
      projectRoot: project.absolutePath,
      output: outputs.join("\n\n")
    };
    recordDeployEvent({
      action: "update",
      ok: payload.ok,
      projectPath: payload.projectPath,
      projectRoot: payload.projectRoot,
      summary: `Updated project and restarted PM2 ${options.serviceName}`,
      output: payload.output
    });
    return payload;
  }

  const payload = {
    ok: true,
    projectPath: project.relativePath,
    projectRoot: project.absolutePath,
    output: result.output || "(no output)"
  };
  recordDeployEvent({
    action: "update",
    ok: true,
    projectPath: payload.projectPath,
    projectRoot: payload.projectRoot,
    summary: `Updated project${branch ? ` on ${branch}` : ""}`,
    output: payload.output
  });
  return payload;
}

module.exports = {
  cloneRepository,
  createPm2Service,
  createSystemdService,
  installDependencies,
  readCommitHistory,
  readDeployStatus,
  readDeployHistory,
  readServiceLogs,
  rollbackProject,
  runDockerCompose,
  runHealthCheck,
  updateProject
};
