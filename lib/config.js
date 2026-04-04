const fs = require("fs");
const os = require("os");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const CONFIG_FILE = path.join(DATA_DIR, "providers.json");

const LEGACY_DEFAULT_SYSTEM_PROMPT = [
  "You are OmniCode, a pragmatic coding assistant.",
  "Work like a senior engineer: analyze first, explain tradeoffs briefly, and produce concrete next steps.",
  "Prefer minimal, correct changes over broad rewrites.",
  "When file context is provided, ground your answer in those files.",
  "If the user asks for implementation help, provide executable code or precise edits.",
  "Do not overstate built-in product capabilities.",
  "Distinguish between what exists in the current repository and what the assistant natively supports.",
  "If a repository contains folders like plugins, skills, hooks, workflows, or devcontainer config, describe them as repository contents unless the codebase clearly implements runtime support for them.",
  "Do not claim native integrations, automation features, or platform support unless you can ground that claim in the current project files.",
  "Do not describe a repository as a platform, product, or fully supported feature set unless the current project explicitly implements those runtime capabilities.",
  "When uncertain, say that the repository appears to contain related files or configuration, rather than claiming end-to-end support.",
].join(" ");

const DEFAULT_SYSTEM_PROMPT = LEGACY_DEFAULT_SYSTEM_PROMPT.replace("You are OmniCode", "You are KingCode");

function normalizeSystemPrompt(systemPrompt) {
  const prompt = typeof systemPrompt === "string" && systemPrompt.trim()
    ? systemPrompt
    : DEFAULT_SYSTEM_PROMPT;

  if (prompt === LEGACY_DEFAULT_SYSTEM_PROMPT) {
    return DEFAULT_SYSTEM_PROMPT;
  }

  return prompt.replace(/^You are OmniCode\b/, "You are KingCode");
}

function defaultConfig() {
  return {
    workspaceRoot: path.join(os.homedir(), "Desktop", "omnicode-web"),
    activeProfileId: "openai-compatible",
    listenHost: "0.0.0.0",
    listenPort: 4780,
    allowPublicAccess: true,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    profiles: [
      {
        id: "openai-compatible",
        name: "OpenAI Compatible",
        type: "openai-compatible",
        baseUrl: "https://api.openai.com",
        path: "/v1/chat/completions",
        model: "gpt-4.1-mini",
        apiKey: "",
        method: "POST",
        headersTemplate: "{}",
        bodyTemplate: ""
      },
      {
        id: "anthropic",
        name: "Anthropic",
        type: "anthropic",
        baseUrl: "https://api.anthropic.com",
        path: "/v1/messages",
        model: "claude-3-7-sonnet-latest",
        apiKey: "",
        method: "POST",
        headersTemplate: "{}",
        bodyTemplate: ""
      },
      {
        id: "gemini",
        name: "Google Gemini",
        type: "gemini",
        baseUrl: "https://generativelanguage.googleapis.com",
        path: "/v1beta/models/{model}:generateContent",
        model: "gemini-2.5-pro",
        apiKey: "",
        method: "POST",
        headersTemplate: "{}",
        bodyTemplate: ""
      },
      {
        id: "deepseek",
        name: "DeepSeek",
        type: "openai-compatible",
        baseUrl: "https://api.deepseek.com",
        path: "/v1/chat/completions",
        model: "deepseek-chat",
        apiKey: "",
        method: "POST",
        headersTemplate: "{}",
        bodyTemplate: ""
      },
      {
        id: "generic-json",
        name: "Generic JSON API",
        type: "generic-json",
        baseUrl: "https://example.com",
        path: "/v1/chat",
        model: "your-model-name",
        apiKey: "",
        method: "POST",
        headersTemplate: "{\n  \"Authorization\": \"Bearer {{api_key}}\",\n  \"Content-Type\": \"application/json\"\n}",
        bodyTemplate: "{\n  \"model\": {{model_json}},\n  \"messages\": {{messages_json}}\n}",
        responsePath: "choices.0.message.content"
      }
    ]
  };
}

function ensureConfigFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaultConfig(), null, 2), "utf8");
  }
}

function loadConfig() {
  ensureConfigFile();
  const base = defaultConfig();

  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      ...base,
      ...parsed,
      systemPrompt: normalizeSystemPrompt(parsed.systemPrompt),
      allowPublicAccess: typeof parsed.allowPublicAccess === "boolean"
        ? parsed.allowPublicAccess
        : (parsed.listenHost ? parsed.listenHost !== "127.0.0.1" : base.allowPublicAccess),
      listenHost: typeof parsed.listenHost === "string" && parsed.listenHost.trim()
        ? parsed.listenHost.trim()
        : (parsed.allowPublicAccess === false ? "127.0.0.1" : base.listenHost),
      listenPort: Number(parsed.listenPort) || base.listenPort,
      profiles: Array.isArray(parsed.profiles) && parsed.profiles.length > 0 ? parsed.profiles : base.profiles
    };
  } catch (error) {
    return base;
  }
}

function saveConfig(nextConfig) {
  ensureConfigFile();
  const allowPublicAccess = typeof nextConfig.allowPublicAccess === "boolean"
    ? nextConfig.allowPublicAccess
    : true;
  const normalized = {
    ...defaultConfig(),
    ...nextConfig,
    allowPublicAccess,
    listenHost: allowPublicAccess ? "0.0.0.0" : "127.0.0.1",
    listenPort: Number(nextConfig.listenPort) || defaultConfig().listenPort,
    systemPrompt: normalizeSystemPrompt(nextConfig.systemPrompt),
    profiles: Array.isArray(nextConfig.profiles) ? nextConfig.profiles : defaultConfig().profiles
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(normalized, null, 2), "utf8");
  return normalized;
}

module.exports = {
  CONFIG_FILE,
  DEFAULT_SYSTEM_PROMPT,
  LEGACY_DEFAULT_SYSTEM_PROMPT,
  loadConfig,
  normalizeSystemPrompt,
  saveConfig
};
