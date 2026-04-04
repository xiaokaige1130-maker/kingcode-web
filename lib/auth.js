const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const AUTH_FILE = path.join(DATA_DIR, "auth.json");

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const derivedKey = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `scrypt:${salt}:${derivedKey}`;
}

function verifyPassword(password, storedHash) {
  const parts = String(storedHash || "").split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") {
    return false;
  }

  const [, salt, expected] = parts;
  const actual = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

function defaultAuthConfig() {
  return {
    username: "kingcode",
    passwordHash: hashPassword("kingcode"),
    mustChangePassword: true
  };
}

function ensureAuthFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(AUTH_FILE)) {
    fs.writeFileSync(AUTH_FILE, JSON.stringify(defaultAuthConfig(), null, 2), "utf8");
  }
}

function loadAuthConfig() {
  ensureAuthFile();

  try {
    const raw = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
    return {
      ...defaultAuthConfig(),
      ...raw
    };
  } catch (error) {
    const fallback = defaultAuthConfig();
    fs.writeFileSync(AUTH_FILE, JSON.stringify(fallback, null, 2), "utf8");
    return fallback;
  }
}

function saveAuthConfig(nextConfig) {
  ensureAuthFile();
  const normalized = {
    ...loadAuthConfig(),
    ...nextConfig
  };
  fs.writeFileSync(AUTH_FILE, JSON.stringify(normalized, null, 2), "utf8");
  return normalized;
}

function changePassword(nextPassword) {
  const trimmed = String(nextPassword || "").trim();
  if (trimmed.length < 6) {
    throw new Error("Password must be at least 6 characters.");
  }

  return saveAuthConfig({
    passwordHash: hashPassword(trimmed),
    mustChangePassword: false
  });
}

module.exports = {
  AUTH_FILE,
  changePassword,
  defaultAuthConfig,
  hashPassword,
  loadAuthConfig,
  saveAuthConfig,
  verifyPassword
};
