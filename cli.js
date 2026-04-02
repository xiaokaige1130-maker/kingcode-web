const path = require("path");
const readline = require("readline/promises");
const { exec } = require("child_process");
const { stdin, stdout, stderr } = require("process");

const { loadConfig } = require("./lib/config");
const { sendChat } = require("./lib/providers");
const {
  assertInsideWorkspace,
  buildTreeLines,
  collectFiles,
  listDirectory,
  readFile,
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
    "/tree [path]              Show a shallow directory tree",
    "/ls [path]                List a single directory",
    "/open <path>              Print a file",
    "/include <path>           Include a file in chat context",
    "/exclude <path>           Remove a file from chat context",
    "/files                    List included files",
    "/write <path>             Write a file from multiline input, finish with .end",
    "/run <command>            Run a shell command inside the workspace",
    "/clearcmd                 Clear saved command output from chat context",
    "/exit                     Quit"
  ].join("\n"));
}

function getPrompt(state) {
  return `kingcode:${state.workflowId}:${state.profileId}> `;
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
    case "/status":
      printBlock("Status", [
        `Workspace: ${config.workspaceRoot}`,
        `Profile: ${state.profileId}`,
        `Workflow: ${state.workflowId}`,
        `Included files: ${state.selectedFiles.size > 0 ? [...state.selectedFiles].join(", ") : "(none)"}`,
        `Saved command output: ${state.recentCommandOutput ? "yes" : "no"}`
      ].join("\n"));
      return;
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
    case "/tree": {
      const target = args[0] || ".";
      assertInsideWorkspace(config.workspaceRoot, target);
      printBlock("Tree", buildTreeLines(config.workspaceRoot, target, 2).join("\n"));
      return;
    }
    case "/ls": {
      const target = args[0] || ".";
      const listing = listDirectory(config.workspaceRoot, target);
      printBlock(`Directory ${listing.path}`, listing.entries.map((entry) => {
        return `${entry.type === "directory" ? "[D]" : "[F]"} ${entry.path}`;
      }).join("\n"));
      return;
    }
    case "/open": {
      const filePath = args[0];
      if (!filePath) {
        throw new Error("Usage: /open <path>");
      }
      const content = readFile(config.workspaceRoot, filePath);
      printBlock(filePath, content);
      return;
    }
    case "/include": {
      const filePath = args[0];
      if (!filePath) {
        throw new Error("Usage: /include <path>");
      }
      readFile(config.workspaceRoot, filePath);
      state.selectedFiles.add(filePath.replace(/\\/g, "/"));
      printBlock("Included", [...state.selectedFiles].join("\n"));
      return;
    }
    case "/exclude": {
      const filePath = args[0];
      if (!filePath) {
        throw new Error("Usage: /exclude <path>");
      }
      state.selectedFiles.delete(filePath.replace(/\\/g, "/"));
      printBlock("Included", state.selectedFiles.size > 0 ? [...state.selectedFiles].join("\n") : "(none)");
      return;
    }
    case "/files":
      printBlock("Included", state.selectedFiles.size > 0 ? [...state.selectedFiles].join("\n") : "(none)");
      return;
    case "/write": {
      const filePath = args[0];
      if (!filePath) {
        throw new Error("Usage: /write <path>");
      }
      const content = await readMultiline(rl, `Writing ${filePath}`, "write> ");
      writeFile(config.workspaceRoot, filePath, content);
      printBlock("Saved", `${filePath} (${Buffer.byteLength(content, "utf8")} bytes)`);
      return;
    }
    case "/run": {
      if (!rest) {
        throw new Error("Usage: /run <command>");
      }
      const shellCommand = rest.replace(/^\/run\s+/, "");
      const result = await runWorkspaceCommand(config.workspaceRoot, shellCommand);
      state.recentCommandOutput = result.combined;
      printBlock(`Command exit ${result.code}`, result.combined || "(no output)");
      return;
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
  const contextBundle = buildContextBundle(config, selectedFilePaths, state.recentCommandOutput);
  const promptPrefix = workflowPrompt(state.workflowId);
  const finalMessages = [
    { role: "system", content: config.systemPrompt },
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

  const content = await sendChat(config, state.profileId, finalMessages);
  state.messages.push({ role: "user", content: userInput });
  state.messages.push({ role: "assistant", content });
  printBlock("Assistant", content);
}

async function main() {
  const config = loadConfig();
  const resolvedWorkspace = assertInsideWorkspace(config.workspaceRoot, ".");
  const state = {
    profileId: config.activeProfileId,
    workflowId: "analyze",
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
    `Workspace: ${relativeLabel(resolvedWorkspace, resolvedWorkspace)} (${resolvedWorkspace})`,
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
