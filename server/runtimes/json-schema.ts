import { z } from "zod";

type JsonSchema = Record<string, unknown>;

export function zodShapeToJsonSchema(shape: z.ZodRawShape): JsonSchema {
  // io: "input" treats .default() fields as optional, matching how the
  // runtimes call tools (defaults are applied by the zod parser on our side).
  const json = z.toJSONSchema(z.object(shape), { io: "input" }) as JsonSchema;
  delete json.$schema;
  return { ...json, additionalProperties: false };
}
