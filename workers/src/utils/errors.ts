/**
 * Custom error types with HTTP status codes
 */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: string = 'INTERNAL_ERROR'
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message = 'Unauthorized') {
    super(401, message, 'UNAUTHORIZED');
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends ApiError {
  constructor(message = 'Forbidden') {
    super(403, message, 'FORBIDDEN');
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends ApiError {
  constructor(message = 'Not Found') {
    super(404, message, 'NOT_FOUND');
    this.name = 'NotFoundError';
  }
}

export class RateLimitError extends ApiError {
  constructor(
    message = 'Rate limit exceeded',
    public readonly retryAfter: number = 60
  ) {
    super(429, message, 'RATE_LIMIT_EXCEEDED');
    this.name = 'RateLimitError';
  }
}

export class BadRequestError extends ApiError {
  constructor(message = 'Bad Request') {
    super(400, message, 'BAD_REQUEST');
    this.name = 'BadRequestError';
  }
}

export class ConflictError extends ApiError {
  constructor(message = 'Conflict') {
    super(409, message, 'CONFLICT');
    this.name = 'ConflictError';
  }
}

export class PayloadTooLargeError extends ApiError {
  constructor(message = 'Payload Too Large') {
    super(413, message, 'PAYLOAD_TOO_LARGE');
    this.name = 'PayloadTooLargeError';
  }
}
