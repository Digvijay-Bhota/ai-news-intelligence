/**
 * Request Validation Utilities
 */

import { BadRequestError } from '../utils/errors';

export function requireString(
  value: unknown,
  field: string,
  maxLength: number = 1000
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestError(`${field} is required`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new BadRequestError(`${field} must be at most ${maxLength} characters`);
  }
  return trimmed;
}

export function requireNumber(
  value: unknown,
  field: string
): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = parseFloat(value);
    if (!isNaN(parsed)) return parsed;
  }
  throw new BadRequestError(`${field} must be a number`);
}

export function optionalString(value: unknown, maxLength: number = 1000): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > maxLength) {
    throw new BadRequestError(`Field must be at most ${maxLength} characters`);
  }
  return trimmed;
}

export function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = parseFloat(value);
    if (!isNaN(parsed)) return parsed;
  }
  return undefined;
}
