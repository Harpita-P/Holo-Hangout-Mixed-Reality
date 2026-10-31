import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export type PlatformTokenKind = 'dashboard' | 'oauth' | 'world';

export interface PlatformTokenPayload {
  kind: PlatformTokenKind;
  subject: string;
  worldId?: string;
  nonce?: string;
  expiresAt: number;
}

export function createPlatformToken(
  payload: Omit<PlatformTokenPayload, 'expiresAt'>,
  secret: string,
  lifetimeMs: number,
  now = Date.now(),
): string {
  const encoded = Buffer.from(JSON.stringify({ ...payload, expiresAt: now + lifetimeMs }))
    .toString('base64url');
  return `${encoded}.${signature(encoded, secret)}`;
}

export function verifyPlatformToken(
  value: string | undefined,
  secret: string,
  expectedKind: PlatformTokenKind,
  now = Date.now(),
): PlatformTokenPayload | null {
  if (!value) return null;
  const separator = value.lastIndexOf('.');
  if (separator <= 0) return null;
  const encoded = value.slice(0, separator);
  const provided = value.slice(separator + 1);
  const expected = signature(encoded, secret);
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as PlatformTokenPayload;
    if (
      payload.kind !== expectedKind ||
      typeof payload.subject !== 'string' ||
      !payload.subject ||
      typeof payload.expiresAt !== 'number' ||
      payload.expiresAt <= now
    ) return null;
    return payload;
  } catch {
    return null;
  }
}

export function createCsrfToken(subject: string, secret: string): string {
  return createHmac('sha256', secret).update(`csrf:${subject}`).digest('base64url');
}

export function safeEqual(left: string | undefined, right: string): boolean {
  if (!left) return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function randomIdentifier(bytes = 18): string {
  return randomBytes(bytes).toString('base64url');
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const pair of (header ?? '').split(';')) {
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    const key = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (key) cookies.set(key, decodeURIComponent(value));
  }
  return cookies;
}

function signature(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}
