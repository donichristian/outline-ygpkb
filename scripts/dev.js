/* oxlint-disable no-console */
/* oxlint-disable @typescript-oxlint/no-var-requires */
/* oxlint-disable typescript/no-require-imports */
/* oxlint-disable no-undef */
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");

const root = path.join(__dirname, "..");

/**
 * Reads a value from the same env files the application loads, honouring
 * precedence: `.env` first, then `.env.development`, then `.env.local`.
 * @param key {string}
 * @param fallback {string}
 * @return {string}
 */
function readEnvValue(key, fallback) {
  let value = fallback;

  for (const file of [".env", ".env.development", ".env.local"]) {
    const full = path.join(root, file);
    if (!fs.existsSync(full)) {
      continue;
    }
    for (const line of fs.readFileSync(full, "utf8").split(/\r?\n/)) {
      const match = /^([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
      if (match?.[1] === key) {
        value = match[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  }

  return value;
}

/**
 * Parses the host and port from a connection URL.
 * @param url {string}
 * @param fallbackPort {number}
 * @return {{host: string, port: number}}
 */
function parseTarget(url, fallbackPort) {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname || "127.0.0.1",
      port: Number(parsed.port) || fallbackPort,
    };
  } catch {
    return { host: "127.0.0.1", port: fallbackPort };
  }
}

/**
 * Resolves whether a TCP port accepts a connection.
 * @param port {number}
 * @param host {string}
 * @param timeout {number}
 * @return {Promise<boolean>}
 */
function probe(port, host = "127.0.0.1", timeout = 3000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeout);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/**
 * Resolves whether an HTTP server is answering on a port.
 * @param port {number}
 * @return {Promise<boolean>}
 */
function responds(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: "/", timeout: 3000 },
      (res) => {
        res.resume();
        resolve(true);
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

/**
 * Starts the backend and Vite dev server, streaming its output, and resolves
 * with its exit code.
 * @return {Promise<number>}
 */
function runDevServer() {
  return new Promise((resolve) => {
    const child = spawn("yarn", ["dev:watch"], {
      stdio: "inherit",
      shell: true,
    });
    child.on("close", (code) => resolve(code ?? 0));
  });
}

async function main() {
  // Mirror the application's precedence: process.env wins, then the env files.
  const database = parseTarget(
    process.env.DATABASE_URL ??
      readEnvValue(
        "DATABASE_URL",
        "postgres://user:pass@127.0.0.1:5432/outline"
      ),
    5432
  );
  const redis = parseTarget(
    process.env.REDIS_URL ??
      readEnvValue("REDIS_URL", "redis://127.0.0.1:6379"),
    6379
  );
  const appPort = Number(process.env.PORT ?? readEnvValue("PORT", "3000"));

  const [databaseUp, redisUp, appPortBusy] = await Promise.all([
    probe(database.port, database.host),
    probe(redis.port, redis.host),
    probe(appPort),
  ]);

  if (!databaseUp || !redisUp) {
    const down = [];
    if (!databaseUp) {
      down.push(`PostgreSQL at ${database.host}:${database.port}`);
    }
    if (!redisUp) {
      down.push(`Redis at ${redis.host}:${redis.port}`);
    }

    console.error(
      `\nCannot start the dev server, ${down.length} service(s) unreachable:\n`
    );
    for (const service of down) {
      console.error(`  - ${service}`);
    }
    console.error(
      "\nStart them, then try again. On Windows they are registered as services:\n"
    );
    console.error("  Start-Service postgresql-x64-17");
    console.error("  Start-Service Redis\n");
    process.exit(1);
  }

  if (appPortBusy) {
    if (await responds(appPort)) {
      console.log(
        `A dev server is already running on port ${appPort}.\nOpen http://localhost:${appPort}\n`
      );
      process.exit(0);
    }
    console.error(
      `\nPort ${appPort} is already in use by another process.\nStop it, or set PORT in .env.local to a free port.\n`
    );
    process.exit(1);
  }

  console.log("PostgreSQL and Redis are reachable. Starting dev server...\n");
  process.exit(await runDevServer());
}

void main();
