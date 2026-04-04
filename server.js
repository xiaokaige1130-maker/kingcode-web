const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { exec } = require("child_process");
const { URL } = require("url");

const { loadConfig, saveConfig } = require("./lib/config");
const { changePassword, loadAuthConfig, verifyPassword } = require("./lib/auth");
const {
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
} = require("./lib/deploy");
const { commitAll, pushCurrentBranch, readGitSnapshot } = require("./lib/git");
const { sendChat, sendChatStream } = require("./lib/providers");
const { listSkills, loadSkillsByIds } = require("./lib/skills");
const {
  assertInsideWorkspace,
  buildTreeLines,
  collectFiles,
  listDirectory,
  readFile,
  resolveScope,
  writeFile
} = require("./lib/workspace");

const PUBLIC_DIR = path.join(__dirname, "public");
const runtimeConfig = loadConfig();
const HOST = process.env.HOST || runtimeConfig.listenHost || "0.0.0.0";
const PORT = Number(process.env.PORT || runtimeConfig.listenPort || 4780);
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const sessions = new Map();

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function unauthorized(response, error = "Authentication required.") {
  sendJson(response, 401, { error });
}

function sendText(response, statusCode, payload, contentType = "text/plain; charset=utf-8") {
  response.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  });
  response.end(payload);
}

function parseBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";

    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("Request body exceeded 1 MB."));
      }
    });

    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(new Error("Request body must be valid JSON."));
      }
    });

    request.on("error", reject);
  });
}

function parseCookies(request) {
  const source = String(request.headers.cookie || "");
  return Object.fromEntries(source
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const index = part.indexOf("=");
      if (index === -1) {
        return [part, ""];
      }
      return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
    }));
}

function createSession(username) {
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, {
    username,
    expiresAt: Date.now() + SESSION_TTL_MS
  });
  return token;
}

function readSession(request) {
  const token = parseCookies(request).kingcode_session;
  if (!token) {
    return null;
  }

  const session = sessions.get(token);
  if (!session) {
    return null;
  }

  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }

  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return {
    token,
    ...session
  };
}

function setSessionCookie(response, token) {
  response.setHeader("Set-Cookie", `kingcode_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
}

function clearSessionCookie(response) {
  response.setHeader("Set-Cookie", "kingcode_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
}

function isPublicApiRoute(pathname) {
  return pathname === "/api/health"
    || pathname === "/api/auth/status"
    || pathname === "/api/auth/login";
}

function buildAuthStatus(request, overrides = {}) {
  const auth = loadAuthConfig();
  const session = readSession(request);
  return {
    authenticated: typeof overrides.authenticated === "boolean" ? overrides.authenticated : Boolean(session),
    username: auth.username,
    mustChangePassword: auth.mustChangePassword,
    publicAccessEnabled: loadConfig().allowPublicAccess
  };
}

function getMimeType(filePath) {
  if (filePath.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }
  if (filePath.endsWith(".js")) {
    return "application/javascript; charset=utf-8";
  }
  if (filePath.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }
  return "text/html; charset=utf-8";
}

function serveStatic(requestUrl, response) {
  const requestedPath = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const target = path.join(PUBLIC_DIR, requestedPath);
  const normalized = path.resolve(target);

  if (!normalized.startsWith(path.resolve(PUBLIC_DIR))) {
    sendText(response, 403, "Forbidden");
    return;
  }

  if (!fs.existsSync(normalized) || fs.statSync(normalized).isDirectory()) {
    sendText(response, 404, "Not found");
    return;
  }

  sendText(response, 200, fs.readFileSync(normalized, "utf8"), getMimeType(normalized));
}

function runWorkspaceCommand(workspaceRoot, command) {
  return new Promise((resolve) => {
    const shellCommand = process.platform === "win32"
      ? `powershell.exe -NoProfile -Command ${JSON.stringify(command)}`
      : command;

    exec(shellCommand, { cwd: workspaceRoot, timeout: 20000, maxBuffer: 512 * 1024 }, (error, stdout, stderr) => {
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

function workflowPrompt(workflowId) {
  switch (workflowId) {
    case "analyze":
      return "Analyze the workspace structure, identify the main architecture, and list the most important modules first.";
    case "plan":
      return "Produce an implementation plan with risks, sequencing, and files likely to change.";
    case "review":
      return "Review the provided code like a senior reviewer. Lead with concrete risks, regressions, and missing tests.";
    case "implement":
      return "Propose the smallest correct implementation and include concrete code where helpful.";
    case "ops":
      return [
        "Act as a backend operations assistant.",
        "Treat local GitHub clone, pull, install, restart, and health-check tasks as part of your normal job on this machine.",
        "Prioritize production-safe diagnosis using the provided workspace, logs, deploy status, and health checks.",
        "Answer in Chinese.",
        "State the likely fault domain first, then the safest next action.",
        "Keep the answer short by default: 3 to 6 short lines or bullets.",
        "Do not expand into long explanations, multiple方案, or broad background unless the user explicitly asks for details.",
        "Prefer this structure: current issue, likely cause, evidence, next step.",
        "Default to plain Chinese operational guidance instead of code.",
        "Do not output code, patches, JSON, shell scripts, or config snippets unless the user explicitly asks for them.",
        "Keep the answer concise and readable for an operator who may not want implementation details.",
        "Do not suggest destructive commands unless the user explicitly asks for them.",
        "If information is missing, say exactly which command, log, or check should be gathered next."
      ].join(" ");
    default:
      return "";
  }
}

function buildScopedConfig(config, scopePath) {
  const scope = resolveScope(config.workspaceRoot, scopePath);
  return {
    ...config,
    workspaceRoot: scope.root
  };
}

function buildCapabilities(config) {
  return {
    product: "KingCode",
    summary: "面向当前工作区的本地运维助手，重点服务于这台 Ubuntu 机器上的项目维护、更新、巡检和排错。",
    workflows: [
      {
        id: "analyze",
        label: "分析",
        purpose: "分析项目结构，解释主要模块和整体架构。"
      },
      {
        id: "plan",
        label: "计划",
        purpose: "拆解实现步骤、风险点和可能改动的文件。"
      },
      {
        id: "review",
        label: "审查",
        purpose: "审查代码，优先指出缺陷、回归风险和缺失测试。"
      },
      {
        id: "implement",
        label: "实现",
        purpose: "给出或产出最小且正确的实现方案。"
      },
      {
        id: "ops",
        label: "运维",
        purpose: "充当本机 Ubuntu 运维助手，重点处理服务诊断、GitHub 更新、日志分析、健康检查和安全处置建议。"
      }
    ],
    tools: [
      "浏览当前作用范围内的目录",
      "读取和编辑当前作用范围内的文件",
      "把选中的文件加入对话上下文",
      "在当前作用范围内执行本地命令",
      "查看 Git 分支、远端和工作区状态",
      "创建 Git 提交并推送当前分支",
      "把仓库克隆到当前工作区",
      "按自定义安装命令安装依赖",
      "创建 PM2 服务",
      "在 Linux 上生成或安装 systemd 服务",
      "查看当前机器上的 PM2、systemd、Docker 和 Docker Compose 服务",
      "读取 PM2、systemd 或 Docker Compose 日志",
      "对当前服务或项目执行一次运维巡检",
      "执行 Docker Compose 常用动作",
      "对 HTTP 或 HTTPS 地址执行健康检查",
      "查看部署历史和最近提交记录",
      "更新已部署项目",
      "从 GitHub 或已配置的 Git 远端拉取更新、重启服务并验证状态",
      "把项目回滚到指定 Git 提交",
      "收集运维快照，用于故障排查"
    ],
    scopeRules: [
      `当前工作区根目录是 ${config.workspaceRoot}`,
      "文件浏览、编辑、命令执行和 skill 发现都受当前作用范围限制。",
      "已选文件和最近命令输出会自动注入对话上下文。"
    ],
    limits: [
      "没有内建 SSH 远程主机管理或多机集群管理",
      "没有内建告警中心、定时任务编排或监控大盘",
      "没有原生多智能体协作",
      "运维模式默认只讲人话结论，不会主动输出代码，除非你明确要求",
      "这个助手主要面向和 KingCode 运行在同一台 Ubuntu 机器上的服务"
    ],
    access: {
      allowPublicAccess: Boolean(config.allowPublicAccess),
      listenHost: config.listenHost,
      listenPort: config.listenPort
    }
  };
}

function buildContextBundle(config, scopePath, selectedFilePaths, recentCommandOutput) {
  const scope = resolveScope(config.workspaceRoot, scopePath);
  const tree = buildTreeLines(scope.root, ".", 2).join("\n");
  const files = collectFiles(scope.root, selectedFilePaths);
  const fileBlocks = files.map((file) => `FILE: ${file.path}\n${file.content}`).join("\n\n");
  const sections = [
    `Workspace root: ${config.workspaceRoot}`,
    `Scope path: ${scope.path}`,
    `Scope root: ${scope.root}`,
    `Workspace tree:\n${tree}`
  ];

  if (fileBlocks) {
    sections.push(`Selected files:\n${fileBlocks}`);
  }

  if (recentCommandOutput) {
    sections.push(`Recent command output:\n${recentCommandOutput}`);
  }

  return sections.join("\n\n");
}

function buildSkillBundle(config, scopePath, selectedSkillIds) {
  const skills = loadSkillsByIds(buildScopedConfig(config, scopePath), selectedSkillIds);
  if (skills.length === 0) {
    return "";
  }

  return skills.map((skill) => {
    return [
      `SKILL: ${skill.name}`,
      `Source: ${skill.sourceType}`,
      skill.content
    ].join("\n");
  }).join("\n\n");
}

function readScopePath(requestUrl, body) {
  if (body && typeof body.scopePath === "string") {
    return body.scopePath;
  }
  return requestUrl.searchParams.get("scopePath") || ".";
}

function buildChatMessages(config, scopePath, body) {
  const selectedFilePaths = Array.isArray(body.selectedFilePaths) ? body.selectedFilePaths : [];
  const selectedSkillIds = Array.isArray(body.selectedSkillIds) ? body.selectedSkillIds : [];
  const recentCommandOutput = typeof body.recentCommandOutput === "string" ? body.recentCommandOutput : "";
  const userMessages = Array.isArray(body.messages) ? body.messages : [];
  const contextBundle = buildContextBundle(config, scopePath, selectedFilePaths, recentCommandOutput);
  const skillBundle = buildSkillBundle(config, scopePath, selectedSkillIds);
  const promptPrefix = workflowPrompt(body.workflowId);

  return [
    { role: "system", content: config.systemPrompt },
    {
      role: "system",
      content: [
        "Answer in Chinese by default.",
        "For simple capability questions such as 你能做什么、你是谁、怎么用、能不能当我的运维助手, keep the reply short.",
        "Default to 3 to 6 short lines or bullets.",
        "For requests about downloading, cloning, updating, or installing a GitHub project on this machine, treat that as in-scope local ops work.",
        "Do not say you are only a coding assistant or refuse local repository bootstrap tasks when the repository address is clear.",
        "Do not output code, JSON, config examples, or long方案 unless the user explicitly asks for them."
      ].join(" ")
    },
    ...(skillBundle ? [{
      role: "system",
      content: `Apply the following skills when relevant.\n\n${skillBundle}`
    }] : []),
    {
      role: "user",
      content: [
        "Use the following workspace context when answering.",
        contextBundle,
        promptPrefix ? `Workflow instruction: ${promptPrefix}` : ""
      ].filter(Boolean).join("\n\n")
    },
    ...userMessages
  ];
}

async function handleApi(request, response, requestUrl) {
  try {
    if (request.method === "GET" && requestUrl.pathname === "/api/health") {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/auth/status") {
      sendJson(response, 200, buildAuthStatus(request));
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/auth/login") {
      const body = await parseBody(request);
      const auth = loadAuthConfig();
      const username = String(body.username || "").trim();
      const password = String(body.password || "");

      if (username !== auth.username || !verifyPassword(password, auth.passwordHash)) {
        unauthorized(response, "Invalid username or password.");
        return;
      }

      const token = createSession(auth.username);
      setSessionCookie(response, token);
      sendJson(response, 200, buildAuthStatus(request, { authenticated: true }));
      return;
    }

    if (!isPublicApiRoute(requestUrl.pathname)) {
      const session = readSession(request);
      if (!session) {
        unauthorized(response);
        return;
      }
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/auth/logout") {
      const session = readSession(request);
      if (session) {
        sessions.delete(session.token);
      }
      clearSessionCookie(response);
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/auth/password") {
      const body = await parseBody(request);
      const auth = loadAuthConfig();
      const currentPassword = String(body.currentPassword || "");
      const nextPassword = String(body.nextPassword || "");

      if (!verifyPassword(currentPassword, auth.passwordHash)) {
        sendJson(response, 400, { error: "Current password is incorrect." });
        return;
      }

      changePassword(nextPassword);
      sendJson(response, 200, buildAuthStatus(request, { authenticated: true }));
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/config") {
      sendJson(response, 200, loadConfig());
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/capabilities") {
      const config = loadConfig();
      sendJson(response, 200, buildCapabilities(config));
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/skills") {
      const config = loadConfig();
      const scope = resolveScope(config.workspaceRoot, readScopePath(requestUrl));
      sendJson(response, 200, {
        scopePath: scope.path,
        scopeRoot: scope.root,
        skills: listSkills(buildScopedConfig(config, scope.path))
      });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/config") {
      const current = loadConfig();
      const body = await parseBody(request);
      const saved = saveConfig(body);
      sendJson(response, 200, {
        ...saved,
        restartRequired: current.listenHost !== saved.listenHost || current.listenPort !== saved.listenPort
      });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/workspace/tree") {
      const config = loadConfig();
      const scope = resolveScope(config.workspaceRoot, readScopePath(requestUrl));
      const relativePath = requestUrl.searchParams.get("path") || ".";
      assertInsideWorkspace(scope.root, relativePath);
      sendJson(response, 200, {
        ...listDirectory(scope.root, relativePath),
        scopePath: scope.path,
        scopeRoot: scope.root
      });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/workspace/file") {
      const config = loadConfig();
      const scope = resolveScope(config.workspaceRoot, readScopePath(requestUrl));
      const relativePath = requestUrl.searchParams.get("path");

      if (!relativePath) {
        sendJson(response, 400, { error: "Missing file path." });
        return;
      }

      sendJson(response, 200, {
        path: relativePath,
        scopePath: scope.path,
        scopeRoot: scope.root,
        content: readFile(scope.root, relativePath)
      });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/workspace/file") {
      const config = loadConfig();
      const body = await parseBody(request);
      const scope = resolveScope(config.workspaceRoot, readScopePath(requestUrl, body));
      writeFile(scope.root, body.path, body.content || "");
      sendJson(response, 200, { ok: true, scopePath: scope.path, scopeRoot: scope.root });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/command") {
      const config = loadConfig();
      const body = await parseBody(request);
      const scope = resolveScope(config.workspaceRoot, readScopePath(requestUrl, body));
      const result = await runWorkspaceCommand(scope.root, body.command || "");
      sendJson(response, 200, {
        ...result,
        scopePath: scope.path,
        scopeRoot: scope.root
      });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/git/status") {
      const config = loadConfig();
      const scope = resolveScope(config.workspaceRoot, readScopePath(requestUrl));
      const snapshot = await readGitSnapshot(scope.root);
      sendJson(response, 200, {
        ...snapshot,
        scopePath: scope.path,
        scopeRoot: scope.root
      });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/git/commit") {
      const config = loadConfig();
      const body = await parseBody(request);
      const scope = resolveScope(config.workspaceRoot, readScopePath(requestUrl, body));
      const message = typeof body.message === "string" ? body.message.trim() : "";

      if (!message) {
        sendJson(response, 400, { error: "Commit message is required." });
        return;
      }

      const result = await commitAll(scope.root, message);
      if (!result.ok) {
        sendJson(response, 400, { error: result.combined || "Git commit failed." });
        return;
      }

      const snapshot = await readGitSnapshot(scope.root);
      sendJson(response, 200, {
        ...snapshot,
        output: result.combined || result.stdout || "(commit completed)",
        scopePath: scope.path,
        scopeRoot: scope.root
      });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/git/push") {
      const config = loadConfig();
      const body = await parseBody(request);
      const scope = resolveScope(config.workspaceRoot, readScopePath(requestUrl, body));
      const result = await pushCurrentBranch(scope.root);

      if (!result.ok) {
        sendJson(response, 400, { error: result.combined || "Git push failed." });
        return;
      }

      const snapshot = await readGitSnapshot(scope.root);
      sendJson(response, 200, {
        ...snapshot,
        output: result.combined || result.stdout || "(push completed)",
        scopePath: scope.path,
        scopeRoot: scope.root
      });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/deploy/status") {
      const config = loadConfig();
      const scope = resolveScope(config.workspaceRoot, readScopePath(requestUrl));
      const projectPath = requestUrl.searchParams.get("projectPath") || ".";
      const serviceName = requestUrl.searchParams.get("serviceName") || "";
      const result = await readDeployStatus(scope.root, projectPath, serviceName);

      if (!result.ok) {
        sendJson(response, 400, { error: result.output || "Failed to read deployment status." });
        return;
      }

      sendJson(response, 200, {
        ...result,
        scopePath: scope.path,
        scopeRoot: scope.root
      });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/deploy/clone") {
      const config = loadConfig();
      const body = await parseBody(request);
      const scope = resolveScope(config.workspaceRoot, readScopePath(requestUrl, body));
      const result = await cloneRepository(scope.root, body.repoUrl, body.targetPath, body.branch);

      if (!result.ok) {
        sendJson(response, 400, { error: result.output || "Failed to clone repository." });
        return;
      }

      sendJson(response, 200, {
        ...result,
        scopePath: scope.path,
        scopeRoot: scope.root
      });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/deploy/install") {
      const config = loadConfig();
      const body = await parseBody(request);
      const scope = resolveScope(config.workspaceRoot, readScopePath(requestUrl, body));
      const result = await installDependencies(scope.root, body.projectPath, body.installCommand);

      if (!result.ok) {
        sendJson(response, 400, { error: result.output || "Failed to install dependencies." });
        return;
      }

      sendJson(response, 200, {
        ...result,
        scopePath: scope.path,
        scopeRoot: scope.root
      });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/deploy/service") {
      const config = loadConfig();
      const body = await parseBody(request);
      const scope = resolveScope(config.workspaceRoot, readScopePath(requestUrl, body));
      const result = await createPm2Service(
        scope.root,
        body.projectPath,
        body.serviceName,
        body.serviceMode,
        body.serviceTarget
      );

      if (!result.ok) {
        sendJson(response, 400, { error: result.output || "Failed to create PM2 service." });
        return;
      }

      sendJson(response, 200, {
        ...result,
        scopePath: scope.path,
        scopeRoot: scope.root
      });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/deploy/systemd") {
      const config = loadConfig();
      const body = await parseBody(request);
      const scope = resolveScope(config.workspaceRoot, readScopePath(requestUrl, body));
      const result = await createSystemdService(scope.root, body);

      if (!result.ok) {
        sendJson(response, 400, { error: result.output || "Failed to create systemd service." });
        return;
      }

      sendJson(response, 200, {
        ...result,
        scopePath: scope.path,
        scopeRoot: scope.root
      });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/deploy/logs") {
      const config = loadConfig();
      const scope = resolveScope(config.workspaceRoot, readScopePath(requestUrl));
      const result = await readServiceLogs(scope.root, {
        projectPath: requestUrl.searchParams.get("projectPath") || ".",
        serviceName: requestUrl.searchParams.get("serviceName") || "",
        logSource: requestUrl.searchParams.get("logSource") || "pm2",
        lines: requestUrl.searchParams.get("lines") || "80"
      });

      if (!result.ok) {
        sendJson(response, 400, { error: result.output || "Failed to read logs." });
        return;
      }

      sendJson(response, 200, {
        ...result,
        scopePath: scope.path,
        scopeRoot: scope.root
      });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/deploy/history") {
      const limit = requestUrl.searchParams.get("limit") || "20";
      sendJson(response, 200, {
        entries: readDeployHistory(limit)
      });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/deploy/commits") {
      const config = loadConfig();
      const scope = resolveScope(config.workspaceRoot, readScopePath(requestUrl));
      const result = await readCommitHistory(
        scope.root,
        requestUrl.searchParams.get("projectPath") || ".",
        requestUrl.searchParams.get("limit") || "15"
      );

      if (!result.ok) {
        sendJson(response, 400, { error: result.output || "Failed to read commit history." });
        return;
      }

      sendJson(response, 200, {
        ...result,
        scopePath: scope.path,
        scopeRoot: scope.root
      });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/deploy/health") {
      const targetUrl = requestUrl.searchParams.get("url") || "";
      const timeout = requestUrl.searchParams.get("timeout") || "8000";
      const result = await runHealthCheck(targetUrl, Number(timeout) || 8000);
      sendJson(response, result.ok ? 200 : 400, result);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/deploy/docker") {
      const config = loadConfig();
      const body = await parseBody(request);
      const scope = resolveScope(config.workspaceRoot, readScopePath(requestUrl, body));
      const result = await runDockerCompose(scope.root, body.projectPath, body.composeAction);

      if (!result.ok) {
        sendJson(response, 400, { error: result.output || "Failed to run docker compose action." });
        return;
      }

      sendJson(response, 200, {
        ...result,
        scopePath: scope.path,
        scopeRoot: scope.root
      });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/deploy/rollback") {
      const config = loadConfig();
      const body = await parseBody(request);
      const scope = resolveScope(config.workspaceRoot, readScopePath(requestUrl, body));
      const result = await rollbackProject(scope.root, body);

      if (!result.ok) {
        sendJson(response, 400, { error: result.output || "Failed to roll back project." });
        return;
      }

      sendJson(response, 200, {
        ...result,
        scopePath: scope.path,
        scopeRoot: scope.root
      });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/deploy/update") {
      const config = loadConfig();
      const body = await parseBody(request);
      const scope = resolveScope(config.workspaceRoot, readScopePath(requestUrl, body));
      const result = await updateProject(scope.root, body);

      if (!result.ok) {
        sendJson(response, 400, { error: result.output || "Failed to update project." });
        return;
      }

      sendJson(response, 200, {
        ...result,
        scopePath: scope.path,
        scopeRoot: scope.root
      });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/ops/snapshot") {
      const config = loadConfig();
      const body = await parseBody(request);
      const scope = resolveScope(config.workspaceRoot, readScopePath(requestUrl, body));
      const result = await collectOpsSnapshot(scope.root, body);

      if (!result.ok) {
        sendJson(response, 400, { error: result.output || "Failed to collect operations snapshot." });
        return;
      }

      sendJson(response, 200, {
        ...result,
        scopePath: scope.path,
        scopeRoot: scope.root
      });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/ops/services") {
      const config = loadConfig();
      const body = await parseBody(request);
      const scope = resolveScope(config.workspaceRoot, readScopePath(requestUrl, body));
      const result = await listLocalServices(scope.root, body);

      sendJson(response, 200, {
        ...result,
        scopePath: scope.path,
        scopeRoot: scope.root
      });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/ops/audit") {
      const config = loadConfig();
      const body = await parseBody(request);
      const scope = resolveScope(config.workspaceRoot, readScopePath(requestUrl, body));
      const result = await runOpsAudit(scope.root, body);

      sendJson(response, 200, {
        ...result,
        scopePath: scope.path,
        scopeRoot: scope.root
      });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/ops/sync") {
      const config = loadConfig();
      const body = await parseBody(request);
      const scope = resolveScope(config.workspaceRoot, readScopePath(requestUrl, body));
      const result = await syncProjectFromRemote(scope.root, body);

      if (!result.ok) {
        sendJson(response, 400, { error: result.output || "Failed to sync project from remote." });
        return;
      }

      sendJson(response, 200, {
        ...result,
        scopePath: scope.path,
        scopeRoot: scope.root
      });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/chat") {
      const config = loadConfig();
      const body = await parseBody(request);
      const scope = resolveScope(config.workspaceRoot, readScopePath(requestUrl, body));
      const finalMessages = buildChatMessages(config, scope.path, body);

      const content = await sendChat(config, body.profileId || config.activeProfileId, finalMessages);
      sendJson(response, 200, {
        content,
        scopePath: scope.path,
        scopeRoot: scope.root
      });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/chat/stream") {
      const config = loadConfig();
      const body = await parseBody(request);
      const scope = resolveScope(config.workspaceRoot, readScopePath(requestUrl, body));
      const finalMessages = buildChatMessages(config, scope.path, body);

      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive"
      });

      try {
        const content = await sendChatStream(config, body.profileId || config.activeProfileId, finalMessages, {
          async onToken(token) {
            response.write(`data: ${JSON.stringify({ type: "token", token })}\n\n`);
          }
        });

        response.write(`data: ${JSON.stringify({
          type: "done",
          content,
          scopePath: scope.path,
          scopeRoot: scope.root
        })}\n\n`);
      } catch (error) {
        response.write(`data: ${JSON.stringify({ type: "error", error: error.message || "Chat stream failed." })}\n\n`);
      }

      response.end();
      return;
    }

    sendJson(response, 404, { error: "Unknown API route." });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "Unexpected server error." });
  }
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);

  if (requestUrl.pathname.startsWith("/api/")) {
    await handleApi(request, response, requestUrl);
    return;
  }

  serveStatic(requestUrl, response);
});

server.listen(PORT, () => {
  console.log(`KingCode listening on http://localhost:${PORT}`);
});
