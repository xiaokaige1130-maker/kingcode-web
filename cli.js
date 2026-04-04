#!/usr/bin/env node
const path = require("path");
const readline = require("readline/promises");
const { exec } = require("child_process");
const { stdin, stdout, stderr } = require("process");

const { loadConfig } = require("./lib/config");
const { collectOpsSnapshot, listLocalServices, runOpsAudit, syncProjectFromRemote } = require("./lib/deploy");
const { commitAll, pushCurrentBranch, readGitSnapshot } = require("./lib/git");
const { sendChat, sendChatStream } = require("./lib/providers");
const { listSkills, loadSkillsByIds } = require("./lib/skills");
const {
  assertInsideWorkspace,
  buildTreeLines,
  collectFiles,
  listDirectory,
  normalizeRelativePath,
  readFile,
  resolveScope,
  writeFile
} = require("./lib/workspace");

const WORKFLOWS = new Set(["analyze", "plan", "review", "implement", "ops"]);
const MAX_AUTONOMOUS_ACTIONS = 5;
const MAX_AUTONOMOUS_ROUNDS = 4;
const DANGEROUS_COMMAND_PATTERNS = [
  /\bsudo\b/i,
  /\brm\s+-rf\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bmkfs\b/i,
  /\bdd\b/i,
  /\bpoweroff\b/i
];

const SKILL_LABELS = {
  "backend-ops": "后端运维助手",
  "docker-compose-audit": "Docker / Compose 检查",
  "github-actions-ci": "GitHub Actions 检查",
  "grounded-analysis": "基于上下文分析",
  "secrets-audit": "密钥泄露检查",
  "security-review": "安全审查",
  "sentry-readonly": "Sentry 只读排错",
  "stack-readiness": "部署就绪检查"
};

const SKILL_SOURCE_LABELS = {
  app: "应用内置",
  workspace: "工作区",
  claude: "Claude 风格",
  codex: "Codex 风格",
  openclaw: "OpenClaw 风格",
  custom: "自定义"
};

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
        "Start with the most likely fault domain, then list evidence, user impact, and the safest next steps.",
        "Use logs, service status, health checks, and recent commits before proposing changes.",
        "Default to plain Chinese operational guidance instead of code.",
        "Do not output code, patches, JSON, shell snippets, or config examples unless the user explicitly asks for them.",
        "Keep the answer concise and optimized for a human operator.",
        "Avoid destructive actions unless the user explicitly approves them.",
        "If diagnosis is incomplete, ask for the next concrete observation to gather."
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
    workflows: [
      "分析：分析项目结构和整体架构",
      "计划：产出实现步骤、风险点和执行顺序",
      "审查：检查代码缺陷、回归风险和缺失测试",
      "实现：给出或产出最小且正确的实现",
      "运维：结合状态、日志、健康检查和最近提交诊断服务问题"
    ],
    tools: [
      "浏览当前作用范围内的目录",
      "读取和写入当前作用范围内的文件",
      "把文件加入 AI 对话上下文",
      "在当前作用范围内执行本地命令",
      "查看 Git 状态、提交和推送",
      "克隆仓库并安装依赖",
      "创建 PM2 或 systemd 服务",
      "查看 PM2、systemd 和 Docker Compose 日志",
      "执行健康检查和 Docker Compose 动作",
      "查看本机 PM2、systemd、Docker 和 Docker Compose 服务",
      "对当前服务或项目执行一次运维巡检",
      "从已配置 Git 远端同步项目并验证服务状态",
      "更新已部署项目并按提交回滚",
      "收集运维快照用于故障排查"
    ],
    limits: [
      "没有内建 SSH 远程主机管理",
      "没有内建监控大盘和告警中心",
      "没有多智能体协作",
      "Web 聊天不是流式显示",
      "运维模式默认输出白话结论，而不是代码"
    ]
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

function runWorkspaceCommand(workspaceRoot, command) {
  return new Promise((resolve) => {
    const shellCommand = process.platform === "win32"
      ? `powershell.exe -NoProfile -Command ${JSON.stringify(command)}`
      : command;

    exec(shellCommand, { cwd: workspaceRoot, timeout: 20000, maxBuffer: 512 * 1024 }, (error, stdoutText, stderrText) => {
      resolve({
        ok: !error,
        code: error && typeof error.code === "number" ? error.code : 0,
        stdout: stdoutText,
        stderr: stderrText,
        combined: [stdoutText, stderrText].filter(Boolean).join("\n").trim()
      });
    });
  });
}

function stripMarkdownFence(text) {
  const trimmed = String(text || "").trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

function tryParseJson(text) {
  try {
    return JSON.parse(stripMarkdownFence(text));
  } catch (error) {
    const source = String(text || "");
    const start = source.indexOf("{");
    const end = source.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      try {
        return JSON.parse(source.slice(start, end + 1));
      } catch (nestedError) {
        return null;
      }
    }
    return null;
  }
}

function isDangerousCommand(command) {
  const normalized = String(command || "").trim();
  if (!normalized) {
    return false;
  }
  return DANGEROUS_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized));
}

function buildAutonomousMessages(config, state, userInput, executionLog = "") {
  const selectedFilePaths = [...state.selectedFiles];
  const contextBundle = buildContextBundle(config, state.scopePath, selectedFilePaths, state.recentCommandOutput);
  const skillBundle = buildSkillBundle(config, state.scopePath, state.selectedSkillIds);
  const promptPrefix = workflowPrompt(state.workflowId);

  return [
    { role: "system", content: config.systemPrompt },
    {
      role: "system",
      content: [
        "默认使用中文回答。",
        "如果用户问的是能力清单、你能做什么、怎么用、能不能当运维助手这类简单问题，默认短答。",
        "控制在 3 到 6 行内。",
        "除非用户明确要求，否则不要输出代码、JSON、配置片段或长篇方案。"
      ].join(" ")
    },
    ...(skillBundle ? [{
      role: "system",
      content: `Apply the following skills when relevant.\n\n${skillBundle}`
    }] : []),
    {
      role: "system",
      content: [
        "你正在操作带有直接工作区动作能力的 KingCode CLI。",
        "判断用户请求是只需要聊天回复，还是需要真实执行动作。",
        "只返回合法 JSON，结构如下：",
        '{"mode":"chat|act|done","assistant":"short reply","actions":[{"type":"run","command":"..."},{"type":"write","path":"relative/path","content":"..."},{"type":"read","path":"relative/path"},{"type":"ls","path":"relative/path"},{"type":"include","path":"relative/path"}]}',
        "规则：",
        "- 只有在任务确实需要执行工作区动作时才使用 mode=act。",
        "- 查看最新执行结果后如果任务已完成，使用 mode=done。",
        "- assistant 字段默认使用简短中文。",
        "- actions 保持最小化，并按顺序执行。",
        "- 只允许使用当前工作区范围内的相对路径。",
        "- 禁止使用 sudo、rm -rf、git reset --hard、shutdown、reboot、poweroff、mkfs、dd。",
        `- Use at most ${MAX_AUTONOMOUS_ACTIONS} actions.`,
        "- 上下文不足时，优先 read / ls / include，再考虑 write。",
        "- 如果不需要真实动作，返回 mode=chat 且 actions=[].",
        "- 如果已有执行结果足以结束任务，返回 mode=done 且 actions=[]."
      ].join("\n")
    },
    {
      role: "user",
      content: [
        "Use the following workspace context when deciding what to do.",
        contextBundle,
        promptPrefix ? `Workflow instruction: ${promptPrefix}` : "",
        executionLog ? `Execution log so far:\n${executionLog}` : ""
      ].filter(Boolean).join("\n\n")
    },
    ...state.messages,
    { role: "user", content: userInput }
  ];
}

async function planAutonomousTurn(config, state, userInput, executionLog = "") {
  let raw = await sendChat(config, state.profileId, buildAutonomousMessages(config, state, userInput, executionLog));
  let parsed = tryParseJson(raw);
  if (!parsed) {
    raw = await sendChat(config, state.profileId, [
      ...buildAutonomousMessages(config, state, userInput, executionLog),
      {
        role: "user",
        content: "Your previous reply was invalid. Return ONLY one JSON object matching the required schema. No prose."
      }
    ]);
    parsed = tryParseJson(raw);
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const mode = parsed.mode === "act" || parsed.mode === "done" ? parsed.mode : "chat";
  const assistant = typeof parsed.assistant === "string" ? parsed.assistant.trim() : "";
  const actions = Array.isArray(parsed.actions)
    ? parsed.actions
      .filter((action) => action && typeof action === "object" && typeof action.type === "string")
      .slice(0, MAX_AUTONOMOUS_ACTIONS)
    : [];

  return { mode, assistant, actions };
}

async function executeAutonomousPlan(config, state, userInput, plan) {
  const scope = resolveScope(config.workspaceRoot, state.scopePath);
  const logs = [];

  for (const [index, action] of plan.actions.entries()) {
    if (action.type === "read") {
      const targetPath = String(action.path || "").trim();
      if (!targetPath) {
        logs.push(`Action ${index + 1}: skipped read with empty path.`);
        continue;
      }

      const content = readFile(scope.root, targetPath);
      state.selectedFiles.add(normalizeRelativePath(targetPath));
      logs.push([
        `Action ${index + 1}: read ${targetPath}`,
        content
      ].join("\n"));
      continue;
    }

    if (action.type === "ls") {
      const targetPath = String(action.path || ".").trim() || ".";
      const listing = listDirectory(scope.root, targetPath);
      logs.push([
        `Action ${index + 1}: ls ${targetPath}`,
        listing.entries.map((entry) => `${entry.type === "directory" ? "[D]" : "[F]"} ${entry.path}`).join("\n") || "(empty)"
      ].join("\n"));
      continue;
    }

    if (action.type === "include") {
      const targetPath = String(action.path || "").trim();
      if (!targetPath) {
        logs.push(`Action ${index + 1}: skipped include with empty path.`);
        continue;
      }

      readFile(scope.root, targetPath);
      state.selectedFiles.add(normalizeRelativePath(targetPath));
      logs.push(`Action ${index + 1}: included ${targetPath}`);
      continue;
    }

    if (action.type === "run") {
      const command = String(action.command || "").trim();
      if (!command) {
        logs.push(`Action ${index + 1}: skipped empty command.`);
        continue;
      }
      if (isDangerousCommand(command)) {
        logs.push(`Action ${index + 1}: blocked dangerous command: ${command}`);
        continue;
      }

      const result = await runWorkspaceCommand(scope.root, command);
      state.recentCommandOutput = result.combined;
      logs.push([
        `Action ${index + 1}: run ${command}`,
        `Exit code: ${result.code}`,
        result.combined || "(no output)"
      ].join("\n"));
      continue;
    }

    if (action.type === "write") {
      const targetPath = String(action.path || "").trim();
      if (!targetPath) {
        logs.push(`Action ${index + 1}: skipped write with empty path.`);
        continue;
      }

      const content = typeof action.content === "string" ? action.content : "";
      writeFile(scope.root, targetPath, content);
      logs.push(`Action ${index + 1}: wrote ${targetPath} (${Buffer.byteLength(content, "utf8")} bytes)`);
      continue;
    }

    logs.push(`Action ${index + 1}: unsupported action type ${action.type}`);
  }

  const summary = plan.assistant || "已执行计划中的工作区操作。";
  printBlock("自动执行", summary);
  printBlock("自动执行详情", logs.join("\n\n") || "(无操作)");
  state.messages.push({ role: "user", content: userInput });
  state.messages.push({
    role: "assistant",
    content: [summary, logs.join("\n\n")].filter(Boolean).join("\n\n")
  });

  return [summary, logs.join("\n\n")].filter(Boolean).join("\n\n");
}

async function runAutonomousTurn(config, state, userInput) {
  let executionLog = "";

  for (let round = 0; round < MAX_AUTONOMOUS_ROUNDS; round += 1) {
    const plan = await planAutonomousTurn(config, state, userInput, executionLog);
    if (!plan) {
      return false;
    }

    if (plan.mode === "chat" || (plan.mode === "act" && plan.actions.length === 0)) {
      return false;
    }

    if (plan.mode === "done") {
      const summary = plan.assistant || "任务已完成。";
      printBlock("自动执行", summary);
      state.messages.push({ role: "user", content: userInput });
      state.messages.push({ role: "assistant", content: summary });
      return true;
    }

    const stepSummary = await executeAutonomousPlan(config, state, userInput, plan);
    executionLog = [
      executionLog,
      `Round ${round + 1}:`,
      stepSummary
    ].filter(Boolean).join("\n\n");
  }

  printBlock("自动执行", "已达到自动执行轮次上限。如需继续，请手动补充操作。");
  state.messages.push({ role: "user", content: userInput });
  state.messages.push({ role: "assistant", content: executionLog || "已达到自动执行轮次上限。" });
  return true;
}

function printBlock(title, content) {
  stdout.write(`\n[${title}]\n`);
  stdout.write(`${content || "(empty)"}\n`);
}

function printHelp() {
  printBlock("Commands", [
    "/help                     Show this help",
    "/status                   查看当前模型、工作流、工作区和已选文件",
    "/profiles                 查看已配置模型",
    "/profile <id>             切换当前模型",
    "/capabilities             查看当前能力清单",
    "/workflows                查看可用工作流",
    "/workflow <id>            切换工作流：analyze | plan | review | implement | ops",
    "/scope [path]             查看或设置当前作用范围",
    "/skills                   查看已发现的 skills",
    "/skillinfo <id>           查看某个 skill 详情",
    "/skill <id>               启用 skill",
    "/unskill <id>             关闭 skill",
    "/tree [path]              查看浅层目录树",
    "/ls [path]                查看单个目录",
    "/open <path>              打开文件内容",
    "/include <path>           把文件加入对话上下文",
    "/exclude <path>           把文件移出对话上下文",
    "/files                    查看已加入上下文的文件",
    "/write <path>             写入文件，多行输入以 .end 结束",
    "/run <command>            在当前工作区执行命令",
    "/ops snapshot             收集运维快照并写入对话上下文",
    "/ops services             查看本机 PM2/systemd/docker 服务",
    "/ops audit                执行一次本机运维巡检",
    "/ops sync [branch]        从远端拉取更新并重启验证",
    "/git status               查看 Git 分支、远端和工作区状态",
    "/git commit <message>     提交当前仓库变更",
    "/git push                 推送当前分支",
    "直接输入文本              会在合适时自动执行安全的读文件/列目录/命令等操作",
    "/clearcmd                 清除已保存的命令输出上下文",
    "/exit                     退出"
  ].join("\n"));
}

function getPrompt(state) {
  const scopeSuffix = state.scopePath && state.scopePath !== "."
    ? `:${state.scopePath}`
    : "";
  return `kingcode:${state.workflowId}:${state.profileId}${scopeSuffix}> `;
}

function buildSkillBundle(config, scopePath, selectedSkillIds) {
  const skills = loadSkillsByIds(buildScopedConfig(config, scopePath), [...selectedSkillIds]);
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

async function readMultiline(rl, firstPrompt, continuationPrompt) {
  stdout.write(`${firstPrompt}\n`);
  stdout.write("Finish input with a single line: .end\n");

  const lines = [];
  while (true) {
    const line = await rl.question(continuationPrompt);
    if (line === ".end") {
      break;
    }
    lines.push(line);
  }
  return lines.join("\n");
}

function relativeLabel(workspaceRoot, targetPath) {
  return path.relative(workspaceRoot, targetPath).replace(/\\/g, "/") || ".";
}

function syncScopeSkills(config, state) {
  const knownSkills = new Set(listSkills(buildScopedConfig(config, state.scopePath)).map((skill) => skill.id));
  for (const skillId of [...state.selectedSkillIds]) {
    if (!knownSkills.has(skillId)) {
      state.selectedSkillIds.delete(skillId);
    }
  }
}

async function handleSlashCommand(rl, config, state, line) {
  const trimmed = line.trim();
  const [rawCommand, ...rawArgs] = trimmed.split(" ");
  const command = rawCommand.toLowerCase();
  const args = rawArgs.filter(Boolean);
  const rest = trimmed.slice(rawCommand.length).trim();

  switch (command) {
    case "/help":
      printHelp();
      return;
    case "/status": {
      const scope = resolveScope(config.workspaceRoot, state.scopePath);
      printBlock("当前状态", [
        `工作区根目录: ${config.workspaceRoot}`,
        `当前范围: ${scope.path}`,
        `范围根目录: ${scope.root}`,
        `当前模型: ${state.profileId}`,
        `当前工作流: ${state.workflowId}`,
        `已加入上下文的文件: ${state.selectedFiles.size > 0 ? [...state.selectedFiles].join(", ") : "(无)"}`,
        `是否有已保存命令输出: ${state.recentCommandOutput ? "有" : "无"}`
      ].join("\n"));
      return;
    }
    case "/profiles":
      printBlock("模型列表", config.profiles.map((profile) => {
        const marker = profile.id === state.profileId ? "*" : " ";
        return `${marker} ${profile.id} -> ${profile.name} (${profile.type})`;
      }).join("\n"));
      return;
    case "/capabilities": {
      const capabilities = buildCapabilities(config);
      printBlock("能力清单", [
        "工作流:",
        capabilities.workflows.map((item) => `- ${item}`).join("\n"),
        "",
        "工具能力:",
        capabilities.tools.map((item) => `- ${item}`).join("\n"),
        "",
        "限制:",
        capabilities.limits.map((item) => `- ${item}`).join("\n")
      ].join("\n"));
      return;
    }
    case "/profile": {
      const nextId = args[0];
      if (!nextId) {
        throw new Error("Usage: /profile <id>");
      }
      const match = config.profiles.find((profile) => profile.id === nextId);
      if (!match) {
        throw new Error(`Unknown profile: ${nextId}`);
      }
      state.profileId = nextId;
      printBlock("模型", `已切换到 ${match.name} (${match.id})`);
      return;
    }
    case "/workflows":
      printBlock("工作流", [...WORKFLOWS].join("\n"));
      return;
    case "/workflow": {
      const nextWorkflow = args[0];
      if (!WORKFLOWS.has(nextWorkflow)) {
        throw new Error("Usage: /workflow <analyze|plan|review|implement|ops>");
      }
      state.workflowId = nextWorkflow;
      printBlock("工作流", `已切换到 ${nextWorkflow}`);
      return;
    }
    case "/scope": {
      if (!rest) {
        const scope = resolveScope(config.workspaceRoot, state.scopePath);
        printBlock("作用范围", [
          `工作区根目录: ${config.workspaceRoot}`,
          `当前范围: ${scope.path}`,
          `范围根目录: ${scope.root}`
        ].join("\n"));
        return;
      }

      const scope = resolveScope(config.workspaceRoot, rest);
      state.scopePath = scope.path;
      state.selectedFiles.clear();
      state.recentCommandOutput = "";
      state.messages = [];
      syncScopeSkills(config, state);
      printBlock("作用范围", [
        `当前范围: ${scope.path}`,
        `范围根目录: ${scope.root}`,
        "已为新范围清空文件上下文、命令输出和聊天记录。"
      ].join("\n"));
      return;
    }
    case "/skills": {
      const skills = listSkills(buildScopedConfig(config, state.scopePath));
      printBlock("Skills", skills.length > 0 ? skills.map((skill) => {
        const marker = state.selectedSkillIds.has(skill.id) ? "*" : " ";
        const suffix = skill.description ? ` - ${skill.description}` : "";
        const label = SKILL_LABELS[skill.name] || skill.name || skill.id;
        const source = SKILL_SOURCE_LABELS[skill.sourceType] || skill.sourceType;
        return `${marker} ${skill.id} [${label} / ${source}]${suffix}`;
      }).join("\n") : "No skills found. Supported roots: ./skills, <workspace>/skills, <workspace>/.claude/skills");
      return;
    }
    case "/skillinfo": {
      const skillId = args[0];
      if (!skillId) {
        throw new Error("Usage: /skillinfo <id>");
      }
      const skill = loadSkillsByIds(buildScopedConfig(config, state.scopePath), [skillId])[0];
      if (!skill) {
        throw new Error(`Unknown skill: ${skillId}`);
      }
      printBlock(`Skill ${skill.id}`, [
        `Name: ${skill.name}`,
        `Source: ${skill.sourceType}`,
        `Path: ${skill.path}`,
        "",
        skill.content
      ].join("\n"));
      return;
    }
    case "/skill": {
      const skillId = args[0];
      if (!skillId) {
        throw new Error("Usage: /skill <id>");
      }
      const known = listSkills(buildScopedConfig(config, state.scopePath)).find((skill) => skill.id === skillId);
      if (!known) {
        throw new Error(`Unknown skill: ${skillId}`);
      }
      state.selectedSkillIds.add(skillId);
      printBlock("Enabled Skills", [...state.selectedSkillIds].join("\n"));
      return;
    }
    case "/unskill": {
      const skillId = args[0];
      if (!skillId) {
        throw new Error("Usage: /unskill <id>");
      }
      state.selectedSkillIds.delete(skillId);
      printBlock("Enabled Skills", state.selectedSkillIds.size > 0 ? [...state.selectedSkillIds].join("\n") : "(none)");
      return;
    }
    case "/tree": {
      const scope = resolveScope(config.workspaceRoot, state.scopePath);
      const target = args[0] || ".";
      assertInsideWorkspace(scope.root, target);
      printBlock("Tree", buildTreeLines(scope.root, target, 2).join("\n"));
      return;
    }
    case "/ls": {
      const scope = resolveScope(config.workspaceRoot, state.scopePath);
      const target = args[0] || ".";
      const listing = listDirectory(scope.root, target);
      printBlock(`Directory ${listing.path}`, listing.entries.map((entry) => {
        return `${entry.type === "directory" ? "[D]" : "[F]"} ${entry.path}`;
      }).join("\n"));
      return;
    }
    case "/open": {
      const scope = resolveScope(config.workspaceRoot, state.scopePath);
      const filePath = args[0];
      if (!filePath) {
        throw new Error("Usage: /open <path>");
      }
      const content = readFile(scope.root, filePath);
      printBlock(filePath, content);
      return;
    }
    case "/include": {
      const scope = resolveScope(config.workspaceRoot, state.scopePath);
      const filePath = args[0];
      if (!filePath) {
        throw new Error("Usage: /include <path>");
      }
      readFile(scope.root, filePath);
      state.selectedFiles.add(normalizeRelativePath(filePath));
      printBlock("Included", [...state.selectedFiles].join("\n"));
      return;
    }
    case "/exclude": {
      const filePath = args[0];
      if (!filePath) {
        throw new Error("Usage: /exclude <path>");
      }
      state.selectedFiles.delete(normalizeRelativePath(filePath));
      printBlock("Included", state.selectedFiles.size > 0 ? [...state.selectedFiles].join("\n") : "(none)");
      return;
    }
    case "/files":
      printBlock("Included", state.selectedFiles.size > 0 ? [...state.selectedFiles].join("\n") : "(none)");
      return;
    case "/write": {
      const scope = resolveScope(config.workspaceRoot, state.scopePath);
      const filePath = args[0];
      if (!filePath) {
        throw new Error("Usage: /write <path>");
      }
      const content = await readMultiline(rl, `Writing ${filePath}`, "write> ");
      writeFile(scope.root, filePath, content);
      printBlock("已保存", `${filePath} (${Buffer.byteLength(content, "utf8")} 字节)`);
      return;
    }
    case "/run": {
      const scope = resolveScope(config.workspaceRoot, state.scopePath);
      if (!rest) {
        throw new Error("Usage: /run <command>");
      }
      const shellCommand = rest.replace(/^\/run\s+/, "");
      const result = await runWorkspaceCommand(scope.root, shellCommand);
      state.recentCommandOutput = result.combined;
      printBlock(`命令执行结果 ${result.code}`, result.combined || "(无输出)");
      return;
    }
    case "/ops": {
      const scope = resolveScope(config.workspaceRoot, state.scopePath);
      const subcommand = (args[0] || "").toLowerCase();
      if (subcommand === "snapshot") {
        const snapshot = await collectOpsSnapshot(scope.root, {
          projectPath: ".",
          logSource: "pm2",
          lines: "80"
        });
        state.recentCommandOutput = snapshot.output;
        printBlock("运维快照", snapshot.output);
        return;
      }

      if (subcommand === "services") {
        const services = await listLocalServices(scope.root, {
          projectPath: "."
        });
        state.recentCommandOutput = services.output;
        printBlock("本机服务清单", services.output);
        return;
      }

      if (subcommand === "audit") {
        const audit = await runOpsAudit(scope.root, {
          projectPath: ".",
          logSource: "pm2",
          lines: "80"
        });
        state.recentCommandOutput = audit.output;
        printBlock("运维巡检", audit.output);
        return;
      }

      if (subcommand === "sync") {
        const syncResult = await syncProjectFromRemote(scope.root, {
          projectPath: ".",
          branch: args[1] || "",
          runtime: "pm2"
        });
        state.recentCommandOutput = syncResult.output;
        printBlock("远端同步更新", syncResult.output);
        return;
      }

      throw new Error("Usage: /ops <snapshot|services|audit|sync [branch]>");
    }
    case "/git": {
      const scope = resolveScope(config.workspaceRoot, state.scopePath);
      const subcommand = (args[0] || "").toLowerCase();
      const gitRest = rest.replace(/^\/git\s+/, "");

      if (!subcommand) {
        throw new Error("Usage: /git <status|commit|push>");
      }

      if (subcommand === "status") {
        const snapshot = await readGitSnapshot(scope.root);
        printBlock("Git 状态", [
          `仓库根目录: ${snapshot.repoRoot}`,
          `当前分支: ${snapshot.branch}`,
          "",
          "远端:",
          snapshot.remotesText,
          "",
          "工作区状态:",
          snapshot.statusText
        ].join("\n"));
        return;
      }

      if (subcommand === "commit") {
        const message = gitRest.replace(/^commit\s+/, "").trim();
        if (!message) {
          throw new Error("Usage: /git commit <message>");
        }

        const result = await commitAll(scope.root, message);
        if (!result.ok) {
          throw new Error(result.combined || "Git commit failed.");
        }

        const snapshot = await readGitSnapshot(scope.root);
        printBlock("Git 提交", [
          result.combined || "(commit completed)",
          "",
          `当前分支: ${snapshot.branch}`,
          snapshot.statusText
        ].join("\n"));
        return;
      }

      if (subcommand === "push") {
        const result = await pushCurrentBranch(scope.root);
        if (!result.ok) {
          throw new Error(result.combined || "Git push failed.");
        }

        const snapshot = await readGitSnapshot(scope.root);
        printBlock("Git 推送", [
          result.combined || "(push completed)",
          "",
          `当前分支: ${snapshot.branch}`,
          snapshot.statusText
        ].join("\n"));
        return;
      }

      throw new Error("Usage: /git <status|commit|push>");
    }
    case "/clearcmd":
      state.recentCommandOutput = "";
      printBlock("命令输出", "已清除。");
      return;
    case "/exit":
      throw new Error("__EXIT__");
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

async function sendCliChat(config, state, userInput) {
  if (await runAutonomousTurn(config, state, userInput)) {
    return;
  }

  const selectedFilePaths = [...state.selectedFiles];
  const contextBundle = buildContextBundle(config, state.scopePath, selectedFilePaths, state.recentCommandOutput);
  const skillBundle = buildSkillBundle(config, state.scopePath, state.selectedSkillIds);
  const promptPrefix = workflowPrompt(state.workflowId);
  const finalMessages = [
    { role: "system", content: config.systemPrompt },
    {
      role: "system",
      content: [
        "默认使用中文回答。",
        "如果用户问的是能力清单、你能做什么、怎么用、能不能当运维助手这类简单问题，默认短答。",
        "控制在 3 到 6 行内。",
        "除非用户明确要求，否则不要输出代码、JSON、配置片段或长篇方案。"
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
    ...state.messages,
    { role: "user", content: userInput }
  ];

  stdout.write("\n[Assistant]\n");

  let streamedAny = false;
  const content = await sendChatStream(config, state.profileId, finalMessages, {
    onToken(token) {
      if (token) {
        streamedAny = true;
        stdout.write(token);
      }
    }
  });

  if (!streamedAny) {
    stdout.write(content || "(empty)");
  }

  stdout.write("\n");
  state.messages.push({ role: "user", content: userInput });
  state.messages.push({ role: "assistant", content });
}

async function main() {
  const config = loadConfig();
  const resolvedWorkspace = assertInsideWorkspace(config.workspaceRoot, ".");
  const state = {
    profileId: config.activeProfileId,
    workflowId: "analyze",
    scopePath: ".",
    selectedSkillIds: new Set(),
    selectedFiles: new Set(),
    recentCommandOutput: "",
    messages: []
  };

  const rl = readline.createInterface({
    input: stdin,
    output: stdout,
    terminal: true
  });

  printBlock("KingCode CLI", [
    `工作区根目录: ${relativeLabel(resolvedWorkspace, resolvedWorkspace)} (${resolvedWorkspace})`,
    `当前范围: . (${resolvedWorkspace})`,
    `当前模型: ${state.profileId}`,
    `当前工作流: ${state.workflowId}`,
    "输入 /help 查看命令。"
  ].join("\n"));

  try {
    while (true) {
      const line = (await rl.question(getPrompt(state))).trim();
      if (!line) {
        continue;
      }

      try {
        if (line.startsWith("/")) {
          await handleSlashCommand(rl, config, state, line);
        } else {
          await sendCliChat(config, state, line);
        }
      } catch (error) {
        if (error.message === "__EXIT__") {
          break;
        }
        printBlock("Error", error.message || "Command failed.");
      }
    }
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  stderr.write(`${error.message || error}\n`);
  process.exitCode = 1;
});
