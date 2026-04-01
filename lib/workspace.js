const fs = require("fs");
const path = require("path");

function assertInsideWorkspace(workspaceRoot, relativePath = ".") {
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(root, relativePath);
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;

  if (target !== root && !target.startsWith(rootWithSep)) {
    throw new Error("Path escapes the configured workspace root.");
  }

  return target;
}

function listDirectory(workspaceRoot, relativePath = ".") {
  const target = assertInsideWorkspace(workspaceRoot, relativePath);
  const entries = fs.readdirSync(target, { withFileTypes: true })
    .filter((entry) => entry.name !== ".git")
    .map((entry) => {
      const entryPath = path.join(relativePath, entry.name).replace(/\\/g, "/");
      return {
        name: entry.name,
        path: entryPath === "." ? entry.name : entryPath,
        type: entry.isDirectory() ? "directory" : "file"
      };
    })
    .sort((left, right) => {
      if (left.type !== right.type) {
        return left.type === "directory" ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });

  return {
    path: relativePath,
    entries
  };
}

function readFile(workspaceRoot, relativePath) {
  const target = assertInsideWorkspace(workspaceRoot, relativePath);
  const stats = fs.statSync(target);

  if (stats.size > 512 * 1024) {
    throw new Error("Refusing to open files larger than 512 KB in the editor.");
  }

  return fs.readFileSync(target, "utf8");
}

function writeFile(workspaceRoot, relativePath, content) {
  const target = assertInsideWorkspace(workspaceRoot, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

function buildTreeLines(workspaceRoot, relativePath = ".", depth = 2, prefix = "") {
  if (depth < 0) {
    return [];
  }

  const listing = listDirectory(workspaceRoot, relativePath).entries.slice(0, 40);
  const lines = [];

  for (const entry of listing) {
    lines.push(`${prefix}${entry.type === "directory" ? "[D]" : "[F]"} ${entry.path}`);
    if (entry.type === "directory" && depth > 0) {
      lines.push(...buildTreeLines(workspaceRoot, entry.path, depth - 1, `${prefix}  `));
    }
  }

  return lines;
}

function collectFiles(workspaceRoot, relativePaths = []) {
  return relativePaths.map((relativePath) => {
    const content = readFile(workspaceRoot, relativePath);
    return {
      path: relativePath,
      content
    };
  });
}

module.exports = {
  assertInsideWorkspace,
  buildTreeLines,
  collectFiles,
  listDirectory,
  readFile,
  writeFile
};
