# Multi-user mode without CLORAG (standalone registry)

The server activates multi-user mode when `USERS_DB_PATH` is set on the HTTP
transport. It is a **pure reader** of that registry (`sqlite … mode=ro`) — in
the Cyanview deployment CLORAG writes it through `/admin/users`. Running
standalone, you provide the writer yourself: `scripts/registry-admin.mjs`
(Node, zero npm dependencies), which re-implements the same two contracts the
server reads — schema from `src/odoo_mcp/users_db.py`, crypto from
`src/odoo_mcp/token_crypto.py` (Fernet, PBKDF2-SHA256, 480 000 iterations,
salt in `.token_salt`).

What a working setup needs:

| Piece | Where |
|---|---|
| `users.db` (4 tables) | registry dir, mounted read-only at `/registry` |
| `.token_salt` (16 random bytes) | next to `users.db` |
| `TOKEN_ENCRYPTION_KEY` | env or Docker secret — encrypts each user's Odoo API key |
| per-user `cv_odoo_…` bearer key | sha256 stored in `api_keys`, plaintext shown once |
| per-user Odoo login + API key | `user_odoo_credentials`, Fernet-encrypted |

`ODOO_URL` / `ODOO_DB` stay in `.env` (shared instance); `ODOO_USERNAME` /
`ODOO_API_KEY` are only used by the static `MCP_API_KEY` fallback identity.

**Node version**: the script uses the built-in `node:sqlite`, so it needs
Node ≥ 23.4, or Node 22.5–23.3 with `node --experimental-sqlite`. No Node on
the host? Use the Docker alias below instead — same script, same result.

**WSL**: keep the project inside the Linux filesystem (`~/odoo-mcp-19`), not
`/mnt/d/…`. SQLite locking and Docker bind mounts both behave badly on the
Windows drive mount.

## 1. Create the registry dir and the encryption secret

```zsh
mkdir -p registry secrets
node -e 'console.log(require("crypto").randomBytes(32).toString("base64url"))' > secrets/token_encryption_key
chmod 644 secrets/token_encryption_key   # the server container reads it as UID 1001
```

Both directories are gitignored.

## 2. Define the alias (zsh)

Add to `~/.zshrc`, adjusting `MCP_DIR` to where you cloned the project:

Pick **one** of A or B (single line each — a backslash-continued alias body is
fragile in zsh):

```zsh
export MCP_DIR=~/odoo-mcp-19

# A) Node >= 23.4 available on the host
alias mcp-registry='TOKEN_ENCRYPTION_KEY_FILE=$MCP_DIR/secrets/token_encryption_key node $MCP_DIR/scripts/registry-admin.mjs --registry $MCP_DIR/registry'

# B) No Node on the host — run the same script in a container
alias mcp-registry='docker run --rm -v "$MCP_DIR/registry:/registry" -v "$MCP_DIR/scripts:/scripts:ro" -v "$MCP_DIR/secrets/token_encryption_key:/run/key:ro" -e TOKEN_ENCRYPTION_KEY_FILE=/run/key node:24-alpine node /scripts/registry-admin.mjs --registry /registry'
```

Then `source ~/.zshrc`. Single quotes are deliberate: `$MCP_DIR` expands when
the alias runs, not when it is defined. (A shell function in `~/.zshrc` works
just as well if you prefer multi-line readability.)

## 3. Provision users

```zsh
mcp-registry init
mcp-registry add-user --name "Budi" --email budi@example.com --role support
mcp-registry issue-key --email budi@example.com          # prints cv_odoo_… once
mcp-registry set-odoo --email budi@example.com \
             --odoo-username budi@example.com --odoo-api-key <Budi's Odoo API key>
mcp-registry grant-skill --email budi@example.com --skill cyanview-rma   # optional
mcp-registry list
```

Each user generates their own Odoo API key in Odoo: *Preferences → Account
Security → New API Key*. That is what makes writes attributable to the real
Odoo account.

Roles: `admin` (unrestricted), `support` (normal safety rules), `readonly`
(safety classifies every non-read method as BLOCKED).

## 4. Start with the overlay

`.env` additions (compose interpolates them):

```
USERS_DB_HOST_DIR=./registry
TOKEN_ENCRYPTION_KEY_SECRET=./secrets/token_encryption_key
MCP_BIND=0.0.0.0        # only if colleagues connect from other machines
```

```zsh
docker compose -f docker-compose.yml -f docker-compose.multiuser.yml up -d
```

Startup preflight exits 1 if `users.db`, `.token_salt`, or the encryption key
is missing. Keeping `MCP_API_KEY` set leaves the static admin fallback
(identity `env-admin`, env Odoo client) alive — remove it from `.env` to force
every caller onto a personal key.

## 5. Verify

Send an MCP `initialize` with the user's key (or `MCP_API_KEY` for the
env-admin fallback, if still set):

```zsh
curl -s http://localhost:8080/mcp   -H "Authorization: Bearer cv_odoo_<Budi's key>"   -H "Content-Type: application/json"   -H "Accept: application/json, text/event-stream"   -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

A `401` means the key is unknown or revoked. A `readonly` user gets a BLOCKED
response instead of `pending_confirmation` on any `write` — that is the role
working as designed.

## Operations

- Rotating a user's Odoo key: re-run `set-odoo`; the running server re-checks
  `updated_at` within 300 s (`user_clients.py` TTL) — no restart needed.
- Revoking access: `mcp-registry revoke-key --prefix cv_odoo_abcd` or
  `mcp-registry deactivate --email …`.
- **Never regenerate `.token_salt`** — every stored credential stops decrypting.
- Back up `registry/` and `secrets/` together; they are useless apart.
