import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

/**
 * Errors the API raises on purpose. `retryable` is part of the response so the
 * upload client's retry loop can read it instead of guessing from status codes.
 */
export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;

  constructor(
    status: number,
    code: string,
    message: string,
    options: { retryable?: boolean } = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

export const badRequest = (code: string, message: string) => new AppError(400, code, message);
export const unauthorized = (message = 'Sign in to continue.') =>
  new AppError(401, 'UNAUTHENTICATED', message);
export const forbidden = (message = 'You do not have access to this.') =>
  new AppError(403, 'FORBIDDEN', message);
export const notFound = (message = 'Not found.') => new AppError(404, 'NOT_FOUND', message);
export const conflict = (code: string, message: string) => new AppError(409, code, message);

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof AppError) {
      return reply
        .code(error.status)
        .send({ error: { code: error.code, message: error.message, retryable: error.retryable } });
    }

    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: 'INVALID_REQUEST',
          message: 'The request body or query is not valid.',
          retryable: false,
          fields: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      });
    }

    // Fastify raises these itself, for example when the rate limit is hit.
    const fastifyError = error as { statusCode?: number; code?: string; message?: string };
    if (typeof fastifyError.statusCode === 'number' && fastifyError.statusCode < 500) {
      return reply.code(fastifyError.statusCode).send({
        error: {
          code: fastifyError.code ?? 'REQUEST_REJECTED',
          message: fastifyError.message ?? 'Request rejected.',
          retryable: false,
        },
      });
    }

    // Anything unrecognised is a bug. Log it in full, tell the caller nothing.
    request.log.error({ err: error }, 'unhandled error');
    return reply.code(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.', retryable: true },
    });
  });
}
