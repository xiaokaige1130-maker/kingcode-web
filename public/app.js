const state = {
  config: null,
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

const els = {
  profileSelect: document.querySelector("#profile-select"),
  profileName: document.querySelector("#profile-name"),
  profileType: document.querySelector("#profile-type"),
  profileBaseUrl: document.querySelector("#profile-base-url"),
  profilePath: document.querySelector("#profile-path"),
  profileModel: document.querySelector("#profile-model"),
  profileApiKey: document.querySelector("#profile-api-key"),
  profileHeaders: document.querySelector("#profile-headers"),
  profileBody: document.querySelector("#profile-body"),
  profileResponsePath: document.querySelector("#profile-response-path"),
  workspaceRoot: document.querySelector("#workspace-root"),
  scopePath: document.querySelector("#scope-path"),
  scopeSummary: document.querySelector("#scope-summary"),
  systemPrompt: document.querySelector("#system-prompt"),
  treePath: document.querySelector("#tree-path"),
  fileTree: document.querySelector("#file-tree"),
  skillsList: document.querySelector("#skills-list"),
  messages: document.querySelector("#messages"),
  messageInput: document.querySelector("#message-input"),
  chatForm: document.querySelector("#chat-form"),
  editorPath: document.querySelector("#editor-path"),
  includeFile: document.querySelector("#include-file"),
  fileEditor: document.querySelector("#file-editor"),
  commandInput: document.querySelector("#command-input"),
  commandOutput: document.querySelector("#command-output"),
  messageTemplate: document.querySelector("#message-template"),
  saveConfig: document.querySelector("#save-config"),
  deleteProfile: document.querySelector("#delete-profile"),
  newProfile: document.querySelector("#new-profile"),
  applyScope: document.querySelector("#apply-scope"),
  resetScope: document.querySelector("#reset-scope"),
  refreshTree: document.querySelector("#refresh-tree"),
  refreshSkills: document.querySelector("#refresh-skills"),
  saveFile: document.querySelector("#save-file"),
  runCommand: document.querySelector("#run-command")
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
    throw new Error(payload.error || "Request failed.");
  }
  return payload;
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
    ? `Scope: ${scopePath} (${scopeRoot})`
    : `Scope: ${scopePath}`;
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
    node.querySelector(".message-role").textContent = message.role;
    node.querySelector(".message-body").textContent = message.content;
    els.messages.append(node);
  });

  els.messages.scrollTop = els.messages.scrollHeight;
}

function addMessage(role, content) {
  state.messages.push({ role, content });
  renderMessages();
}

function renderSkills() {
  els.skillsList.innerHTML = "";

  if (!Array.isArray(state.availableSkills) || state.availableSkills.length === 0) {
    const empty = document.createElement("div");
    empty.className = "hint";
    empty.textContent = "No skills found.";
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
    title.textContent = skill.id;

    const source = document.createElement("div");
    source.className = "skill-source";
    source.textContent = `Source: ${skill.sourceType}`;

    const desc = document.createElement("div");
    desc.className = "skill-desc";
    desc.textContent = skill.description || "No description.";

    meta.append(title, source, desc);
    row.append(checkbox, meta);
    els.skillsList.append(row);
  });
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
  els.editorPath.textContent = "No file selected";
  els.fileEditor.value = "";
  els.commandOutput.textContent = "";
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
  addMessage("system", "Configuration saved.");
  await loadTree(".");
  await loadSkills();
}

function newProfile() {
  const id = `profile-${Date.now()}`;
  state.config.profiles.push({
    id,
    name: "New Profile",
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
}

function deleteProfile() {
  if (state.config.profiles.length === 1) {
    addMessage("system", "At least one profile must remain.");
    return;
  }

  state.config.profiles = state.config.profiles.filter((profile) => profile.id !== state.config.activeProfileId);
  state.config.activeProfileId = state.config.profiles[0].id;
  renderProfileOptions();
  renderProfileForm();
}

async function saveCurrentFile() {
  if (!state.currentFilePath) {
    addMessage("system", "Open a file before saving.");
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
  addMessage("system", `Saved ${state.currentFilePath}`);
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
    addMessage("system", `Scope switched to ${state.scopePath}.`);
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
    els.editorPath.textContent = previousCurrentFilePath || "No file selected";
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
  addMessage("system", `Command finished with code ${result.code}.`);
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
    const data = await request("/api/chat", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    renderScopeSummary(data.scopeRoot || "");
    addMessage("assistant", data.content);
  } catch (error) {
    addMessage("system", error.message);
  }
}

function bindEvents() {
  els.profileSelect.addEventListener("change", () => {
    syncActiveProfileFromForm();
    state.config.activeProfileId = els.profileSelect.value;
    renderProfileForm();
  });

  els.saveConfig.addEventListener("click", saveConfig);
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
  els.saveFile.addEventListener("click", saveCurrentFile);
  els.runCommand.addEventListener("click", runCommand);
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
    });
  });
}

async function init() {
  state.config = await request("/api/config");
  state.scopePath = ".";
  els.workspaceRoot.value = state.config.workspaceRoot;
  renderScopeSummary(state.config.workspaceRoot);
  els.systemPrompt.value = state.config.systemPrompt;
  renderProfileOptions();
  renderProfileForm();
  bindEvents();
  await loadTree(".");
  await loadSkills();
  addMessage("system", "KingCode is ready.");
}

init().catch((error) => {
  addMessage("system", error.message);
});
