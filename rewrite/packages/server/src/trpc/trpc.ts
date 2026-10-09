/** tRPC initialization: one builder, shared by every procedure file. */

import { initTRPC } from '@trpc/server';
import type { Context } from './context.js';

/**
 * Nothing internal reaches the client.
 *
 * Without a formatter tRPC echoes every error's message -- which, coming out of
 * DuckDB, can carry column names, expected formats and even table values -- and
 * includes a stack trace whenever `NODE_ENV` is not `production`, which the `dev`
 * script does not set. A refused input still describes itself, since that message
 * is the compiler's own and is meant to be read.
 */
const t = initTRPC.context<Context>().create({
  errorFormatter({ shape, error }) {
    const { stack: _stack, ...data } = shape.data as typeof shape.data & { stack?: string };
    return {
      ...shape,
      message: error.code === 'INTERNAL_SERVER_ERROR' ? 'internal server error' : shape.message,
      data,
    };
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;
export const createCallerFactory = t.createCallerFactory;
