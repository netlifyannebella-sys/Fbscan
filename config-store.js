const fs = require("fs");
const path = require("path");

const CONFIG_FILE = path.join(__dirname, "data", "config.json");

function readFileConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeFileConfig(partial) {
  const current = readFileConfig();
  const next = { ...current, ...partial };
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
}

// Env vars (set in Railway dashboard) always win over the file, since the
// filesystem is not guaranteed to persist across redeploys unless a Volume
// is attached.
function getConfig() {
  const fileConfig = readFileConfig();
  return {
    databaseUrl: process.env.DATABASE_URL || fileConfig.database_url || null,
    webhookSecret: process.env.WEBHOOK_SECRET || fileConfig.webhook_secret || null,
  };
}

function setConfig({ databaseUrl, webhookSecret }) {
  writeFileConfig({ database_url: databaseUrl, webhook_secret: webhookSecret });
}

module.exports = { getConfig, setConfig };
