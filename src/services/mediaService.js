import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

export const MEDIA_DIR = path.resolve(process.cwd(), process.env.MEDIA_DIR || './media');
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

export const MAX_MEDIA_BYTES = (Number(process.env.MAX_MEDIA_MB) || 25) * 1024 * 1024;

const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');

let MEDIA_SECRET = process.env.MEDIA_SECRET || process.env.SESSION_SECRET;
if (!MEDIA_SECRET) {
  MEDIA_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn(
    '[mediaService] MEDIA_SECRET is not set - using a random one. Media links will stop working after a restart. Set MEDIA_SECRET in .env.'
  );
}
if (!PUBLIC_BASE_URL) {
  console.warn('[mediaService] PUBLIC_BASE_URL is not set - media URLs in webhooks will be relative (e.g. /media/...).');
}

const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'application/msword': 'doc',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

// never store anything a browser could execute
const BLOCKED_EXT = new Set(['html', 'htm', 'xhtml', 'svg', 'js', 'mjs', 'xml', 'php']);

function extFor(mimeType, fileName) {
  const mime = (mimeType || '').split(';')[0].trim().toLowerCase();
  if (MIME_EXT[mime]) return MIME_EXT[mime];

  const fromName = (fileName || '').split('.').pop()?.toLowerCase();
  if (fromName && /^[a-z0-9]{1,8}$/.test(fromName) && !BLOCKED_EXT.has(fromName)) return fromName;

  return 'bin';
}

function sign(instanceId, storedName) {
  return crypto.createHmac('sha256', MEDIA_SECRET).update(`${instanceId}/${storedName}`).digest('hex');
}

export function buildMediaUrl(instanceId, storedName) {
  return `${PUBLIC_BASE_URL}/media/${instanceId}/${storedName}?token=${sign(instanceId, storedName)}`;
}

export async function saveMedia(instanceId, buffer, { mimeType, fileName } = {}) {
  const dir = path.join(MEDIA_DIR, instanceId);
  await fs.promises.mkdir(dir, { recursive: true });

  // unguessable name, so a link can't be enumerated even without the signature
  const storedName = `${crypto.randomBytes(16).toString('hex')}.${extFor(mimeType, fileName)}`;
  await fs.promises.writeFile(path.join(dir, storedName), buffer);

  return { storedName, url: buildMediaUrl(instanceId, storedName) };
}

// Returns the absolute file path if the signature is valid and the file exists, otherwise null.
export function resolveMediaFile(instanceId, storedName, token) {
  if (!/^[a-f0-9]{24}$/.test(instanceId || '')) return null;
  if (!/^[a-f0-9]{32}\.[a-z0-9]{1,8}$/.test(storedName || '')) return null;
  if (typeof token !== 'string' || !token) return null;

  const expected = Buffer.from(sign(instanceId, storedName));
  const given = Buffer.from(token);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;

  const filePath = path.join(MEDIA_DIR, instanceId, storedName);
  return fs.existsSync(filePath) ? filePath : null;
}

export function removeInstanceMedia(instanceId) {
  if (!/^[a-f0-9]{24}$/.test(String(instanceId))) return;
  fs.rmSync(path.join(MEDIA_DIR, String(instanceId)), { recursive: true, force: true });
}