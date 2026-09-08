/* eslint-disable no-console */
import 'dotenv/config';
import { execSync } from 'node:child_process';
import { PrismaPg } from '@prisma/adapter-pg';
import chalk from 'chalk';
import { PrismaClient } from '../generated/prisma/client.js';

const MIN_VERSION = '9.4.0';
const MIN_VERSION_NUM = 90400;

// Fail fast instead of hanging a CI build until its wall-clock limit.
const CONNECT_TIMEOUT_MS = Number(process.env.DB_CHECK_TIMEOUT_MS) || 30_000;
const MIGRATE_TIMEOUT_MS = Number(process.env.DB_MIGRATE_TIMEOUT_MS) || 600_000;

// Transaction-mode poolers (PgBouncer) cannot hold the advisory lock that
// `prisma migrate deploy` takes, so it blocks forever rather than failing.
const TRANSACTION_POOLER_PORT = '6543';
const SESSION_POOLER_PORT = '5432';

if (process.env.SKIP_DB_CHECK) {
  console.log('Skipping database check.');
  process.exit(0);
}

const url = new URL(process.env.DATABASE_URL);
// Username is not a secret and distinguishes a malformed pooler user
// (`postgres`) from a correct one (`postgres.<project-ref>`).
console.log(`DEBUG: DATABASE_URL is defined. Host is: ${url.host}, user is: ${url.username}`);

const adapter = new PrismaPg(
  { connectionString: url.toString() },
  { schema: url.searchParams.get('schema') },
);

const prisma = new PrismaClient({ adapter });

function success(msg) {
  console.log(chalk.greenBright(`✓ ${msg}`));
}

function error(msg) {
  console.log(chalk.redBright(`✗ ${msg}`));
}

function warn(msg) {
  console.log(chalk.yellowBright(`! ${msg}`));
}

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms.`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `prisma migrate deploy` needs a session-mode connection. When DIRECT_DATABASE_URL
 * is not set, derive one from DATABASE_URL by moving off the transaction-pooler port
 * and dropping the pooling-only parameters, rather than silently reusing a URL that
 * migrations cannot run over.
 */
function resolveDirectUrl() {
  if (process.env.DIRECT_DATABASE_URL) {
    return process.env.DIRECT_DATABASE_URL;
  }

  const directUrl = new URL(url.toString());

  if (directUrl.port !== TRANSACTION_POOLER_PORT) {
    return directUrl.toString();
  }

  directUrl.port = SESSION_POOLER_PORT;
  directUrl.searchParams.delete('pgbouncer');
  directUrl.searchParams.delete('connection_limit');

  warn(
    `DATABASE_URL points at a transaction pooler (:${TRANSACTION_POOLER_PORT}), which cannot run ` +
      `migrations. Using ${directUrl.host} for migrations instead. ` +
      `Set DIRECT_DATABASE_URL to override.`,
  );

  return directUrl.toString();
}

async function checkEnv() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not defined.');
  } else {
    success('DATABASE_URL is defined.');
  }

  if (process.env.REDIS_URL) {
    success('REDIS_URL is defined.');
  }
}

async function checkConnection() {
  try {
    // $connect() is lazy under a driver adapter and succeeds against an unreachable
    // database, so issue a real round-trip here.
    await withTimeout(prisma.$queryRaw`select 1`, CONNECT_TIMEOUT_MS, 'Database connection');

    success('Database connection successful.');
  } catch (e) {
    throw new Error(`Unable to connect to the database: ${e.message}`);
  }
}

async function checkDatabaseVersion() {
  const query = await withTimeout(
    prisma.$queryRaw`select current_setting('server_version_num') as version_num`,
    CONNECT_TIMEOUT_MS,
    'Database version check',
  );
  const version = Number(query[0]?.version_num);

  if (!Number.isFinite(version)) {
    throw new Error('Unable to determine database version.');
  }

  if (version < MIN_VERSION_NUM) {
    throw new Error(
      `Database version is not compatible. Please upgrade to ${MIN_VERSION} or greater.`,
    );
  }

  success('Database version check successful.');
}

async function applyMigration() {
  if (!process.env.SKIP_DB_MIGRATION) {
    const directUrl = resolveDirectUrl();

    try {
      console.log(
        execSync('prisma migrate deploy', {
          env: { ...process.env, DATABASE_URL: directUrl },
          timeout: MIGRATE_TIMEOUT_MS,
        }).toString(),
      );
    } catch (e) {
      if (e.killed || e.signal) {
        throw new Error(
          `Migrations timed out after ${MIGRATE_TIMEOUT_MS}ms against ${new URL(directUrl).host}. ` +
            `A transaction-mode pooler cannot hold the migration advisory lock — ` +
            `point DIRECT_DATABASE_URL at a session-mode (:${SESSION_POOLER_PORT}) connection.`,
        );
      }

      throw new Error(
        `Migrations failed: ${e.stdout?.toString() || ''}${e.stderr?.toString() || e.message}`,
      );
    }

    success('Database is up to date.');
  }
}

(async () => {
  let err = false;
  for (const fn of [checkEnv, checkConnection, checkDatabaseVersion, applyMigration]) {
    try {
      await fn();
    } catch (e) {
      error(e.message);
      err = true;
    } finally {
      if (err) {
        process.exit(1);
      }
    }
  }
})();
