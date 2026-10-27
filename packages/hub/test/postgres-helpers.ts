import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { after } from "node:test";
import pg from "pg";

/**
 * A PostgreSQL server for tests: the one in ASO_TEST_DATABASE_URL (a URL whose user may create
 * databases), else a throwaway postgres:17-alpine container for this test file, removed when it
 * ends. Undefined (the tests skip) when there is neither.
 */
let server: Promise<string | undefined> | undefined;

function startContainer(): string | undefined {
  try {
    execFileSync("docker", ["version"], { stdio: "ignore" });
  } catch {
    return undefined;
  }
  const name = `aso-test-pg-${process.pid}-${randomBytes(3).toString("hex")}`;
  // Made for this run only, so no credential is ever written in the repository.
  const password = randomBytes(12).toString("hex");
  try {
    execFileSync("docker", ["run", "-d", "--rm", "--name", name, "--label", "aso-test=1", "-e", `POSTGRES_PASSWORD=${password}`, "-p", "127.0.0.1::5432", "postgres:17-alpine"], { stdio: "ignore" });
  } catch {
    return undefined; // e.g. no image and no network to pull it
  }
  after(() => {
    try {
      execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    } catch {
      // already gone
    }
  });
  const port = execFileSync("docker", ["port", name, "5432/tcp"], { encoding: "utf8" }).trim().split("\n")[0].split(":").at(-1);
  return databaseUrl({ user: "postgres", password, host: "127.0.0.1", port: Number(port), database: "postgres" });
}

async function ready(url: string): Promise<string> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      await client.query("SELECT 1");
      return url;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 300));
    } finally {
      await client.end().catch(() => undefined);
    }
  }
}

/** A connection URL built from its parts (tests never spell one out with a password in it). */
export function databaseUrl(parts: { user: string; password: string; host: string; port: number; database: string }): string {
  const url = new URL("postgres://placeholder");
  url.username = parts.user;
  url.password = parts.password;
  url.hostname = parts.host;
  url.port = String(parts.port);
  url.pathname = `/${parts.database}`;
  return url.toString();
}

/** The test server's admin URL, or undefined when there is none. */
export function testDatabaseServer(): Promise<string | undefined> {
  server ??= (async () => {
    const url = process.env.ASO_TEST_DATABASE_URL || startContainer();
    return url ? ready(url) : undefined;
  })();
  return server;
}

/** A new, empty database on the test server, for one test. */
export async function freshDatabase(): Promise<string> {
  const admin = await testDatabaseServer();
  if (!admin) throw new Error("no test database server");
  const name = `aso_test_${randomBytes(6).toString("hex")}`;
  const client = new pg.Client({ connectionString: admin });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE ${name}`);
  } finally {
    await client.end();
  }
  const url = new URL(admin);
  url.pathname = `/${name}`;
  return url.toString();
}

/** Run SQL against a test database directly (to look at what the Hub wrote). */
export async function sql<T extends pg.QueryResultRow = Record<string, unknown>>(url: string, text: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(text, params)).rows;
  } finally {
    await client.end();
  }
}

/** Skip reason for Postgres tests when no server is available. */
export async function postgresSkip(): Promise<string | false> {
  return (await testDatabaseServer()) ? false : "no PostgreSQL for tests: set ASO_TEST_DATABASE_URL or install Docker";
}
