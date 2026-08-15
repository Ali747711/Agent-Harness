import { z } from 'zod';

import { HarnessError } from '../errors/index.ts';
import { PermissionChoiceSchema } from './types.ts';

/** Client → core commands (PHASE1-PLAN.md §4.6). */
const PromptSchema = z.strictObject({
  type: z.literal('prompt'),
  text: z.string().min(1)
});

/** Queued mid-run; injected at the next safe boundary (R7). */
const SteerSchema = z.strictObject({
  type: z.literal('steer'),
  text: z.string().min(1)
});

const InterruptSchema = z.strictObject({
  type: z.literal('interrupt')
});

const PermissionResponseSchema = z.strictObject({
  type: z.literal('permission_response'),
  requestId: z.string(),
  choice: PermissionChoiceSchema
});

const ShutdownSchema = z.strictObject({
  type: z.literal('shutdown')
});

export const ClientCommandSchema = z.discriminatedUnion('type', [
  PromptSchema,
  SteerSchema,
  InterruptSchema,
  PermissionResponseSchema,
  ShutdownSchema
]);

export type ClientCommand = z.infer<typeof ClientCommandSchema>;
export type ClientCommandType = ClientCommand['type'];

export function parseClientCommand(value: unknown): ClientCommand {
  const result = ClientCommandSchema.safeParse(value);
  if (!result.success) {
    throw new HarnessError('protocol_invalid', 'invalid ClientCommand', {
      details: result.error.issues
    });
  }
  return result.data;
}
