const express = require("express");
const path = require("path");
const { Client } = require("pg");
const { getConfig, setConfig } = require("./config-store");

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const PERIOD_HOURS = { "1h": 1, "12h": 12, "1d": 24, "7d": 24 * 7, "1m": 24 * 30, "1y": 24 * 365 };
const URL_RE = /(https?:\/\/[^\s]+)/gi;

async function getClient(databaseUrl) {
  const client = new Client({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  return client;
}

async function ensureTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS links (
      id BIGSERIAL PRIMARY KEY,
      url TEXT NOT NULL,
      chat_id TEXT,
      message_id BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS links_created_at_idx ON links (created_at);`);
}

// ---- save-config ----
app.post("/.netlify/functions/save-config", (req, res) => {
  const { databaseUrl, webhookSecret } = req.body || {};
  if (!databaseUrl || !webhookSecret) {
    return res.status(400).send("databaseUrl and webhookSecret are required");
  }
  try {
    setConfig({ databaseUrl, webhookSecret });
    return res.status(200).send("ok");
  } catch (err) {
    console.error(err);
    return res.status(500).send("Storage error");
  }
});

// ---- telegram-webhook ----
app.post("/.netlify/functions/telegram-webhook", async (req, res) => {
  const { databaseUrl, webhookSecret } = getConfig();

  const secretHeader = req.headers["x-telegram-bot-api-secret-token"];
  if (!webhookSecret || secretHeader !== webhookSecret) {
    return res.status(401).send("Unauthorized");
  }
  if (!databaseUrl) {
    return res.status(500).send("Not configured yet");
  }

  const update = req.body;
  const post = update?.channel_post || update?.message;
  if (!post) {
    return res.status(200).send("ignored");
  }

  const text = post.text || post.caption || "";
  const urls = text.match(URL_RE);
  if (!urls || urls.length === 0) {
    return res.status(200).send("no links");
  }

  const chatId = String(post.chat?.id ?? "");
  const messageId = post.message_id ?? null;

  let client;
  try {
    client = await getClient(databaseUrl);
    await ensureTable(client);
    for (const url of urls) {
      await client.query(
        "INSERT INTO links (url, chat_id, message_id) VALUES ($1, $2, $3)",
        [url, chatId, messageId]
      );
    }
    return res.status(200).send("ok");
  } catch (err) {
    console.error(err);
    return res.status(500).send("DB error");
  } finally {
    if (client) await client.end();
  }
});

// ---- get-links ----
app.get("/.netlify/functions/get-links", async (req, res) => {
  const period = req.query.period || "1d";
  const hours = PERIOD_HOURS[period] || 24;

  const { databaseUrl } = getConfig();
  if (!databaseUrl) {
    return res.status(200).json({ error: "not configured" });
  }

  let client;
  try {
    client = await getClient(databaseUrl);
    const { rows } = await client.query(
      `SELECT url FROM links WHERE created_at >= now() - ($1 || ' hours')::interval`,
      [hours]
    );

    const counts = new Map();
    for (const row of rows) {
      counts.set(row.url, (counts.get(row.url) || 0) + 1);
    }

    const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const total = rows.length;
    const unique = entries.filter(([, c]) => c === 1).length;
    const repeated = entries.filter(([, c]) => c > 1).length;

    return res.status(200).json({ total, unique, repeated, rows: entries });
  } catch (err) {
    if (err.code === "42P01") {
      return res.status(200).json({ total: 0, unique: 0, repeated: 0, rows: [] });
    }
    console.error(err);
    return res.status(500).json({ error: "DB error" });
  } finally {
    if (client) await client.end();
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`LinkWatch running on port ${PORT}`));
