import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function requireValue(ok, message, status = 400) {
  if (!ok) throw new HttpError(status, message);
}
export const digest = value => createHash('sha256').update(value).digest('hex');
export const secret = () => randomBytes(32).toString('base64url');
export function text(value, label, max = 120) {
  requireValue(typeof value === 'string' && value.trim().length > 0 && value.length <= max, `${label}不能为空，且不能超过 ${max} 个字符`);
  return value.trim();
}
export function username(value) {
  requireValue(typeof value === 'string' && /^[a-zA-Z0-9_.-]{3,40}$/.test(value), '账号须为 3–40 位字母、数字、点、横线或下划线');
  return value.toLowerCase();
}
export function password(value) {
  requireValue(typeof value === 'string' && value.length >= 12 && value.length <= 128, '密码须为 12–128 个字符');
  return value;
}
export async function hashPassword(value) {
  password(value);
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(value, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `${salt}:${hash.toString('hex')}`;
}
export async function verifyPassword(value, encoded) {
  if (typeof value !== 'string' || value.length > 128) return false;
  const [salt, expected] = encoded.split(':');
  const actual = await scrypt(value, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const target = Buffer.from(expected, 'hex');
  return target.length === actual.length && timingSafeEqual(target, actual);
}
export const publicUser = row => ({ id: row.id, username: row.username, name: row.name, role: row.role, active: Boolean(row.active) });
