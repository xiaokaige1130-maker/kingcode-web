const http = require("http");
const path = require("path");
const fs = require("fs");
const { exec } = require("child_process");
const { URL } = require("url");

const { loadConfig, saveConfig } = require("./lib/config");
const { sendChat } = require("./lib/providers");
const { listSkills, loadSkillsByIds } = require("./lib/skills");
const {
  assertInsideWorkspace,
  buildTreeLines,
  collectFiles,
  listDirectory,
  readFile,
  writeFile
} = require("./lib/workspace");

const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = Number(process.env.PORT || 4780);

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
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
    default:
      return "";
  }
}

function buildContextBundle(config, selectedFilePaths, recentCommandOutput) {
  const workspaceRoot = config.workspaceRoot;
  const tree = buildTreeLines(workspaceRoot, ".", 2).join("\n");
  const files = collectFiles(workspaceRoot, selectedFilePaths);
  const fileBlocks = files.map((file) => `FILE: ${file.path}\n${file.content}`).join("\n\n");
  const sections = [
    `Workspace root: ${workspaceRoot}`,
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

function buildSkillBundle(config, selectedSkillIds) {
  const skills = loadSkillsByIds(config, selectedSkillIds);
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

async function handleApi(request, response, requestUrl) {
  try {
    if (request.method === "GET" && requestUrl.pathname === "/api/health") {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/config") {
      sendJson(response, 200, loadConfig());
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/skills") {
      const config = loadConfig();
      sendJson(response, 200, { skills: listSkills(config) });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/config") {
      const body = await parseBody(request);
      sendJson(response, 200, saveConfig(body));
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/workspace/tree") {
      const config = loadConfig();
      const relativePath = requestUrl.searchParams.get("path") || ".";
      assertInsideWorkspace(config.workspaceRoot, relativePath);
      sendJson(response, 200, listDirectory(config.workspaceRoot, relativePath));
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/workspace/file") {
      const config = loadConfig();
      const relativePath = requestUrl.searchParams.get("path");

      if (!relativePath) {
        sendJson(response, 400, { error: "Missing file path." });
        return;
      }

      sendJson(response, 200, {
        path: relativePath,
        content: readFile(config.workspaceRoot, relativePath)
      });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/workspace/file") {
      const config = loadConfig();
      const body = await parseBody(request);
      writeFile(config.workspaceRoot, body.path, body.content || "");
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/command") {
      const config = loadConfig();
      const body = await parseBody(request);
      const result = await runWorkspaceCommand(config.workspaceRoot, body.command || "");
      sendJson(response, 200, result);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/chat") {
      const config = loadConfig();
      const body = await parseBody(request);
      const selectedFilePaths = Array.isArray(body.selectedFilePaths) ? body.selectedFilePaths : [];
      const selectedSkillIds = Array.isArray(body.selectedSkillIds) ? body.selectedSkillIds : [];
      const recentCommandOutput = typeof body.recentCommandOutput === "string" ? body.recentCommandOutput : "";
      const userMessages = Array.isArray(body.messages) ? body.messages : [];
      const contextBundle = buildContextBundle(config, selectedFilePaths, recentCommandOutput);
      const skillBundle = buildSkillBundle(config, selectedSkillIds);
      const promptPrefix = workflowPrompt(body.workflowId);
      const finalMessages = [
        { role: "system", content: config.systemPrompt },
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

      const content = await sendChat(config, body.profileId || config.activeProfileId, finalMessages);
      sendJson(response, 200, { content });
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
