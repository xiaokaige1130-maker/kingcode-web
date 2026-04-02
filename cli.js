#!/usr/bin/env node
const path = require("path");
const readline = require("readline/promises");
const { exec } = require("child_process");
const { stdin, stdout, stderr } = require("process");

const { loadConfig } = require("./lib/config");
const { commitAll, pushCurrentBranch, readGitSnapshot } = require("./lib/git");
const { sendChatStream } = require("./lib/providers");
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

const WORKFLOWS = new Set(["analyze", "plan", "review", "implement"]);

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

function buildScopedConfig(config, scopePath) {
  const scope = resolveScope(config.workspaceRoot, scopePath);
  return {
    ...config,
    workspaceRoot: scope.root
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

function printBlock(title, content) {
  stdout.write(`\n[${title}]\n`);
  stdout.write(`${content || "(empty)"}\n`);
}

function printHelp() {
  printBlock("Commands", [
    "/help                     Show this help",
    "/status                   Show current profile, workflow, workspace, and selected files",
    "/profiles                 List configured model profiles",
    "/profile <id>             Switch active profile for this session",
    "/workflows                List workflows",
    "/workflow <id>            Set workflow: analyze | plan | review | implement",
    "/scope [path]             Show or set the active scope within the workspace root",
    "/skills                   List discovered skills",
    "/skillinfo <id>           Show one skill's details and content",
    "/skill <id>               Enable a skill for chat context",
    "/unskill <id>             Disable a skill",
    "/tree [path]              Show a shallow directory tree",
    "/ls [path]                List a single directory",
    "/open <path>              Print a file",
    "/include <path>           Include a file in chat context",
    "/exclude <path>           Remove a file from chat context",
    "/files                    List included files",
    "/write <path>             Write a file from multiline input, finish with .end",
    "/run <command>            Run a shell command inside the workspace",
    "/git status               Show Git branch, remotes, and working tree status",
    "/git commit <message>     Stage all repo changes and create a commit",
    "/git push                 Push the current branch using existing upstream",
    "/clearcmd                 Clear saved command output from chat context",
    "/exit                     Quit"
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
      printBlock("Status", [
        `Workspace Root: ${config.workspaceRoot}`,
        `Scope Path: ${scope.path}`,
        `Scope Root: ${scope.root}`,
        `Profile: ${state.profileId}`,
        `Workflow: ${state.workflowId}`,
        `Included files: ${state.selectedFiles.size > 0 ? [...state.selectedFiles].join(", ") : "(none)"}`,
        `Saved command output: ${state.recentCommandOutput ? "yes" : "no"}`
      ].join("\n"));
      return;
    }
    case "/profiles":
      printBlock("Profiles", config.profiles.map((profile) => {
        const marker = profile.id === state.profileId ? "*" : " ";
        return `${marker} ${profile.id} -> ${profile.name} (${profile.type})`;
      }).join("\n"));
      return;
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
      printBlock("Profile", `Switched to ${match.name} (${match.id})`);
      return;
    }
    case "/workflows":
      printBlock("Workflows", [...WORKFLOWS].join("\n"));
      return;
    case "/workflow": {
      const nextWorkflow = args[0];
      if (!WORKFLOWS.has(nextWorkflow)) {
        throw new Error("Usage: /workflow <analyze|plan|review|implement>");
      }
      state.workflowId = nextWorkflow;
      printBlock("Workflow", `Switched to ${nextWorkflow}`);
      return;
    }
    case "/scope": {
      if (!rest) {
        const scope = resolveScope(config.workspaceRoot, state.scopePath);
        printBlock("Scope", [
          `Workspace Root: ${config.workspaceRoot}`,
          `Scope Path: ${scope.path}`,
          `Scope Root: ${scope.root}`
        ].join("\n"));
        return;
      }

      const scope = resolveScope(config.workspaceRoot, rest);
      state.scopePath = scope.path;
      state.selectedFiles.clear();
      state.recentCommandOutput = "";
      state.messages = [];
      syncScopeSkills(config, state);
      printBlock("Scope", [
        `Scope Path: ${scope.path}`,
        `Scope Root: ${scope.root}`,
        "Cleared included files, saved command output, and chat history for the new scope."
      ].join("\n"));
      return;
    }
    case "/skills": {
      const skills = listSkills(buildScopedConfig(config, state.scopePath));
      printBlock("Skills", skills.length > 0 ? skills.map((skill) => {
        const marker = state.selectedSkillIds.has(skill.id) ? "*" : " ";
        const suffix = skill.description ? ` - ${skill.description}` : "";
        return `${marker} ${skill.id}${suffix}`;
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
      printBlock("Saved", `${filePath} (${Buffer.byteLength(content, "utf8")} bytes)`);
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
      printBlock(`Command exit ${result.code}`, result.combined || "(no output)");
      return;
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
        printBlock("Git Status", [
          `Repo Root: ${snapshot.repoRoot}`,
          `Branch: ${snapshot.branch}`,
          "",
          "Remotes:",
          snapshot.remotesText,
          "",
          "Status:",
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
        printBlock("Git Commit", [
          result.combined || "(commit completed)",
          "",
          `Branch: ${snapshot.branch}`,
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
        printBlock("Git Push", [
          result.combined || "(push completed)",
          "",
          `Branch: ${snapshot.branch}`,
          snapshot.statusText
        ].join("\n"));
        return;
      }

      throw new Error("Usage: /git <status|commit|push>");
    }
    case "/clearcmd":
      state.recentCommandOutput = "";
      printBlock("Command Output", "Cleared.");
      return;
    case "/exit":
      throw new Error("__EXIT__");
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

async function sendCliChat(config, state, userInput) {
  const selectedFilePaths = [...state.selectedFiles];
  const contextBundle = buildContextBundle(config, state.scopePath, selectedFilePaths, state.recentCommandOutput);
  const skillBundle = buildSkillBundle(config, state.scopePath, state.selectedSkillIds);
  const promptPrefix = workflowPrompt(state.workflowId);
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
    `Workspace Root: ${relativeLabel(resolvedWorkspace, resolvedWorkspace)} (${resolvedWorkspace})`,
    `Scope: . (${resolvedWorkspace})`,
    `Profile: ${state.profileId}`,
    `Workflow: ${state.workflowId}`,
    "Type /help for commands."
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
