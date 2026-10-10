// `output: "standalone"` doesn't include static assets; copy them next to server.js.
import { cpSync, existsSync } from "node:fs";

const target = ".next/standalone/packages/dashboard";
cpSync(".next/static", `${target}/.next/static`, { recursive: true });
if (existsSync("public")) cpSync("public", `${target}/public`, { recursive: true });
