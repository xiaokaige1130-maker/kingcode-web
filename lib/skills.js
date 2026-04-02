const fs = require("fs");
const path = require("path");

const APP_ROOT = path.resolve(__dirname, "..");
const APP_SKILLS_DIR = path.join(APP_ROOT, "skills");

function uniquePaths(paths) {
  const seen = new Set();
  return paths.filter((entry) => {
    const normalized = path.resolve(entry);
    if (seen.has(normalized)) {
      return false;
    }
    seen.add(normalized);
    return true;
  });
}

function getSkillRoots(config) {
  const workspaceRoot = config && config.workspaceRoot ? path.resolve(config.workspaceRoot) : "";
  return uniquePaths([
    APP_SKILLS_DIR,
    workspaceRoot ? path.join(workspaceRoot, "skills") : "",
    workspaceRoot ? path.join(workspaceRoot, ".claude", "skills") : ""
  ].filter(Boolean)).filter((entry) => fs.existsSync(entry) && fs.statSync(entry).isDirectory());
}

function detectSourceType(rootPath, config) {
  const resolvedRoot = path.resolve(rootPath);
  const workspaceRoot = config && config.workspaceRoot ? path.resolve(config.workspaceRoot) : "";

  if (resolvedRoot === path.resolve(APP_SKILLS_DIR)) {
    return "app";
  }
  if (workspaceRoot && resolvedRoot === path.join(workspaceRoot, "skills")) {
    return "workspace";
  }
  if (workspaceRoot && resolvedRoot === path.join(workspaceRoot, ".claude", "skills")) {
    return "claude";
  }
  return "custom";
}

function summarizeSkill(content) {
  const lines = String(content).split(/\r?\n/);
  let inFence = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }

    if (!line || inFence || line.startsWith("#")) {
      continue;
    }

    return line.length > 180 ? `${line.slice(0, 177)}...` : line;
  }

  return "";
}

function listSkills(config) {
  const skills = [];

  for (const rootPath of getSkillRoots(config)) {
    const sourceType = detectSourceType(rootPath, config);
    const entries = fs.readdirSync(rootPath, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const skillDir = path.join(rootPath, entry.name);
      const skillFile = path.join(skillDir, "SKILL.md");
      if (!fs.existsSync(skillFile) || !fs.statSync(skillFile).isFile()) {
        continue;
      }

      const content = fs.readFileSync(skillFile, "utf8");
      skills.push({
        id: `${sourceType}:${entry.name}`,
        name: entry.name,
        sourceType,
        rootPath,
        path: skillFile,
        description: summarizeSkill(content)
      });
    }
  }

  return skills.sort((left, right) => {
    if (left.sourceType !== right.sourceType) {
      return left.sourceType.localeCompare(right.sourceType);
    }
    return left.name.localeCompare(right.name);
  });
}

function loadSkillsByIds(config, skillIds = []) {
  const wanted = new Set(Array.isArray(skillIds) ? skillIds : []);
  if (wanted.size === 0) {
    return [];
  }

  return listSkills(config)
    .filter((skill) => wanted.has(skill.id))
    .map((skill) => ({
      ...skill,
      content: fs.readFileSync(skill.path, "utf8")
    }));
}

module.exports = {
  getSkillRoots,
  listSkills,
  loadSkillsByIds
};
