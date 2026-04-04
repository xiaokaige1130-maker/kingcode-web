const state = {
  config: null,
  auth: null,
  bootstrapped: false,
  scopePath: ".",
  currentPath: ".",
  currentFilePath: "",
  availableSkills: [],
  selectedSkillIds: new Set(),
  selectedFiles: new Set(),
  messages: [],
  workflowId: "analyze",
  recentCommandOutput: ""
};

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

const els = {
  authGate: document.querySelector("#auth-gate"),
  authMessage: document.querySelector("#auth-message"),
  loginForm: document.querySelector("#login-form"),
  loginUsername: document.querySelector("#login-username"),
  loginPassword: document.querySelector("#login-password"),
  changePasswordForm: document.querySelector("#change-password-form"),
  currentPassword: document.querySelector("#current-password"),
  newPassword: document.querySelector("#new-password"),
  profileSelect: document.querySelector("#profile-select"),
  profileName: document.querySelector("#profile-name"),
  profileType: document.querySelector("#profile-type"),
  profileBaseUrl: document.querySelector("#profile-base-url"),
  profilePath: document.querySelector("#profile-path"),
  profileModel: document.querySelector("#profile-model"),
  profileApiKey: document.querySelector("#profile-api-key"),
  allowPublicAccess: document.querySelector("#allow-public-access"),
  listenPort: document.querySelector("#listen-port"),
  accessSummary: document.querySelector("#access-summary"),
  profileHeaders: document.querySelector("#profile-headers"),
  profileBody: document.querySelector("#profile-body"),
  profileResponsePath: document.querySelector("#profile-response-path"),
  workspaceRoot: document.querySelector("#workspace-root"),
  scopePath: document.querySelector("#scope-path"),
  scopeSummary: document.querySelector("#scope-summary"),
  workflowLabel: document.querySelector("#workflow-label"),
  activeProfileLabel: document.querySelector("#active-profile-label"),
  systemPrompt: document.querySelector("#system-prompt"),
  treePath: document.querySelector("#tree-path"),
  fileTree: document.querySelector("#file-tree"),
  skillsList: document.querySelector("#skills-list"),
  capabilitiesSummary: document.querySelector("#capabilities-summary"),
  capabilitiesOutput: document.querySelector("#capabilities-output"),
  authStatus: document.querySelector("#auth-status"),
  messages: document.querySelector("#messages"),
  messageInput: document.querySelector("#message-input"),
  chatForm: document.querySelector("#chat-form"),
  editorPath: document.querySelector("#editor-path"),
  includeFile: document.querySelector("#include-file"),
  fileEditor: document.querySelector("#file-editor"),
  commandInput: document.querySelector("#command-input"),
  commandOutput: document.querySelector("#command-output"),
  gitSummary: document.querySelector("#git-summary"),
  gitStatusOutput: document.querySelector("#git-status-output"),
  gitCommitMessage: document.querySelector("#git-commit-message"),
  deployPreset: document.querySelector("#deploy-preset"),
  deployApplyPreset: document.querySelector("#deploy-apply-preset"),
  deployRepoUrl: document.querySelector("#deploy-repo-url"),
  deployTargetPath: document.querySelector("#deploy-target-path"),
  deployBranch: document.querySelector("#deploy-branch"),
  deployProjectPath: document.querySelector("#deploy-project-path"),
  deployInstallCommand: document.querySelector("#deploy-install-command"),
  deployBuildCommand: document.querySelector("#deploy-build-command"),
  deployServiceName: document.querySelector("#deploy-service-name"),
  deployServiceMode: document.querySelector("#deploy-service-mode"),
  deployServiceTarget: document.querySelector("#deploy-service-target"),
  deployLogSource: document.querySelector("#deploy-log-source"),
  deployLogLines: document.querySelector("#deploy-log-lines"),
  deployHealthUrl: document.querySelector("#deploy-health-url"),
  deployRollbackCommit: document.querySelector("#deploy-rollback-commit"),
  deployComposeAction: document.querySelector("#deploy-compose-action"),
  deploySummary: document.querySelector("#deploy-summary"),
  deployOutput: document.querySelector("#deploy-output"),
  messageTemplate: document.querySelector("#message-template"),
  saveConfig: document.querySelector("#save-config"),
  savePassword: document.querySelector("#save-password"),
  logout: document.querySelector("#logout"),
  settingsCurrentPassword: document.querySelector("#settings-current-password"),
  settingsNewPassword: document.querySelector("#settings-new-password"),
  deleteProfile: document.querySelector("#delete-profile"),
  newProfile: document.querySelector("#new-profile"),
  applyScope: document.querySelector("#apply-scope"),
  resetScope: document.querySelector("#reset-scope"),
  refreshTree: document.querySelector("#refresh-tree"),
  refreshSkills: document.querySelector("#refresh-skills"),
  refreshCapabilities: document.querySelector("#refresh-capabilities"),
  saveFile: document.querySelector("#save-file"),
  runCommand: document.querySelector("#run-command"),
  refreshGit: document.querySelector("#refresh-git"),
  gitCommit: document.querySelector("#git-commit"),
  gitPush: document.querySelector("#git-push"),
  deployStatus: document.querySelector("#deploy-status"),
  deployClone: document.querySelector("#deploy-clone"),
  deployInstall: document.querySelector("#deploy-install"),
  deployService: document.querySelector("#deploy-service"),
  deploySystemd: document.querySelector("#deploy-systemd"),
  deployLogs: document.querySelector("#deploy-logs"),
  deployHealth: document.querySelector("#deploy-health"),
  deployHistory: document.querySelector("#deploy-history"),
  deployCommits: document.querySelector("#deploy-commits"),
  deployServices: document.querySelector("#deploy-services"),
  deployAudit: document.querySelector("#deploy-audit"),
  deploySync: document.querySelector("#deploy-sync"),
  deployOpsSnapshot: document.querySelector("#deploy-ops-snapshot"),
  deployRollback: document.querySelector("#deploy-rollback"),
  deployCompose: document.querySelector("#deploy-compose"),
  deployUpdate: document.querySelector("#deploy-update"),
  toolTabs: [...document.querySelectorAll(".tool-tab")],
  toolPanels: [...document.querySelectorAll(".tool-panel")]
};

async function request(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json"
    },
    ...options
  });

  const payload = await response.json();
  if (!response.ok) {
    if (response.status === 401) {
      state.auth = { authenticated: false };
      showAuthGate("登录已失效，请重新登录。");
    }
    throw new Error(payload.error || "Request failed.");
  }
  return payload;
}

function showAuthGate(message = "") {
  els.authGate.classList.remove("hidden");
  els.authMessage.textContent = message;
}

function hideAuthGate() {
  els.authGate.classList.add("hidden");
  els.authMessage.textContent = "";
}

function renderAuthState() {
  const username = state.auth?.username || "kingcode";
  const mustChangePassword = Boolean(state.auth?.mustChangePassword);
  els.authStatus.textContent = mustChangePassword
    ? `当前账号：${username}（首次登录后请修改密码）`
    : `当前账号：${username}`;
  els.changePasswordForm.classList.toggle("hidden", !mustChangePassword);
  els.loginForm.classList.toggle("hidden", Boolean(state.auth?.authenticated && mustChangePassword));
}

function renderAccessSettings() {
  const allowPublicAccess = Boolean(state.config?.allowPublicAccess);
  const listenHost = allowPublicAccess ? "0.0.0.0" : "127.0.0.1";
  const listenPort = Number(state.config?.listenPort) || 4780;
  els.allowPublicAccess.value = String(allowPublicAccess);
  els.listenPort.value = String(listenPort);
  els.accessSummary.textContent = `当前监听：${listenHost}:${listenPort}`;
}

function activeProfile() {
  return state.config.profiles.find((profile) => profile.id === state.config.activeProfileId);
}

function scopeQuery(relativePath = ".") {
  return `path=${encodeURIComponent(relativePath)}&scopePath=${encodeURIComponent(state.scopePath || ".")}`;
}

function renderScopeSummary(scopeRoot = "") {
  const scopePath = state.scopePath || ".";
  els.scopePath.value = scopePath;
  els.scopeSummary.textContent = scopeRoot
    ? `作用范围：${scopePath} (${scopeRoot})`
    : `作用范围：${scopePath}`;
}

function renderGitStatus(data) {
  state.recentCommandOutput = [
    "Remotes:",
    data.remotesText || "(no remotes)",
    "",
    "Status:",
    data.statusText || "Working tree clean."
  ].join("\n");
  els.gitSummary.textContent = `Git: ${data.branch} (${data.repoRoot})`;
  els.gitStatusOutput.textContent = [
    "Remotes:",
    data.remotesText || "(no remotes)",
    "",
    "Status:",
    data.statusText || "Working tree clean."
  ].join("\n");
}

function renderHeaderMeta() {
  const profile = activeProfile();
  els.activeProfileLabel.textContent = profile ? profile.name || profile.id : "-";
  els.workflowLabel.textContent = state.workflowId;
}

function renderDeployResult(data) {
  const location = data.projectPath || ".";
  const root = data.projectRoot || "";
  if (data.output) {
    state.recentCommandOutput = data.output;
  }
  els.deploySummary.textContent = root
    ? `部署目标：${location} (${root})`
    : `部署目标：${location}`;
  els.deployOutput.textContent = data.output || "(no output)";
}

function applyDeployPreset() {
  const preset = els.deployPreset.value;

  if (preset === "python-bot") {
    els.deployInstallCommand.value = "pip install -r requirements.txt";
    els.deployBuildCommand.value = "";
    els.deployServiceMode.value = "python-script";
    if (!els.deployServiceTarget.value.trim()) {
      els.deployServiceTarget.value = "main.py";
    }
    els.deployLogSource.value = "pm2";
    if (!els.deployHealthUrl.value.trim()) {
      els.deployHealthUrl.value = "http://127.0.0.1:8000/health";
    }
    return;
  }

  if (preset === "docker-compose") {
    els.deployInstallCommand.value = "";
    els.deployBuildCommand.value = "";
    els.deployServiceMode.value = "node-script";
    els.deployServiceTarget.value = "";
    els.deployLogSource.value = "docker-compose";
    if (!els.deployHealthUrl.value.trim()) {
      els.deployHealthUrl.value = "http://127.0.0.1:3000";
    }
    return;
  }

  els.deployInstallCommand.value = "npm install";
  els.deployBuildCommand.value = "npm run build";
  els.deployServiceMode.value = "npm-start";
  if (!els.deployServiceTarget.value.trim()) {
    els.deployServiceTarget.value = "";
  }
  els.deployLogSource.value = "pm2";
  if (!els.deployHealthUrl.value.trim()) {
    els.deployHealthUrl.value = "http://127.0.0.1:4780/api/health";
  }
}

function renderProfileOptions() {
  els.profileSelect.innerHTML = "";
  state.config.profiles.forEach((profile) => {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = profile.name;
    if (profile.id === state.config.activeProfileId) {
      option.selected = true;
    }
    els.profileSelect.append(option);
  });
}

function renderProfileForm() {
  const profile = activeProfile();
  if (!profile) {
    return;
  }

  els.profileName.value = profile.name || "";
  els.profileType.value = profile.type || "openai-compatible";
  els.profileBaseUrl.value = profile.baseUrl || "";
  els.profilePath.value = profile.path || "";
  els.profileModel.value = profile.model || "";
  els.profileApiKey.value = profile.apiKey || "";
  els.profileHeaders.value = profile.headersTemplate || "{}";
  els.profileBody.value = profile.bodyTemplate || "";
  els.profileResponsePath.value = profile.responsePath || "";
  renderAccessSettings();
  renderAuthState();
  renderHeaderMeta();
}

function syncActiveProfileFromForm() {
  const profile = activeProfile();
  if (!profile) {
    return;
  }

  profile.name = els.profileName.value.trim() || profile.id;
  profile.type = els.profileType.value;
  profile.baseUrl = els.profileBaseUrl.value.trim();
  profile.path = els.profilePath.value.trim();
  profile.model = els.profileModel.value.trim();
  profile.apiKey = els.profileApiKey.value.trim();
  profile.headersTemplate = els.profileHeaders.value;
  profile.bodyTemplate = els.profileBody.value;
  profile.responsePath = els.profileResponsePath.value.trim();
}

function renderMessages() {
  els.messages.innerHTML = "";

  state.messages.forEach((message) => {
    const node = els.messageTemplate.content.firstElementChild.cloneNode(true);
    node.classList.add(message.role);
    const roleMap = {
      user: "YOU",
      assistant: "KINGCODE",
      system: "SYSTEM"
    };
    node.querySelector(".message-role").textContent = roleMap[message.role] || message.role;
    node.querySelector(".message-body").textContent = message.content;
    els.messages.append(node);
  });

  els.messages.scrollTop = els.messages.scrollHeight;
}

function activateToolPanel(panelId) {
  els.toolTabs.forEach((button) => {
    button.classList.toggle("active", button.dataset.panel === panelId);
  });
  els.toolPanels.forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.panel === panelId);
  });
}

function addMessage(role, content) {
  state.messages.push({ role, content });
  renderMessages();
}

async function submitChatFallback(payload) {
  const data = await request("/api/chat", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  renderScopeSummary(data.scopeRoot || "");
  addMessage("assistant", data.content);
}

function renderSkills() {
  els.skillsList.innerHTML = "";

  if (!Array.isArray(state.availableSkills) || state.availableSkills.length === 0) {
    const empty = document.createElement("div");
    empty.className = "hint";
    empty.textContent = "未发现技能包。";
    els.skillsList.append(empty);
    return;
  }

  state.availableSkills.forEach((skill) => {
    const row = document.createElement("label");
    row.className = "skill-row";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.selectedSkillIds.has(skill.id);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        state.selectedSkillIds.add(skill.id);
      } else {
        state.selectedSkillIds.delete(skill.id);
      }
    });

    const meta = document.createElement("div");
    meta.className = "skill-meta";

    const title = document.createElement("div");
    title.className = "skill-title";
    title.textContent = SKILL_LABELS[skill.name] || skill.name || skill.id;

    const source = document.createElement("div");
    source.className = "skill-source";
    source.textContent = `来源：${SKILL_SOURCE_LABELS[skill.sourceType] || skill.sourceType}`;

    const desc = document.createElement("div");
    desc.className = "skill-desc";
    desc.textContent = skill.description || "No description.";

    meta.append(title, source, desc);
    row.append(checkbox, meta);
    els.skillsList.append(row);
  });
}

function renderCapabilities(data) {
  els.capabilitiesSummary.textContent = data.summary || "当前能力清单。";
  els.capabilitiesOutput.textContent = [
    "工作流：",
    ...(data.workflows || []).map((item) => `- ${item.label}: ${item.purpose}`),
    "",
    "工具能力：",
    ...(data.tools || []).map((item) => `- ${item}`),
    "",
    "范围规则：",
    ...(data.scopeRules || []).map((item) => `- ${item}`),
    "",
    "访问方式：",
    `- 公网访问：${data.access?.allowPublicAccess ? "开启" : "关闭"}`,
    `- 监听地址：${data.access?.listenHost || "-"}`,
    `- 监听端口：${data.access?.listenPort || "-"}`,
    "",
    "限制说明：",
    ...(data.limits || []).map((item) => `- ${item}`)
  ].join("\n");
}

function normalizePath(inputPath) {
  return inputPath.replace(/\\/g, "/");
}

function resetScopeSessionState() {
  state.currentPath = ".";
  state.currentFilePath = "";
  state.selectedFiles.clear();
  state.messages = [];
  state.recentCommandOutput = "";
  els.editorPath.textContent = "未选择文件";
  els.fileEditor.value = "";
  els.commandOutput.textContent = "";
  els.gitSummary.textContent = "Git status has not been loaded yet.";
  els.gitStatusOutput.textContent = "";
  els.deploySummary.textContent = "Deploy actions run inside the active workspace scope.";
  els.deployOutput.textContent = "";
  syncIncludeCheckbox();
  renderMessages();
}

function renderTree(data) {
  state.currentPath = data.path;
  els.treePath.textContent = data.path;
  els.fileTree.innerHTML = "";

  if (data.path !== ".") {
    const up = document.createElement("button");
    up.className = "tree-entry directory";
    up.textContent = "..";
    up.addEventListener("click", () => {
      const parent = data.path.split("/").slice(0, -1).join("/") || ".";
      loadTree(parent);
    });
    els.fileTree.append(up);
  }

  data.entries.forEach((entry) => {
    const row = document.createElement("div");
    row.className = "tree-row";

    const main = document.createElement("button");
    main.className = `tree-entry ${entry.type}`;
    main.textContent = entry.name;
    main.addEventListener("click", () => {
      if (entry.type === "directory") {
        loadTree(entry.path);
      } else {
        openFile(entry.path);
      }
    });

    row.append(main);

    if (entry.type === "file") {
      const toggle = document.createElement("button");
      toggle.className = "tiny-toggle";
      toggle.textContent = state.selectedFiles.has(entry.path) ? "Context On" : "Context Off";
      toggle.addEventListener("click", () => {
        if (state.selectedFiles.has(entry.path)) {
          state.selectedFiles.delete(entry.path);
        } else {
          state.selectedFiles.add(entry.path);
        }
        renderTree(data);
        syncIncludeCheckbox();
      });
      row.append(toggle);
    }

    els.fileTree.append(row);
  });
}

async function loadTree(relativePath = ".") {
  const data = await request(`/api/workspace/tree?${scopeQuery(relativePath)}`);
  state.scopePath = data.scopePath || state.scopePath;
  renderScopeSummary(data.scopeRoot || "");
  renderTree(data);
}

async function loadSkills() {
  const data = await request(`/api/skills?scopePath=${encodeURIComponent(state.scopePath || ".")}`);
  state.scopePath = data.scopePath || state.scopePath;
  renderScopeSummary(data.scopeRoot || "");
  state.availableSkills = Array.isArray(data.skills) ? data.skills : [];
  state.selectedSkillIds.forEach((skillId) => {
    if (!state.availableSkills.some((skill) => skill.id === skillId)) {
      state.selectedSkillIds.delete(skillId);
    }
  });
  renderSkills();
}

async function loadCapabilities() {
  const data = await request("/api/capabilities");
  renderCapabilities(data);
}

async function loadAuthStatus() {
  const response = await fetch("/api/auth/status");
  const payload = await response.json();
  state.auth = payload;
  renderAuthState();
  if (payload.authenticated) {
    if (payload.mustChangePassword) {
      showAuthGate("首次登录请先修改默认密码。");
    } else {
      hideAuthGate();
    }
  } else {
    showAuthGate("请先登录。");
  }
  return payload;
}

async function login(event) {
  event.preventDefault();
  const payload = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({
      username: els.loginUsername.value.trim(),
      password: els.loginPassword.value
    })
  });
  state.auth = payload;
  renderAuthState();
  if (payload.mustChangePassword) {
    els.currentPassword.value = els.loginPassword.value;
    els.newPassword.value = "";
    showAuthGate("首次登录请先修改默认密码。");
    return;
  }
  hideAuthGate();
  els.loginPassword.value = "";
  await bootstrapApp();
}

async function submitForcedPasswordChange(event) {
  event.preventDefault();
  const payload = await request("/api/auth/password", {
    method: "POST",
    body: JSON.stringify({
      currentPassword: els.currentPassword.value,
      nextPassword: els.newPassword.value
    })
  });
  state.auth = payload;
  renderAuthState();
  hideAuthGate();
  els.loginPassword.value = "";
  els.currentPassword.value = "";
  els.newPassword.value = "";
  await bootstrapApp();
}

async function savePassword() {
  const payload = await request("/api/auth/password", {
    method: "POST",
    body: JSON.stringify({
      currentPassword: els.settingsCurrentPassword.value,
      nextPassword: els.settingsNewPassword.value
    })
  });
  state.auth = payload;
  renderAuthState();
  els.settingsCurrentPassword.value = "";
  els.settingsNewPassword.value = "";
  addMessage("system", "密码已更新。");
}

async function logout() {
  await request("/api/auth/logout", {
    method: "POST",
    body: JSON.stringify({})
  });
  state.auth = { authenticated: false };
  showAuthGate("已退出登录。");
}

function syncIncludeCheckbox() {
  els.includeFile.checked = state.currentFilePath ? state.selectedFiles.has(state.currentFilePath) : false;
}

async function openFile(relativePath) {
  const data = await request(`/api/workspace/file?${scopeQuery(relativePath)}`);
  state.scopePath = data.scopePath || state.scopePath;
  renderScopeSummary(data.scopeRoot || "");
  state.currentFilePath = normalizePath(relativePath);
  els.editorPath.textContent = state.currentFilePath;
  els.fileEditor.value = data.content;
  syncIncludeCheckbox();
}

async function saveConfig() {
  syncActiveProfileFromForm();
  state.config.workspaceRoot = els.workspaceRoot.value.trim();
  state.config.allowPublicAccess = els.allowPublicAccess.value === "true";
  state.config.listenPort = Number(els.listenPort.value) || 4780;
  state.config.systemPrompt = els.systemPrompt.value.trim();
  state.config = await request("/api/config", {
    method: "POST",
    body: JSON.stringify(state.config)
  });
  state.scopePath = ".";
  resetScopeSessionState();
  renderProfileOptions();
  renderProfileForm();
  renderScopeSummary(state.config.workspaceRoot);
  addMessage("system", state.config.restartRequired
    ? "配置已保存。监听地址或端口修改后需要重启 KingCode 才会生效。"
    : "配置已保存。");
  await loadTree(".");
  await loadSkills();
}

function newProfile() {
  const id = `profile-${Date.now()}`;
  state.config.profiles.push({
    id,
    name: "新模型配置",
    type: "openai-compatible",
    baseUrl: "",
    path: "",
    model: "",
    apiKey: "",
    headersTemplate: "{}",
    bodyTemplate: "",
    responsePath: ""
  });
  state.config.activeProfileId = id;
  renderProfileOptions();
  renderProfileForm();
  renderHeaderMeta();
}

function deleteProfile() {
  if (state.config.profiles.length === 1) {
    addMessage("system", "至少保留一个模型配置。");
    return;
  }

  state.config.profiles = state.config.profiles.filter((profile) => profile.id !== state.config.activeProfileId);
  state.config.activeProfileId = state.config.profiles[0].id;
  renderProfileOptions();
  renderProfileForm();
  renderHeaderMeta();
}

async function saveCurrentFile() {
  if (!state.currentFilePath) {
    addMessage("system", "请先打开一个文件。");
    return;
  }

  await request("/api/workspace/file", {
    method: "POST",
    body: JSON.stringify({
      path: state.currentFilePath,
      content: els.fileEditor.value,
      scopePath: state.scopePath
    })
  });
  addMessage("system", `已保存 ${state.currentFilePath}`);
}

async function applyScope(nextScopePath = els.scopePath.value.trim() || ".") {
  const previousScopePath = state.scopePath;
  const previousMessages = [...state.messages];
  const previousSelectedFiles = new Set(state.selectedFiles);
  const previousSelectedSkillIds = new Set(state.selectedSkillIds);
  const previousRecentCommandOutput = state.recentCommandOutput;
  const previousCurrentFilePath = state.currentFilePath;
  const previousCurrentPath = state.currentPath;
  const previousEditorValue = els.fileEditor.value;
  const previousCommandOutput = els.commandOutput.textContent;

  state.scopePath = nextScopePath;
  resetScopeSessionState();

  try {
    await loadTree(".");
    await loadSkills();
    addMessage("system", `已切换作用范围到 ${state.scopePath}。`);
  } catch (error) {
    state.scopePath = previousScopePath;
    state.messages = previousMessages;
    state.selectedFiles = previousSelectedFiles;
    state.selectedSkillIds = previousSelectedSkillIds;
    state.recentCommandOutput = previousRecentCommandOutput;
    state.currentFilePath = previousCurrentFilePath;
    state.currentPath = previousCurrentPath;
    els.fileEditor.value = previousEditorValue;
    els.commandOutput.textContent = previousCommandOutput;
    els.editorPath.textContent = previousCurrentFilePath || "未选择文件";
    renderMessages();
    syncIncludeCheckbox();
    await loadTree(previousCurrentPath || ".");
    await loadSkills();
    renderScopeSummary();
    throw error;
  }
}

async function runCommand() {
  const command = els.commandInput.value.trim();
  if (!command) {
    return;
  }

  const result = await request("/api/command", {
    method: "POST",
    body: JSON.stringify({
      command,
      scopePath: state.scopePath
    })
  });

  state.recentCommandOutput = result.combined;
  renderScopeSummary(result.scopeRoot || "");
  els.commandOutput.textContent = result.combined || "(no output)";
  addMessage("system", `命令执行完成，退出码 ${result.code}。`);
}

async function loadGitStatus() {
  const data = await request(`/api/git/status?scopePath=${encodeURIComponent(state.scopePath || ".")}`);
  renderScopeSummary(data.scopeRoot || "");
  renderGitStatus(data);
}

async function commitGitChanges() {
  const message = els.gitCommitMessage.value.trim();
  if (!message) {
    addMessage("system", "Enter a commit message first.");
    return;
  }

  try {
    const data = await request("/api/git/commit", {
      method: "POST",
      body: JSON.stringify({
        message,
        scopePath: state.scopePath
      })
    });
    els.gitCommitMessage.value = "";
    renderScopeSummary(data.scopeRoot || "");
    renderGitStatus(data);
    addMessage("system", data.output || "Git 提交已完成。");
  } catch (error) {
    addMessage("system", error.message);
  }
}

async function pushGitChanges() {
  try {
    const data = await request("/api/git/push", {
      method: "POST",
      body: JSON.stringify({
        scopePath: state.scopePath
      })
    });
    renderScopeSummary(data.scopeRoot || "");
    renderGitStatus(data);
    addMessage("system", data.output || "Git 推送已完成。");
  } catch (error) {
    addMessage("system", error.message);
  }
}

function deployPayload() {
  return {
    scopePath: state.scopePath,
    repoUrl: els.deployRepoUrl.value.trim(),
    targetPath: els.deployTargetPath.value.trim(),
    branch: els.deployBranch.value.trim(),
    projectPath: els.deployProjectPath.value.trim() || ".",
    installCommand: els.deployInstallCommand.value.trim(),
    buildCommand: els.deployBuildCommand.value.trim(),
    serviceName: els.deployServiceName.value.trim(),
    serviceMode: els.deployServiceMode.value,
    serviceTarget: els.deployServiceTarget.value.trim(),
    logSource: els.deployLogSource.value,
    lines: els.deployLogLines.value.trim(),
    healthUrl: els.deployHealthUrl.value.trim(),
    commit: els.deployRollbackCommit.value.trim(),
    composeAction: els.deployComposeAction.value,
    installNow: true,
    runtime: els.deployLogSource.value === "systemd" ? "systemd" : "pm2"
  };
}

async function runDeployAction(url, payload, successMessage) {
  try {
    const data = await request(url, {
      method: "POST",
      body: JSON.stringify(payload)
    });
    if (data.projectPath) {
      els.deployProjectPath.value = data.projectPath;
    }
    renderScopeSummary(data.scopeRoot || "");
    renderDeployResult(data);
    addMessage("system", successMessage);
  } catch (error) {
    addMessage("system", error.message);
    els.deployOutput.textContent = error.message;
  }
}

async function loadDeployStatus() {
  try {
    const query = new URLSearchParams({
      scopePath: state.scopePath || ".",
      projectPath: els.deployProjectPath.value.trim() || ".",
      serviceName: els.deployServiceName.value.trim()
    });
    const data = await request(`/api/deploy/status?${query.toString()}`);
    renderScopeSummary(data.scopeRoot || "");
    renderDeployResult(data);
    addMessage("system", "部署状态已加载。");
  } catch (error) {
    addMessage("system", error.message);
    els.deployOutput.textContent = error.message;
  }
}

async function createSystemdUnit() {
  try {
    const data = await request("/api/deploy/systemd", {
      method: "POST",
      body: JSON.stringify(deployPayload())
    });
    renderScopeSummary(data.scopeRoot || "");
    renderDeployResult(data);
    addMessage("system", "systemd 服务已处理。");
  } catch (error) {
    addMessage("system", error.message);
    els.deployOutput.textContent = error.message;
  }
}

async function loadDeployLogs() {
  try {
    const query = new URLSearchParams({
      scopePath: state.scopePath || ".",
      projectPath: els.deployProjectPath.value.trim() || ".",
      serviceName: els.deployServiceName.value.trim(),
      logSource: els.deployLogSource.value,
      lines: els.deployLogLines.value.trim() || "80"
    });
    const data = await request(`/api/deploy/logs?${query.toString()}`);
    renderScopeSummary(data.scopeRoot || "");
    renderDeployResult(data);
    addMessage("system", "日志已加载。");
  } catch (error) {
    addMessage("system", error.message);
    els.deployOutput.textContent = error.message;
  }
}

async function runComposeAction() {
  try {
    const data = await request("/api/deploy/docker", {
      method: "POST",
      body: JSON.stringify(deployPayload())
    });
    renderScopeSummary(data.scopeRoot || "");
    renderDeployResult(data);
    addMessage("system", "Docker Compose 操作已完成。");
  } catch (error) {
    addMessage("system", error.message);
    els.deployOutput.textContent = error.message;
  }
}

async function runHealthCheck() {
  try {
    const query = new URLSearchParams({
      url: els.deployHealthUrl.value.trim(),
      timeout: "8000"
    });
    const data = await request(`/api/deploy/health?${query.toString()}`);
    state.recentCommandOutput = [
      `健康检查目标：${els.deployHealthUrl.value.trim()}`,
      data.output || "(no output)"
    ].join("\n");
    els.deploySummary.textContent = `健康检查：${data.statusCode}`;
    els.deployOutput.textContent = data.output || "(no output)";
    addMessage("system", "健康检查通过。");
  } catch (error) {
    addMessage("system", error.message);
    els.deployOutput.textContent = error.message;
  }
}

async function loadDeployHistory() {
  try {
    const data = await request("/api/deploy/history?limit=20");
    const lines = (data.entries || []).map((entry) => {
      return [
        `${entry.timestamp} [${entry.action}] ${entry.ok ? "OK" : "FAIL"}`,
        entry.summary || "",
        entry.projectPath ? `Project: ${entry.projectPath}` : "",
        entry.fromCommit ? `From: ${entry.fromCommit}` : "",
        entry.toCommit ? `To: ${entry.toCommit}` : ""
      ].filter(Boolean).join("\n");
    });
    els.deploySummary.textContent = "部署历史";
    els.deployOutput.textContent = lines.length > 0 ? lines.join("\n\n") : "(no history)";
    addMessage("system", "部署历史已加载。");
  } catch (error) {
    addMessage("system", error.message);
    els.deployOutput.textContent = error.message;
  }
}

async function loadRecentCommits() {
  try {
    const query = new URLSearchParams({
      scopePath: state.scopePath || ".",
      projectPath: els.deployProjectPath.value.trim() || ".",
      limit: "15"
    });
    const data = await request(`/api/deploy/commits?${query.toString()}`);
    renderScopeSummary(data.scopeRoot || "");
    renderDeployResult(data);
    addMessage("system", "最近提交已加载。");
  } catch (error) {
    addMessage("system", error.message);
    els.deployOutput.textContent = error.message;
  }
}

async function loadOpsSnapshot() {
  try {
    const data = await request("/api/ops/snapshot", {
      method: "POST",
      body: JSON.stringify(deployPayload())
    });
    renderScopeSummary(data.scopeRoot || "");
    renderDeployResult(data);
    state.workflowId = "ops";
    document.querySelectorAll(".chip").forEach((entry) => {
      entry.classList.toggle("active", entry.dataset.workflow === "ops");
    });
    renderHeaderMeta();
    addMessage("system", "运维快照已写入对话上下文。");
  } catch (error) {
    addMessage("system", error.message);
    els.deployOutput.textContent = error.message;
  }
}

async function loadLocalServices() {
  try {
    const data = await request("/api/ops/services", {
      method: "POST",
      body: JSON.stringify(deployPayload())
    });
    renderScopeSummary(data.scopeRoot || "");
    renderDeployResult(data);
    state.workflowId = "ops";
    document.querySelectorAll(".chip").forEach((entry) => {
      entry.classList.toggle("active", entry.dataset.workflow === "ops");
    });
    renderHeaderMeta();
    addMessage("system", "本机服务清单已加载。");
  } catch (error) {
    addMessage("system", error.message);
    els.deployOutput.textContent = error.message;
  }
}

async function runOpsAuditAction() {
  try {
    const data = await request("/api/ops/audit", {
      method: "POST",
      body: JSON.stringify(deployPayload())
    });
    renderScopeSummary(data.scopeRoot || "");
    renderDeployResult(data);
    state.workflowId = "ops";
    document.querySelectorAll(".chip").forEach((entry) => {
      entry.classList.toggle("active", entry.dataset.workflow === "ops");
    });
    renderHeaderMeta();
    addMessage("system", "运维巡检已完成，并写入对话上下文。");
  } catch (error) {
    addMessage("system", error.message);
    els.deployOutput.textContent = error.message;
  }
}

async function syncFromRemote() {
  try {
    const data = await request("/api/ops/sync", {
      method: "POST",
      body: JSON.stringify(deployPayload())
    });
    renderScopeSummary(data.scopeRoot || "");
    renderDeployResult(data);
    state.workflowId = "ops";
    document.querySelectorAll(".chip").forEach((entry) => {
      entry.classList.toggle("active", entry.dataset.workflow === "ops");
    });
    renderHeaderMeta();
    addMessage("system", "远端同步更新已完成。");
  } catch (error) {
    addMessage("system", error.message);
    els.deployOutput.textContent = error.message;
  }
}

async function rollbackDeploy() {
  const commit = els.deployRollbackCommit.value.trim();
  if (!commit) {
    addMessage("system", "请先填写要回滚的提交号。");
    return;
  }

  try {
    const data = await request("/api/deploy/rollback", {
      method: "POST",
      body: JSON.stringify(deployPayload())
    });
    renderScopeSummary(data.scopeRoot || "");
    renderDeployResult(data);
    addMessage("system", "回滚已完成。");
  } catch (error) {
    addMessage("system", error.message);
    els.deployOutput.textContent = error.message;
  }
}

async function submitChat(event) {
  event.preventDefault();
  const content = els.messageInput.value.trim();
  if (!content) {
    return;
  }

  addMessage("user", content);
  els.messageInput.value = "";

  const payload = {
    profileId: state.config.activeProfileId,
    workflowId: state.workflowId,
    scopePath: state.scopePath,
    selectedSkillIds: [...state.selectedSkillIds],
    selectedFilePaths: [...state.selectedFiles],
    recentCommandOutput: state.recentCommandOutput,
    messages: state.messages.filter((message) => message.role === "user" || message.role === "assistant")
  };

  try {
    await submitChatFallback(payload);
  } catch (error) {
    addMessage("system", error.message);
  }
}

function bindEvents() {
  els.loginForm.addEventListener("submit", (event) => {
    login(event).catch((error) => {
      showAuthGate(error.message);
    });
  });
  els.changePasswordForm.addEventListener("submit", (event) => {
    submitForcedPasswordChange(event).catch((error) => {
      showAuthGate(error.message);
    });
  });
  els.profileSelect.addEventListener("change", () => {
    syncActiveProfileFromForm();
    state.config.activeProfileId = els.profileSelect.value;
    renderProfileForm();
    renderHeaderMeta();
  });

  els.saveConfig.addEventListener("click", saveConfig);
  els.savePassword.addEventListener("click", () => {
    savePassword().catch((error) => addMessage("system", error.message));
  });
  els.logout.addEventListener("click", () => {
    logout().catch((error) => addMessage("system", error.message));
  });
  els.newProfile.addEventListener("click", newProfile);
  els.deleteProfile.addEventListener("click", deleteProfile);
  els.applyScope.addEventListener("click", () => {
    applyScope().catch((error) => addMessage("system", error.message));
  });
  els.resetScope.addEventListener("click", () => {
    applyScope(".").catch((error) => addMessage("system", error.message));
  });
  els.refreshTree.addEventListener("click", () => loadTree(state.currentPath));
  els.refreshSkills.addEventListener("click", loadSkills);
  els.refreshCapabilities.addEventListener("click", () => {
    loadCapabilities().catch((error) => addMessage("system", error.message));
  });
  els.saveFile.addEventListener("click", saveCurrentFile);
  els.runCommand.addEventListener("click", runCommand);
  els.refreshGit.addEventListener("click", () => {
    loadGitStatus().catch((error) => addMessage("system", error.message));
  });
  els.gitCommit.addEventListener("click", commitGitChanges);
  els.gitPush.addEventListener("click", pushGitChanges);
  els.deployApplyPreset.addEventListener("click", applyDeployPreset);
  els.deployStatus.addEventListener("click", loadDeployStatus);
  els.deployClone.addEventListener("click", () => {
    runDeployAction("/api/deploy/clone", deployPayload(), "仓库克隆完成。");
  });
  els.deployInstall.addEventListener("click", () => {
    runDeployAction("/api/deploy/install", deployPayload(), "依赖安装完成。");
  });
  els.deployService.addEventListener("click", () => {
    runDeployAction("/api/deploy/service", deployPayload(), "PM2 服务已创建。");
  });
  els.deploySystemd.addEventListener("click", createSystemdUnit);
  els.deployLogs.addEventListener("click", loadDeployLogs);
  els.deployHealth.addEventListener("click", runHealthCheck);
  els.deployHistory.addEventListener("click", loadDeployHistory);
  els.deployCommits.addEventListener("click", loadRecentCommits);
  els.deployServices.addEventListener("click", loadLocalServices);
  els.deployAudit.addEventListener("click", runOpsAuditAction);
  els.deploySync.addEventListener("click", syncFromRemote);
  els.deployOpsSnapshot.addEventListener("click", loadOpsSnapshot);
  els.deployRollback.addEventListener("click", rollbackDeploy);
  els.deployCompose.addEventListener("click", runComposeAction);
  els.deployUpdate.addEventListener("click", () => {
    runDeployAction("/api/deploy/update", deployPayload(), "项目更新完成。");
  });
  els.chatForm.addEventListener("submit", submitChat);

  els.includeFile.addEventListener("change", () => {
    if (!state.currentFilePath) {
      els.includeFile.checked = false;
      return;
    }
    if (els.includeFile.checked) {
      state.selectedFiles.add(state.currentFilePath);
    } else {
      state.selectedFiles.delete(state.currentFilePath);
    }
    loadTree(state.currentPath);
  });

  document.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.querySelectorAll(".chip").forEach((entry) => entry.classList.remove("active"));
      chip.classList.add("active");
      state.workflowId = chip.dataset.workflow;
      renderHeaderMeta();
    });
  });

  els.toolTabs.forEach((button) => {
    button.addEventListener("click", () => activateToolPanel(button.dataset.panel));
  });
}

async function bootstrapApp() {
  if (state.bootstrapped) {
    return;
  }

  state.config = await request("/api/config");
  state.scopePath = ".";
  els.workspaceRoot.value = state.config.workspaceRoot;
  renderScopeSummary(state.config.workspaceRoot);
  els.systemPrompt.value = state.config.systemPrompt;
  renderProfileOptions();
  renderProfileForm();
  renderHeaderMeta();
  activateToolPanel("editor");
  applyDeployPreset();
  await loadTree(".");
  await loadSkills();
  await loadCapabilities();
  try {
    await loadGitStatus();
  } catch (error) {
    els.gitSummary.textContent = error.message;
    els.gitStatusOutput.textContent = "";
  }
  state.bootstrapped = true;
  addMessage("system", "KingCode 已就绪。");
}

async function init() {
  bindEvents();
  activateToolPanel("editor");
  await loadAuthStatus();
  if (state.auth?.authenticated && !state.auth.mustChangePassword) {
    hideAuthGate();
    try {
      await bootstrapApp();
    } catch (error) {
      addMessage("system", error.message);
    }
  }
}

init().catch((error) => {
  addMessage("system", error.message);
});
