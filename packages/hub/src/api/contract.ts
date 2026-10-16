import type { z } from "zod";
import type { NodeSchema, PlanSchema, TaskSchema } from "@aso/shared";
import type { PlanRecord } from "../plans.js";
import type { NodeRegistry } from "../registry.js";
import type { TaskRecord } from "../tasks.js";

/*
 * Compile-time checks that the API description (`@aso/shared` api.ts) names every field the Hub
 * puts in its answers: a field added to a record without describing it fails the build here.
 * (Tests check the values; this catches fields no test happens to produce.)
 */
type Undescribed<Row, Schema extends z.ZodType> = Exclude<keyof Row, keyof z.infer<Schema>>;
type Described<Missing> = [Missing] extends [never] ? true : { undescribed: Missing };

// Exported only so the compiler checks them; nothing reads these values.
export const taskFieldsDescribed: Described<Undescribed<TaskRecord, typeof TaskSchema>> = true;
export const planFieldsDescribed: Described<Undescribed<PlanRecord, typeof PlanSchema>> = true;
export const nodeFieldsDescribed: Described<Undescribed<ReturnType<NodeRegistry["view"]>, typeof NodeSchema>> = true;
