import { defineConfig } from "drizzle-kit";
import * as dotenv from "dotenv";

// Load environment variables from .env file.
dotenv.config({ override: true });

let urlHost = "";
let urlPort = 0;
let urlDb = "";
let urlUser = "";
let urlPassword = "";

if (process.env.DATABASE_URL) {
  try {
    const u = new URL(process.env.DATABASE_URL);
    urlHost = u.hostname === "72.62.158.128" ? "127.0.0.1" : u.hostname;
    urlPort = Number(u.port || 5432);
    urlDb = decodeURIComponent(u.pathname.replace(/^\//, ""));
    urlUser = decodeURIComponent(u.username || "");
    urlPassword = decodeURIComponent(u.password || "");
  } catch (_e) {}
}

const rawHost = process.env.SQL_HOST || process.env.DB_HOST || urlHost || "127.0.0.1";
const sqlHost = rawHost.trim() === "72.62.158.128" ? "127.0.0.1" : rawHost.trim();
const sqlPort = Number(process.env.DB_PORT || urlPort || 5432);
const sqlDbName = process.env.SQL_DB_NAME || process.env.DB_NAME || urlDb;
const user = process.env.SQL_ADMIN_USER || process.env.DB_USER || urlUser;
const password = process.env.SQL_ADMIN_PASSWORD || process.env.DB_PASSWORD || urlPassword;

if (!sqlDbName) {
  throw new Error("SQL_DB_NAME, DB_NAME, or DATABASE_URL must be set in environment variables.");
}
if (!user) {
  throw new Error("SQL_ADMIN_USER, DB_USER, or DATABASE_URL must be set in environment variables.");
}
if (!password) {
  throw new Error("SQL_ADMIN_PASSWORD, DB_PASSWORD, or DATABASE_URL must be set in environment variables.");
}
console.log(`Using user: ${user} to connect to database ${sqlDbName} at ${sqlHost}:${sqlPort} (ssl: false).`);

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  schemaFilter: ["public"],
  dbCredentials: {
    host: sqlHost,
    port: sqlPort,
    user: user,
    password: password,
    database: sqlDbName,
    ssl: false,
  },
  verbose: true,
});
