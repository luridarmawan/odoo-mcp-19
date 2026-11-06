#!/usr/bin/env node
// Provision the multi-user registry (users.db) without CLORAG — Node edition.
//
// odoo-mcp-19 only *reads* the registry (sqlite mode=ro); normally CLORAG
// writes it through its /admin/users page. Running standalone, this script is
// the writer. It re-implements the two contracts the server reads:
//   - schema  : src/odoo_mcp/users_db.py     (4 tables, never change them here)
//   - crypto  : src/odoo_mcp/token_crypto.py (Fernet, PBKDF2-SHA256 480 000
//               iterations, salt in .token_salt next to users.db)
//
// Zero npm dependencies: SQLite comes from node:sqlite (Node >= 22.5, no flag
// on Node >= 23.4), Fernet is built from node:crypto primitives.
//
// Usage (see docs/multi-user-standalone.md for the zsh alias):
//   node scripts/registry-admin.mjs --registry ./registry init
//   node scripts/registry-admin.mjs --registry ./registry add-user \
//        --name "Budi" --email budi@example.com --role support
//   node scripts/registry-admin.mjs --registry ./registry issue-key --email budi@example.com
//   node scripts/registry-admin.mjs --registry ./registry set-odoo --email budi@example.com \
//        --odoo-username budi@example.com --odoo-api-key <odoo api key>
//   node scripts/registry-admin.mjs --registry ./registry list

import { createCipheriv, createHmac, createHash, pbkdf2Sync, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  die(
    "node:sqlite is unavailable.\n" +
      "  Needs Node >= 22.5 (with --experimental-sqlite) or Node >= 23.4.\n" +
      `  This Node is ${process.version}. Easiest fix: run the script in a container,\n` +
      "  see docs/multi-user-standalone.md."
  );
}

// MUST match src/odoo_mcp/token_crypto.py (and clorag utils/token_encryption.py)
const PBKDF2_ITERATIONS = 480_000;

// MUST match src/odoo_mcp/users_db.py (and clorag core/user_db.py)
const REGISTRY_DDL = `
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL,
    role TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
    server TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE,
    key_prefix TEXT NOT NULL, created_at TEXT NOT NULL,
    last_used_at TEXT, revoked_at TEXT);
CREATE TABLE IF NOT EXISTS user_odoo_credentials (
    user_id TEXT PRIMARY KEY REFERENCES users(id),
    odoo_username TEXT NOT NULL, encrypted_secret TEXT NOT NULL,
    updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS user_skills (
    user_id TEXT NOT NULL REFERENCES users(id),
    skill_name TEXT NOT NULL, PRIMARY KEY (user_id, skill_name));
`;

const ROLES = ["admin", "support", "readonly"];

function die(message) {
  console.error(message);
  process.exit(1);
}

// Python's datetime.now().isoformat() shape, so rows look the same as CLORAG's.
const now = () => new Date().toISOString().replace("Z", "");

const dbPath = (registry) => join(registry, "users.db");
const saltPath = (registry) => join(registry, ".token_salt");

function openDb(registry) {
  if (!existsSync(dbPath(registry))) die(`registry not found: ${dbPath(registry)} - run \`init\` first`);
  return new DatabaseSync(dbPath(registry));
}

function encryptionPassword() {
  const value = process.env.TOKEN_ENCRYPTION_KEY;
  if (value) return value.trim();
  const file = process.env.TOKEN_ENCRYPTION_KEY_FILE;
  if (file && existsSync(file)) return readFileSync(file, "utf8").trim();
  die("TOKEN_ENCRYPTION_KEY (or TOKEN_ENCRYPTION_KEY_FILE) is required");
}

/**
 * Fernet encrypt, byte-for-byte compatible with Python's cryptography.Fernet.
 * Token = base64url( 0x80 | timestamp(8B BE) | IV(16B) | AES-128-CBC ct | HMAC-SHA256(32B) )
 * with the 32-byte key split into signing key (first 16) and encryption key (last 16).
 */
function fernetEncrypt(plaintext, key) {
  const signingKey = key.subarray(0, 16);
  const encryptionKey = key.subarray(16, 32);
  const iv = randomBytes(16);
  const timestamp = Buffer.alloc(8);
  timestamp.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000)));

  const cipher = createCipheriv("aes-128-cbc", encryptionKey, iv); // PKCS7 padding is the default
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);

  const body = Buffer.concat([Buffer.from([0x80]), timestamp, iv, ciphertext]);
  const mac = createHmac("sha256", signingKey).update(body).digest();
  // Fernet uses padded urlsafe base64 — Python's urlsafe_b64decode rejects stripped padding.
  return Buffer.concat([body, mac]).toString("base64").replaceAll("+", "-").replaceAll("/", "_");
}

function encryptSecret(payload, registry) {
  if (!existsSync(saltPath(registry))) die(`salt file not found: ${saltPath(registry)} - run \`init\` first`);
  const salt = readFileSync(saltPath(registry));
  const key = pbkdf2Sync(encryptionPassword(), salt, PBKDF2_ITERATIONS, 32, "sha256");
  return fernetEncrypt(JSON.stringify(payload), key);
}

function findUser(db, email) {
  const row = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!row) die(`no user with email ${email}`);
  return row;
}

function requireOpt(opts, name) {
  if (!opts[name]) die(`--${name} is required`);
  return opts[name];
}

// --- commands ---------------------------------------------------------------

const commands = {
  init(registry) {
    mkdirSync(registry, { recursive: true });
    const db = new DatabaseSync(dbPath(registry));
    db.exec(REGISTRY_DDL);
    db.close();
    if (existsSync(saltPath(registry))) {
      console.log(`salt already present, kept: ${saltPath(registry)}`);
    } else {
      writeFileSync(saltPath(registry), randomBytes(16));
      console.log(`salt created: ${saltPath(registry)}`);
    }
    console.log(`registry ready: ${dbPath(registry)}`);
    console.log("NOTE: never regenerate .token_salt - every stored credential would stop decrypting.");
  },

  "add-user"(registry, opts) {
    const db = openDb(registry);
    const email = requireOpt(opts, "email");
    const name = requireOpt(opts, "name");
    const role = opts.role ?? "support";
    if (!ROLES.includes(role)) die(`--role must be one of ${ROLES.join(", ")}`);
    if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) die(`user ${email} already exists`);
    const id = randomUUID();
    db.prepare("INSERT INTO users VALUES (?, ?, ?, ?, 1, ?, ?)").run(id, name, email, role, now(), now());
    console.log(`user created: ${email} (${role}) id=${id}`);
  },

  "issue-key"(registry, opts) {
    const db = openDb(registry);
    const user = findUser(db, requireOpt(opts, "email"));
    const fullKey = `cv_odoo_${randomBytes(16).toString("hex")}`;
    db.prepare("INSERT INTO api_keys VALUES (?, ?, 'odoo', ?, ?, ?, NULL, NULL)").run(
      randomUUID(),
      user.id,
      createHash("sha256").update(fullKey).digest("hex"),
      fullKey.slice(0, 12),
      now()
    );
    console.log(`key for ${opts.email} (shown once - the registry stores only its sha256):`);
    console.log(fullKey);
  },

  "revoke-key"(registry, opts) {
    const db = openDb(registry);
    const result = db
      .prepare("UPDATE api_keys SET revoked_at = ? WHERE key_prefix = ? AND revoked_at IS NULL")
      .run(now(), requireOpt(opts, "prefix"));
    console.log(`revoked ${result.changes} key(s) with prefix ${opts.prefix}`);
  },

  "set-odoo"(registry, opts) {
    const db = openDb(registry);
    const user = findUser(db, requireOpt(opts, "email"));
    const odooUsername = requireOpt(opts, "odoo-username");
    const secret = encryptSecret({ api_key: requireOpt(opts, "odoo-api-key") }, registry);
    db.prepare(
      "INSERT INTO user_odoo_credentials VALUES (?, ?, ?, ?)" +
        " ON CONFLICT(user_id) DO UPDATE SET odoo_username = excluded.odoo_username," +
        " encrypted_secret = excluded.encrypted_secret, updated_at = excluded.updated_at"
    ).run(user.id, odooUsername, secret, now());
    console.log(`odoo credentials stored for ${opts.email} -> ${odooUsername}`);
    console.log("a running server picks up the change within 300s (per-user client TTL)");
  },

  "grant-skill"(registry, opts) {
    const db = openDb(registry);
    const user = findUser(db, requireOpt(opts, "email"));
    db.prepare("INSERT OR IGNORE INTO user_skills VALUES (?, ?)").run(user.id, requireOpt(opts, "skill"));
    console.log(`granted ${opts.skill} to ${opts.email}`);
  },

  "revoke-skill"(registry, opts) {
    const db = openDb(registry);
    const user = findUser(db, requireOpt(opts, "email"));
    db.prepare("DELETE FROM user_skills WHERE user_id = ? AND skill_name = ?").run(
      user.id,
      requireOpt(opts, "skill")
    );
    console.log(`revoked ${opts.skill} from ${opts.email}`);
  },

  deactivate: (registry, opts) => setActive(registry, opts, 0),
  activate: (registry, opts) => setActive(registry, opts, 1),

  list(registry) {
    const db = openDb(registry);
    const users = db.prepare("SELECT * FROM users ORDER BY created_at").all();
    if (users.length === 0) console.log("(no users yet)");
    for (const user of users) {
      const keys = db
        .prepare("SELECT key_prefix, revoked_at FROM api_keys WHERE user_id = ? AND server = 'odoo'")
        .all(user.id);
      const creds = db
        .prepare("SELECT odoo_username, updated_at FROM user_odoo_credentials WHERE user_id = ?")
        .get(user.id);
      const skills = db.prepare("SELECT skill_name FROM user_skills WHERE user_id = ?").all(user.id);
      const keyLabels = keys.map((k) => k.key_prefix + (k.revoked_at ? "(revoked)" : ""));
      console.log(`- ${user.email}  role=${user.role}${user.is_active ? "" : "  [INACTIVE]"}`);
      console.log(
        `    odoo  : ${
          creds
            ? `${creds.odoo_username} (updated ${creds.updated_at})`
            : "MISSING - this user's calls will fail with PermissionError"
        }`
      );
      console.log(`    keys  : ${keyLabels.join(", ") || "none"}`);
      console.log(`    skills: ${skills.map((s) => s.skill_name).join(", ") || "none"}`);
    }
  },
};

function setActive(registry, opts, active) {
  const db = openDb(registry);
  const user = findUser(db, requireOpt(opts, "email"));
  db.prepare("UPDATE users SET is_active = ?, updated_at = ? WHERE id = ?").run(active, now(), user.id);
  console.log(`${opts.email} is now ${active ? "active" : "inactive"}`);
}

// --- arg parsing ------------------------------------------------------------

const USAGE = `registry-admin — provision the odoo-mcp-19 multi-user registry

  registry-admin [--registry DIR] <command> [--opt value ...]

Commands:
  init                                       create users.db + .token_salt
  add-user      --name --email [--role ${ROLES.join("|")}]
  issue-key     --email                      print a cv_odoo_… token (once)
  revoke-key    --prefix
  set-odoo      --email --odoo-username --odoo-api-key
  grant-skill   --email --skill
  revoke-skill  --email --skill
  activate | deactivate  --email
  list

--registry defaults to /registry (the container mount) or $REGISTRY_DIR.
TOKEN_ENCRYPTION_KEY or TOKEN_ENCRYPTION_KEY_FILE must be set for set-odoo.`;

const argv = process.argv.slice(2);
let registry = process.env.REGISTRY_DIR ?? "/registry";
let command = null;
const opts = {};

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--registry") {
    registry = argv[++i];
  } else if (arg === "-h" || arg === "--help") {
    console.log(USAGE);
    process.exit(0);
  } else if (arg.startsWith("--")) {
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) die(`--${key} needs a value`);
    opts[key] = next;
    i++;
  } else if (command === null) {
    command = arg;
  } else {
    die(`unexpected argument: ${arg}`);
  }
}

if (command === null) {
  console.log(USAGE);
  process.exit(2);
}
if (!Object.hasOwn(commands, command)) die(`unknown command: ${command}\n\n${USAGE}`);

commands[command](registry, opts);
