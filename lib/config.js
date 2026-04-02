const fs = require("fs");
const os = require("os");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const CONFIG_FILE = path.join(DATA_DIR, "providers.json");

const DEFAULT_SYSTEM_PROMPT = [
  "You are OmniCode, a pragmatic coding assistant.",
  "Work like a senior engineer: analyze first, explain tradeoffs briefly, and produce concrete next steps.",
  "Prefer minimal, correct changes over broad rewrites.",
  "When file context is provided, ground your answer in those files.",
  "If the user asks for implementation help, provide executable code or precise edits.",
  "Do not overstate built-in product capabilities.",
  "Distinguish between what exists in the current repository and what the assistant natively supports.",
  "If a repository contains folders like plugins, skills, hooks, workflows, or devcontainer config, describe them as repository contents unless the codebase clearly implements runtime support for them.",
  "Do not claim native integrations, automation features, or platform support unless you can ground that claim in the current project files.",
].join(" ");

function defaultConfig() {
  return {
    workspaceRoot: path.join(os.homedir(), "Downloads", "claude-code"),
    activeProfileId: "openai-compatible",
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
      profiles: Array.isArray(parsed.profiles) && parsed.profiles.length > 0 ? parsed.profiles : base.profiles
    };
  } catch (error) {
    return base;
  }
}

function saveConfig(nextConfig) {
  ensureConfigFile();
  const normalized = {
    ...defaultConfig(),
    ...nextConfig,
    profiles: Array.isArray(nextConfig.profiles) ? nextConfig.profiles : defaultConfig().profiles
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(normalized, null, 2), "utf8");
  return normalized;
}

module.exports = {
  CONFIG_FILE,
  DEFAULT_SYSTEM_PROMPT,
  loadConfig,
  saveConfig
};
