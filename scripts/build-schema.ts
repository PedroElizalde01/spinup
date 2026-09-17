// Writes schema/spinup.schema.json from the runtime Zod schema, so editor completion
// and validation describe exactly what spinup accepts. A test fails if the committed
// file drifts. Usage: bun run scripts/build-schema.ts [--check]

import { zodToJsonSchema } from "zod-to-json-schema";

import { configSchema, SCHEMA_URL } from "../src/core/config.ts";

export function renderSchema(): string {
  const schema = zodToJsonSchema(configSchema, { target: "jsonSchema7", $refStrategy: "none" }) as Record<string, unknown>;

  return `${JSON.stringify(
    {
      $schema: "http://json-schema.org/draft-07/schema#",
      $id: SCHEMA_URL,
      title: "spinup project configuration (.spinup.yml)",
      description:
        "Dependency cycles, unknown dependencies, duplicate service names and the default action existing are checked by spinup itself; run `spinup --doctor`.",
      ...Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "$schema")),
    },
    null,
    2,
  )}\n`;
}

if (import.meta.main) {
  const target = new URL("../schema/spinup.schema.json", import.meta.url).pathname;
  const rendered = renderSchema();

  if (process.argv.includes("--check")) {
    if ((await Bun.file(target).text()) !== rendered) {
      console.error("schema/spinup.schema.json is out of date; run: bun run scripts/build-schema.ts");
      process.exit(1);
    }
  } else {
    await Bun.write(target, rendered);
    console.log(`wrote ${target}`);
  }
}
