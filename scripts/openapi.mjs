// Writes docs/openapi.json, the Hub API description, from the shared schemas (run after `npm run build`).
import { writeFileSync } from "node:fs";
import { API_DOC_VERSION, openApiDocument } from "../packages/hub/dist/index.js";

const file = new URL("../docs/openapi.json", import.meta.url);
writeFileSync(file, `${JSON.stringify(openApiDocument(API_DOC_VERSION), null, 2)}\n`);
console.log(`wrote ${file.pathname}`);
