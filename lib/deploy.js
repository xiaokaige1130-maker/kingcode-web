const fs = require("fs");
const os = require("os");
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

function section(title, body) {
  return `=== ${title} ===\n${body || "(no output)"}`;
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

function detectPackageManagerCommand(projectRoot) {
  if (fs.existsSync(path.join(projectRoot, "pnpm-lock.yaml"))) {
    return "pnpm install";
  }
  if (fs.existsSync(path.join(projectRoot, "yarn.lock"))) {
    return "yarn install";
  }
  return "npm install";
}

function parseGitHubRepo(repoUrl) {
  const source = String(repoUrl || "").trim();
  if (!source) {
    return null;
  }

  const sshMatch = source.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  const httpsMatch = source.match(/^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?(?:\/)?$/i);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }

  return null;
}

async function readOriginRemote(projectRoot) {
  const remote = await runCommand(projectRoot, "git remote get-url origin", 15000);
  return remote.ok ? remote.stdout.trim() : "";
}

async function readCurrentBranch(projectRoot) {
  const branch = await runCommand(projectRoot, "git rev-parse --abbrev-ref HEAD", 15000);
  return branch.ok ? branch.stdout.trim() : "";
}

async function downloadGitHubArchiveFallback(projectRoot, options = {}) {
  const repoUrl = String(options.repoUrl || "").trim() || await readOriginRemote(projectRoot);
  const parsed = parseGitHubRepo(repoUrl);
  if (!parsed) {
    return {
      ok: false,
      output: "Git 拉取失败，且当前远端不是可识别的 GitHub 仓库，无法切换到发布包更新。"
    };
  }

  const branch = String(options.branch || "").trim() || await readCurrentBranch(projectRoot) || "main";
  const archiveUrl = `https://codeload.github.com/${parsed.owner}/${parsed.repo}/tar.gz/refs/heads/${encodeURIComponent(branch)}`;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kingcode-update-"));
  const archivePath = path.join(tempRoot, `${parsed.repo}-${branch}.tar.gz`);
  const extractDir = path.join(tempRoot, "extract");
  fs.mkdirSync(extractDir, { recursive: true });

  const download = await runSteps(projectRoot, [
    { command: `curl -L --fail --connect-timeout 20 --max-time 180 ${shellQuote(archiveUrl)} -o ${shellQuote(archivePath)}`, timeout: 180000 },
    { command: `tar -xzf ${shellQuote(archivePath)} -C ${shellQuote(extractDir)} --strip-components=1`, timeout: 180000 },
    {
      command: `(cd ${shellQuote(extractDir)} && tar --exclude='.git' --exclude='node_modules' --exclude='data/providers.json' --exclude='data/auth.json' --exclude='data/deploy-history.json' -cf - .) | (cd ${shellQuote(projectRoot)} && tar -xf -)`,
      timeout: 180000
    }
  ]);

  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch (error) {
    // best effort cleanup only
  }

  const outputs = [
    section("发布包更新", [
      `仓库：${repoUrl}`,
      `分支：${branch}`,
      `下载地址：${archiveUrl}`,
      "",
      download.output || "(no output)"
    ].join("\n"))
  ];

  if (!download.ok) {
    return {
      ok: false,
      output: outputs.join("\n\n")
    };
  }

  const installCommand = String(options.installCommand || "").trim() || detectPackageManagerCommand(projectRoot);
  if (installCommand) {
    const install = await runSteps(projectRoot, [{ command: installCommand, timeout: 180000 }]);
    outputs.push(section("安装依赖", install.output || "(no output)"));
    if (!install.ok) {
      return {
        ok: false,
        output: outputs.join("\n\n")
      };
    }
  }

  if (options.buildCommand && String(options.buildCommand).trim()) {
    const build = await runSteps(projectRoot, [{ command: String(options.buildCommand).trim(), timeout: 180000 }]);
    outputs.push(section("构建项目", build.output || "(no output)"));
    if (!build.ok) {
      return {
        ok: false,
        output: outputs.join("\n\n")
      };
    }
  }

  outputs.push("说明：本次走的是 GitHub 发布包覆盖更新，不依赖 git pull；现有 .git、node_modules 和本机认证/配置文件已保留。");
  return {
    ok: true,
    output: outputs.join("\n\n"),
    usedArchiveFallback: true,
    archiveUrl
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

async function collectOpsSnapshot(root, options = {}) {
  const projectPath = options.projectPath || ".";
  const serviceName = String(options.serviceName || "").trim();
  const logSource = String(options.logSource || "pm2").trim() || "pm2";
  const lines = String(options.lines || "80").trim() || "80";
  const healthUrl = String(options.healthUrl || "").trim();
  const sections = [];
  const project = ensureDirectory(root, projectPath);

  sections.push(`Project Path: ${project.relativePath}`);
  sections.push(`Project Root: ${project.absolutePath}`);

  const status = await readDeployStatus(root, project.relativePath, serviceName, logSource === "systemd" ? "systemd" : "pm2");
  sections.push([
    "=== Service Status ===",
    status.output || "(no output)"
  ].join("\n"));

  const commits = await readCommitHistory(root, project.relativePath, 10);
  sections.push([
    "=== Recent Commits ===",
    commits.output || "(no output)"
  ].join("\n"));

  if ((serviceName && logSource !== "docker-compose") || logSource === "docker-compose") {
    const logs = await readServiceLogs(root, {
      projectPath: project.relativePath,
      serviceName,
      logSource,
      lines
    });
    sections.push([
      "=== Recent Logs ===",
      logs.output || "(no output)"
    ].join("\n"));
  } else {
    sections.push("=== Recent Logs ===\nSkipped: service name is required for PM2 or systemd logs.");
  }

  if (healthUrl) {
    const health = await runHealthCheck(healthUrl, Number(options.timeout) || 8000);
    sections.push([
      "=== Health Check ===",
      `Target: ${healthUrl}`,
      health.output || "(no output)"
    ].join("\n"));
  } else {
    sections.push("=== Health Check ===\nSkipped: no health URL provided.");
  }

  const output = sections.join("\n\n");
  recordDeployEvent({
    action: "ops-snapshot",
    ok: true,
    projectPath: project.relativePath,
    projectRoot: project.absolutePath,
    summary: `Collected backend ops snapshot${serviceName ? ` for ${serviceName}` : ""}`,
    output
  });

  return {
    ok: true,
    projectPath: project.relativePath,
    projectRoot: project.absolutePath,
    output
  };
}

async function listLocalServices(root, options = {}) {
  const project = ensureDirectory(root, options.projectPath || ".");
  const sections = [];

  const pm2 = await runCommand(project.absolutePath, "pm2 list", 30000);
  sections.push(section("PM2 Processes", pm2.combined || "PM2 unavailable or no processes found."));

  if (process.platform !== "win32") {
    const systemd = await runCommand(
      project.absolutePath,
      "systemctl list-units --type=service --state=running --no-pager --no-legend",
      30000
    );
    sections.push(section("Running systemd Services", systemd.combined || "systemd unavailable or no running services found."));
  }

  const docker = await runCommand(project.absolutePath, "docker ps --format 'table {{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.Ports}}'", 30000);
  sections.push(section("Docker Containers", docker.combined || "Docker unavailable or no running containers found."));

  const compose = await runCommand(project.absolutePath, "docker compose ps", 30000);
  sections.push(section("Docker Compose in Project", compose.combined || "No docker compose project detected in this scope."));

  const output = sections.join("\n\n");
  recordDeployEvent({
    action: "service-inventory",
    ok: true,
    projectPath: project.relativePath,
    projectRoot: project.absolutePath,
    summary: "Collected local service inventory",
    output
  });

  return {
    ok: true,
    projectPath: project.relativePath,
    projectRoot: project.absolutePath,
    output
  };
}

async function runOpsAudit(root, options = {}) {
  const project = ensureDirectory(root, options.projectPath || ".");
  const serviceName = String(options.serviceName || "").trim();
  const sections = [];

  const inventory = await listLocalServices(root, { projectPath: project.relativePath });
  sections.push(inventory.output);

  const snapshot = await collectOpsSnapshot(root, options);
  sections.push(snapshot.output);

  const ports = await runCommand(project.absolutePath, "ss -ltnp", 30000);
  sections.push(section("Listening Ports", ports.combined || "No listening port data."));

  const disk = await runCommand(project.absolutePath, "df -h", 30000);
  sections.push(section("Disk Usage", disk.combined || "Disk usage unavailable."));

  const memory = await runCommand(project.absolutePath, "free -h", 30000);
  sections.push(section("Memory Usage", memory.combined || "Memory usage unavailable."));

  if (serviceName) {
    const processInfo = await runCommand(project.absolutePath, `pgrep -af ${shellQuote(serviceName)}`, 30000);
    sections.push(section("Related Processes", processInfo.combined || "No matching processes found."));
  }

  const output = sections.join("\n\n");
  recordDeployEvent({
    action: "ops-audit",
    ok: true,
    projectPath: project.relativePath,
    projectRoot: project.absolutePath,
    summary: `Completed ops audit${serviceName ? ` for ${serviceName}` : ""}`,
    output
  });

  return {
    ok: true,
    projectPath: project.relativePath,
    projectRoot: project.absolutePath,
    output
  };
}

async function syncProjectFromRemote(root, options = {}) {
  const project = ensureDirectory(root, options.projectPath || ".");
  const branch = String(options.branch || "").trim();
  const runtime = String(options.runtime || "pm2");
  const outputs = [];
  const branchLabel = branch || "current branch";

  const inspect = await runSteps(project.absolutePath, [
    { command: "git remote -v" },
    { command: "git status --short --branch" },
    { command: "git fetch --all --prune" },
    { command: branch ? `git log --oneline HEAD..origin/${shellQuote(branch)}` : "git log --oneline HEAD..@{upstream}" }
  ]);

  outputs.push(inspect.output || "(no output)");

  if (!inspect.ok) {
    const fallback = await downloadGitHubArchiveFallback(project.absolutePath, options);
    outputs.push(section("发布包更新回退", fallback.output || "(no output)"));

    if (fallback.ok && options.serviceName) {
      if (runtime === "systemd" && process.platform !== "win32") {
        const restartAttempt = await runCommand(project.absolutePath, `sudo -n systemctl restart ${shellQuote(options.serviceName)}`);
        outputs.push(section("systemd 重启", restartAttempt.combined || "(no output)"));
        if (!restartAttempt.ok) {
          return {
            ok: false,
            projectPath: project.relativePath,
            projectRoot: project.absolutePath,
            output: outputs.join("\n\n")
          };
        }
      } else {
        const restartAttempt = await runCommand(project.absolutePath, `pm2 restart ${shellQuote(options.serviceName)}`);
        outputs.push(section("PM2 重启", restartAttempt.combined || "(no output)"));
        if (!restartAttempt.ok) {
          return {
            ok: false,
            projectPath: project.relativePath,
            projectRoot: project.absolutePath,
            output: outputs.join("\n\n")
          };
        }
        const saveAttempt = await runCommand(project.absolutePath, "pm2 save");
        outputs.push(section("PM2 保存", saveAttempt.combined || "(no output)"));
      }
    }

    const finalStatus = await readDeployStatus(root, project.relativePath, options.serviceName, runtime === "systemd" ? "systemd" : "pm2");
    outputs.push(section("Post-Update Service Status", finalStatus.output || "(no output)"));

    const payload = {
      ok: fallback.ok,
      projectPath: project.relativePath,
      projectRoot: project.absolutePath,
      output: outputs.join("\n\n"),
      branch: branchLabel
    };
    recordDeployEvent({
      action: "github-sync",
      ok: payload.ok,
      projectPath: payload.projectPath,
      projectRoot: payload.projectRoot,
      summary: `${payload.ok ? "Synced" : "Failed to sync"} project from remote on ${branchLabel}`,
      output: payload.output
    });
    return payload;
  }

  const update = await updateProject(root, options);
  outputs.push(section("Update Result", update.output || "(no output)"));

  if (options.healthUrl && String(options.healthUrl).trim()) {
    const health = await runHealthCheck(String(options.healthUrl).trim(), Number(options.timeout) || 8000);
    outputs.push(section("Post-Update Health Check", health.output || "(no output)"));
  }

  const finalStatus = await readDeployStatus(root, project.relativePath, options.serviceName, runtime === "systemd" ? "systemd" : "pm2");
  outputs.push(section("Post-Update Service Status", finalStatus.output || "(no output)"));

  const payload = {
    ok: update.ok,
    projectPath: project.relativePath,
    projectRoot: project.absolutePath,
    output: outputs.join("\n\n"),
    branch: branchLabel
  };

  recordDeployEvent({
    action: "github-sync",
    ok: payload.ok,
    projectPath: payload.projectPath,
    projectRoot: payload.projectRoot,
    summary: `Synced project from remote on ${branchLabel}`,
    output: payload.output
  });

  return payload;
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
    const fallback = await downloadGitHubArchiveFallback(project.absolutePath, options);
    const outputs = [
      section("Git 更新失败", result.output || "(no output)"),
      section("发布包更新回退", fallback.output || "(no output)")
    ];

    if (!fallback.ok) {
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
        summary: `Update failed${branch ? ` on ${branch}` : ""}`,
        output: payload.output
      });
      return payload;
    }

    if (!options.serviceName) {
      const payload = {
        ok: true,
        projectPath: project.relativePath,
        projectRoot: project.absolutePath,
        output: outputs.join("\n\n")
      };
      recordDeployEvent({
        action: "update",
        ok: true,
        projectPath: payload.projectPath,
        projectRoot: payload.projectRoot,
        summary: `Updated project via archive fallback${branch ? ` on ${branch}` : ""}`,
        output: payload.output
      });
      return payload;
    }

    const runtime = String(options.runtime || "pm2");
    if (runtime === "systemd" && process.platform !== "win32") {
      const restartAttempt = await runCommand(project.absolutePath, `sudo -n systemctl restart ${shellQuote(options.serviceName)}`);
      outputs.push(section("systemd 重启", restartAttempt.combined || "(no output)"));
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
        summary: `Updated project via archive fallback and restarted systemd ${options.serviceName}`,
        output: payload.output
      });
      return payload;
    }

    const restartAttempt = await runCommand(project.absolutePath, `pm2 restart ${shellQuote(options.serviceName)}`);
    outputs.push(section("PM2 重启", restartAttempt.combined || "(no output)"));
    if (restartAttempt.ok) {
      const saveAttempt = await runCommand(project.absolutePath, "pm2 save");
      outputs.push(section("PM2 保存", saveAttempt.combined || "(no output)"));
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
        summary: `Updated project via archive fallback and restarted PM2 ${options.serviceName}`,
        output: payload.output
      });
      return payload;
    }

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
      summary: `Archive fallback updated code but restart failed for ${options.serviceName}`,
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
  collectOpsSnapshot,
  cloneRepository,
  createPm2Service,
  createSystemdService,
  installDependencies,
  listLocalServices,
  readCommitHistory,
  readDeployStatus,
  readDeployHistory,
  readServiceLogs,
  rollbackProject,
  runOpsAudit,
  runDockerCompose,
  runHealthCheck,
  syncProjectFromRemote,
  updateProject
};
