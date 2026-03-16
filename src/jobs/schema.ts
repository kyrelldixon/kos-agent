import { z } from "zod";

const CalendarDictSchema = z
  .object({
    Month: z.number().int(),
    Day: z.number().int(),
    Weekday: z.number().int(),
    Hour: z.number().int(),
    Minute: z.number().int(),
  })
  .partial();

const PeriodicScheduleSchema = z.object({
  type: z.literal("periodic"),
  seconds: z.number().int().positive(),
});

const ScheduledScheduleSchema = z.object({
  type: z.literal("scheduled"),
  calendar: z.union([CalendarDictSchema, z.array(CalendarDictSchema)]),
});

export const JobScheduleSchema = z.discriminatedUnion("type", [
  PeriodicScheduleSchema,
  ScheduledScheduleSchema,
]);

export const JobExecutionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("script") }),
  z.object({ type: z.literal("agent"), prompt: z.string().min(1) }),
]);

export const JobDestinationSchema = z.object({
  chatId: z.string(),
  threadId: z.string().optional(),
});

export const JobConfigSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]*$/)
    .max(64),
  schedule: JobScheduleSchema,
  execution: JobExecutionSchema,
  destination: JobDestinationSchema,
  disabled: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type JobConfig = z.infer<typeof JobConfigSchema>;
export type JobSchedule = z.infer<typeof JobScheduleSchema>;
export type JobExecution = z.infer<typeof JobExecutionSchema>;
export type JobDestination = z.infer<typeof JobDestinationSchema>;

export const JobCreateSchema = z.object({
  name: JobConfigSchema.shape.name,
  schedule: JobScheduleSchema,
  execution: JobExecutionSchema,
  destination: JobDestinationSchema,
});

export type JobCreateInput = z.infer<typeof JobCreateSchema>;

export const JobUpdateSchema = z
  .object({
    disabled: z.boolean().optional(),
    schedule: JobScheduleSchema.optional(),
    destination: JobDestinationSchema.optional(),
    prompt: z.string().min(1).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

export type JobUpdateInput = z.infer<typeof JobUpdateSchema>;
