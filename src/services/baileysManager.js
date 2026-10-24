import path from 'path';
import fs from 'fs';
import makeWASocket, {
  Browsers,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  downloadMediaMessage,
} from 'baileys';
import { Boom } from '@hapi/boom';
import axios from 'axios';
import QRCode from 'qrcode';
import chalk from 'chalk';
import P from 'pino';
import { HttpsProxyAgent } from 'https-proxy-agent';

import Instance from '../models/Instance.js';
import Message from '../models/Message.js';
import { getRandomProxy } from './proxyService.js';
import { saveMedia, MAX_MEDIA_BYTES } from './mediaService.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SESSIONS_DIR = path.resolve(process.cwd(), process.env.SESSIONS_DIR || './sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const logger = P({ level: 'silent' });

const KEEP_ALIVE_INTERVAL = 5 * 60 * 1000; // 5 minutes
const GROUP_NAME_TTL = 10 * 60 * 1000; // cache group names for 10 minutes
const GROUP_LIST_TTL = 30 * 1000; // cache the full group list for 30 seconds (WhatsApp rate-limits this call)

// live in-memory registry: instanceId -> { sock, io, keepAliveInterval, groupCache, groupListCache }
const active = new Map();

function room(instanceId) {
  return `instance:${instanceId}`;
}

// ---------------------------------------------------------------------------------------
// Message parsing helpers
// ---------------------------------------------------------------------------------------

// Strips the common wrappers (disappearing messages, view-once, document-with-caption).
function unwrapMessage(message) {
  let current = message;

  while (current) {
    if (current.ephemeralMessage?.message) current = current.ephemeralMessage.message;
    else if (current.viewOnceMessage?.message) current = current.viewOnceMessage.message;
    else if (current.viewOnceMessageV2?.message) current = current.viewOnceMessageV2.message;
    else if (current.viewOnceMessageV2Extension?.message) current = current.viewOnceMessageV2Extension.message;
    else if (current.documentWithCaptionMessage?.message) current = current.documentWithCaptionMessage.message;
    else break;
  }

  return current || {};
}

// expects an already-unwrapped message
function extractMessageText(message) {
  if (!message) return null;
  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  if (message.imageMessage?.caption) return message.imageMessage.caption;
  if (message.videoMessage?.caption) return message.videoMessage.caption;
  if (message.documentMessage?.caption) return message.documentMessage.caption;
  if (message.buttonsResponseMessage?.selectedButtonId) return message.buttonsResponseMessage.selectedButtonId;
  if (message.listResponseMessage?.singleSelectReply?.selectedRowId)
    return message.listResponseMessage.singleSelectReply.selectedRowId;
  return null;
}

function toNumber(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Metadata only - does NOT download the file.
function getMediaInfo(content) {
  if (!content) return null;

  for (const key of ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage']) {
    const item = content[key];
    if (!item) continue;

    return {
      kind: key.replace('Message', ''),
      mimeType: item.mimetype || null,
      fileName: item.fileName || null,
      caption: item.caption || null,
      size: toNumber(item.fileLength),
      sha256: item.fileSha256 ? Buffer.from(item.fileSha256).toString('base64') : null,
    };
  }

  return null;
}

function getMessageType(content) {
  const ignore = new Set(['messageContextInfo', 'senderKeyDistributionMessage']);
  return Object.keys(content || {}).find((k) => !ignore.has(k)) || null;
}

// contextInfo (quoted message data) lives inside whichever message type was sent
function getContextInfo(content) {
  for (const value of Object.values(content || {})) {
    if (value && typeof value === 'object' && value.contextInfo) return value.contextInfo;
  }
  return null;
}

function buildQuotedMessage(content) {
  const ctx = getContextInfo(content);
  if (!ctx?.stanzaId) return null;

  const quoted = ctx.quotedMessage ? unwrapMessage(ctx.quotedMessage) : null;
  return {
    messageId: ctx.stanzaId,
    participant: ctx.participant || null,
    text: quoted ? extractMessageText(quoted) : null,
    mediaType: quoted ? getMediaInfo(quoted)?.kind || null : null,
  };
}

// WhatsApp increasingly sends messages with a "LID" (Linked ID) instead of the real phone
// number, e.g. remoteJid "259910650560760@lid" instead of "919876543210@s.whatsapp.net" -
// this is a privacy feature on WhatsApp's side, not a bug. Baileys exposes the real
// phone-number JID (when it knows it) via remoteJidAlt (DMs) / participantAlt (groups) on the
// message key. If that's missing, we fall back to Baileys' own LID<->PN mapping store. Some
// LIDs genuinely have no known phone-number mapping yet (WhatsApp only reveals it on demand,
// e.g. via a business's { requestPhoneNumber: true } message) - in that case we return the LID
// itself with isLid: true so callers/webhooks can tell the difference.
async function resolveSender(msg, isGroup, sock) {
  let jid;

  if (isGroup) {
    // our own messages in a group carry no participant - the sender is us
    jid = msg.key.participant || (msg.key.fromMe ? sock.user?.id : null) || msg.key.remoteJid;
  } else {
    jid = msg.key.remoteJid;
  }

  const altJid = isGroup ? msg.key.participantAlt : msg.key.remoteJidAlt;

  if (jid?.endsWith('@lid') && altJid) {
    jid = altJid;
  }

  if (jid?.endsWith('@lid')) {
    try {
      const pn = await sock.signalRepository?.lidMapping?.getPNForLID(jid);
      if (pn) jid = pn;
    } catch (_) {
      // no known mapping yet - fall through with the LID as-is
    }
  }

  const isLid = !!jid?.endsWith('@lid');
  // strip the ":device" suffix that our own JID can carry
  const number = (jid || '').split('@')[0].split(':')[0];
  return { number, isLid, jid: jid || null };
}

// ---------------------------------------------------------------------------------------
// Group helpers
// ---------------------------------------------------------------------------------------

async function getGroupName(entry, groupJid) {
  const cached = entry.groupCache.get(groupJid);
  if (cached && Date.now() - cached.fetchedAt < GROUP_NAME_TTL) return cached.subject;

  try {
    const metadata = await entry.sock.groupMetadata(groupJid);
    const subject = metadata.subject || null;
    entry.groupCache.set(groupJid, { subject, fetchedAt: Date.now() });
    return subject;
  } catch (err) {
    console.warn(chalk.yellow(`[baileysManager] could not resolve group name for ${groupJid}: ${err.message}`));
    return cached?.subject ?? null;
  }
}

// Lists every group the connected number participates in.
export async function listGroups(instanceId, { force = false } = {}) {
  const entry = active.get(instanceId);
  if (!entry) throw new Error('Instance is not connected');

  if (!force && entry.groupListCache && Date.now() - entry.groupListCache.fetchedAt < GROUP_LIST_TTL) {
    return entry.groupListCache.groups;
  }

  const raw = await entry.sock.groupFetchAllParticipating();

  const groups = Object.values(raw)
    .map((g) => {
      entry.groupCache.set(g.id, { subject: g.subject || null, fetchedAt: Date.now() });
      return {
        id: g.id,
        name: g.subject || 'Unnamed group',
        participantsCount: g.participants?.length ?? null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  entry.groupListCache = { groups, fetchedAt: Date.now() };
  return groups;
}

// ---------------------------------------------------------------------------------------
// Media helper
// ---------------------------------------------------------------------------------------

// Downloads + stores the file. Never throws - a failure is recorded on the media object so
// the message itself is still saved and delivered.
async function processMedia(msg, sock, instanceId, info) {
  const base = { ...info, url: null, storedName: null, status: 'failed', error: null };

  if (info.size && info.size > MAX_MEDIA_BYTES) {
    return { ...base, status: 'skipped', error: `File is larger than the ${MAX_MEDIA_BYTES / 1024 / 1024} MB limit` };
  }

  try {
    const buffer = await downloadMediaMessage(
      msg,
      'buffer',
      {},
      { logger, reuploadRequest: sock.updateMediaMessage }
    );

    if (buffer.length > MAX_MEDIA_BYTES) {
      return { ...base, status: 'skipped', error: `File is larger than the ${MAX_MEDIA_BYTES / 1024 / 1024} MB limit` };
    }

    const saved = await saveMedia(instanceId, buffer, { mimeType: info.mimeType, fileName: info.fileName });
    return { ...info, size: buffer.length, url: saved.url, storedName: saved.storedName, status: 'stored', error: null };
  } catch (err) {
    console.error(chalk.red(`[baileysManager] media download failed for instance ${instanceId}:`), err.message);
    return { ...base, error: err.message };
  }
}

// The DB uses `kind`; the webhook exposes it as `type`.
function mediaForWebhook(media) {
  if (!media) return null;
  const { kind, ...rest } = media;
  return { type: kind, ...rest };
}

// ---------------------------------------------------------------------------------------
// Webhook / status
// ---------------------------------------------------------------------------------------

async function postToWebhook(instanceDoc, payload) {
  if (!instanceDoc.webhookUrl) return false;
  try {
    await axios.post(instanceDoc.webhookUrl, payload, {
      headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': instanceDoc.webhookSecret || '' },
      timeout: 10_000,
    });
    return true;
  } catch (err) {
    console.error(chalk.red(`[webhook] delivery failed for instance ${instanceDoc._id}:`), err.message);
    return false;
  }
}

async function updateStatus(instanceId, io, status, extra = {}) {
  await Instance.findByIdAndUpdate(instanceId, { status, ...extra });
  io.to(room(instanceId)).emit('status', { instanceId, status, ...extra });
}

// Periodically pings WhatsApp's servers over the existing socket so idle connections
// aren't silently dropped by network middleboxes/load balancers during long quiet periods.
// This does NOT replace Baileys' own reconnect logic - it just keeps a healthy socket busy.
function startKeepAlive(instanceId, sock) {
  const keepAliveInterval = setInterval(async () => {
    if (!active.has(instanceId)) {
      clearInterval(keepAliveInterval);
      return;
    }
    try {
      await sock.query({
        tag: 'iq',
        attrs: { type: 'get', xmlns: 'urn:xmpp:ping', id: `keep-alive-${Date.now()}` },
      });
      console.log(chalk.blue(`[keep-alive] ping sent for instance ${instanceId}`));
    } catch (err) {
      console.warn(chalk.yellow(`[keep-alive] ping failed for ${instanceId}: ${err.message}`));
    }
  }, KEEP_ALIVE_INTERVAL);

  return keepAliveInterval;
}

// ---------------------------------------------------------------------------------------
// Instance lifecycle
// ---------------------------------------------------------------------------------------

export async function startInstance(instanceId, io) {
  if (active.has(instanceId)) return active.get(instanceId).sock;

  const instanceDoc = await Instance.findById(instanceId);
  if (!instanceDoc) throw new Error('Instance not found');

  const sessionPath = path.join(SESSIONS_DIR, instanceId);
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const { version } = await fetchLatestBaileysVersion();

  const socketOptions = {
    version,
    auth: state,
    logger,
    browser: Browsers.ubuntu('Chrome'),
    printQRInTerminal: false,
  };

  // best-effort free-proxy support for Baileys' outgoing HTTP calls (media upload/download, etc)
  if (instanceDoc.useProxy) {
    const proxyUrl = instanceDoc.proxyUrl || getRandomProxy();
    if (proxyUrl) {
      socketOptions.agent = new HttpsProxyAgent(proxyUrl);
      socketOptions.fetchAgent = new HttpsProxyAgent(proxyUrl);
      if (proxyUrl !== instanceDoc.proxyUrl) await Instance.findByIdAndUpdate(instanceId, { proxyUrl });
    } else {
      console.warn(chalk.yellow(`[baileysManager] useProxy set for ${instanceId} but no working proxy is available`));
    }
  }

  const sock = makeWASocket(socketOptions);
  const keepAliveInterval = startKeepAlive(instanceId, sock);
  const entry = { sock, io, keepAliveInterval, groupCache: new Map(), groupListCache: null };
  active.set(instanceId, entry);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const qrDataUrl = await QRCode.toDataURL(qr);
      await updateStatus(instanceId, io, 'qr_pending');
      io.to(room(instanceId)).emit('qr', { instanceId, qr: qrDataUrl });
    }

    if (connection === 'connecting') {
      await updateStatus(instanceId, io, 'connecting');
    }

    if (connection === 'open') {
      const meNumber = sock.user?.id?.split(':')[0] || null;
      const mePushName = sock.user?.name || null;
      await Instance.findByIdAndUpdate(instanceId, {
        status: 'connected',
        phoneNumber: meNumber,
        pushName: mePushName,
        lastConnectedAt: new Date(),
        lastDisconnectReason: null,
      });
      io.to(room(instanceId)).emit('status', { instanceId, status: 'connected', phoneNumber: meNumber, pushName: mePushName });
      console.log(chalk.green(`✅ Instance ${instanceId} connected as ${meNumber}`));
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error instanceof Boom ? lastDisconnect.error.output.statusCode : undefined;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      const reason = lastDisconnect?.error?.message || 'unknown';

      const current = active.get(instanceId);
      if (current?.keepAliveInterval) clearInterval(current.keepAliveInterval);
      active.delete(instanceId);

      if (loggedOut) {
        await Instance.findByIdAndUpdate(instanceId, { status: 'logged_out', lastDisconnectReason: reason });
        io.to(room(instanceId)).emit('status', { instanceId, status: 'logged_out', reason });
        fs.rmSync(sessionPath, { recursive: true, force: true });
        console.log(chalk.red(`⛔ Instance ${instanceId} logged out: ${reason}`));
      } else {
        await Instance.findByIdAndUpdate(instanceId, { status: 'disconnected', lastDisconnectReason: reason });
        io.to(room(instanceId)).emit('status', { instanceId, status: 'disconnected', reason });
        console.log(chalk.yellow(`⚠️  Instance ${instanceId} disconnected: ${reason} - reconnecting in 3s`));
        await wait(3000);
        startInstance(instanceId, io).catch((err) =>
          console.error(chalk.red(`[baileysManager] reconnect failed for ${instanceId}:`), err.message)
        );
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // keep the cached group names fresh when someone renames a group
  sock.ev.on('groups.update', (updates) => {
    for (const u of updates) {
      if (u.id && u.subject) {
        entry.groupCache.set(u.id, { subject: u.subject, fetchedAt: Date.now() });
        entry.groupListCache = null;
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    const instanceNow = await Instance.findById(instanceId);
    if (!instanceNow) return;

    const selectedGroups = new Set(instanceNow.selectedGroupIds || []);

    for (const msg of messages) {
      try {
        if (!msg.message) continue;

        const remoteJid = msg.key.remoteJid || '';
        if (!remoteJid || remoteJid === 'status@broadcast' || remoteJid.endsWith('@newsletter')) continue;

        const isGroup = remoteJid.endsWith('@g.us');
        const fromMe = !!msg.key.fromMe;
        const direction = fromMe ? 'out' : 'in';

        // Groups: master toggle must be on AND this specific group must be selected
        if (isGroup) {
          if (!instanceNow.includeGroupMessages) continue;
          if (!selectedGroups.has(remoteJid)) continue;
        }

        // Skip our own outgoing messages unless this instance has opted in
        if (fromMe && !instanceNow.includeOwnMessages) continue;

        const content = unwrapMessage(msg.message);
        const text = extractMessageText(content);
        const mediaInfo = getMediaInfo(content);

        // Keep media-only messages; skip protocol/system messages that have neither text nor media
        if (text === null && !mediaInfo) continue;

        // WhatsApp can re-deliver messages after a reconnect - don't record/forward them twice
        if (msg.key.id && (await Message.exists({ instance: instanceId, messageId: msg.key.id, direction }))) continue;

        const { number, isLid, jid: senderJid } = await resolveSender(msg, isGroup, sock);
        if (isLid) {
          console.warn(
            chalk.yellow(`[baileysManager] instance ${instanceId}: no phone number mapping for LID ${senderJid} yet - using LID as-is`)
          );
        }

        const groupName = isGroup ? await getGroupName(entry, remoteJid) : null;
        const quotedMessage = buildQuotedMessage(content);
        const media = mediaInfo ? await processMedia(msg, sock, instanceId, mediaInfo) : null;
        const rawMessageType = getMessageType(content);

        const doc = await Message.create({
          instance: instanceId,
          direction,
          number,
          isLid,
          senderJid,
          message: text || '',
          isGroup,
          groupId: isGroup ? remoteJid : null,
          groupName,
          pushName: msg.pushName || null,
          messageId: msg.key.id,
          rawMessageType,
          media,
          quotedMessage,
          waTimestamp: new Date((Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000)) * 1000),
        });

        io.to(room(instanceId)).emit('message', {
          instanceId,
          direction,
          number,
          isLid,
          message: text || '',
          isGroup,
          groupId: isGroup ? remoteJid : null,
          groupName,
          pushName: msg.pushName || null,
          media,
          quotedMessage,
          timestamp: doc.waTimestamp,
        });

        const delivered = await postToWebhook(instanceNow, {
          event: 'whatsapp.message.received',
          instanceId,
          instanceName: instanceNow.name,
          messageId: msg.key.id,
          direction,
          timestamp: doc.waTimestamp,

          message: text || '',
          messageType: rawMessageType,

          // flat fields kept so existing webhook consumers keep working
          number,
          isLid,
          isGroup,
          groupId: isGroup ? remoteJid.split('@')[0] : null,
          pushName: msg.pushName || null,

          // richer structured fields
          sender: {
            name: msg.pushName || null,
            number,
            jid: senderJid,
            isLid,
          },
          group: isGroup ? { id: remoteJid, name: groupName } : null,
          media: mediaForWebhook(media),
          quotedMessage,
        });

        await Message.findByIdAndUpdate(doc._id, { webhookDelivered: delivered, $inc: { webhookAttempts: 1 } });
      } catch (err) {
        console.error(chalk.red(`[baileysManager] error processing message for ${instanceId}:`), err);
      }
    }
  });

  return sock;
}

export async function stopInstance(instanceId, { wipeSession = false } = {}) {
  const entry = active.get(instanceId);
  if (entry) {
    if (entry.keepAliveInterval) {
      clearInterval(entry.keepAliveInterval);
    }
    try {
      await entry.sock.logout();
    } catch (_) {
      // socket may already be dead; ignore
    }
    active.delete(instanceId);
  }
  if (wipeSession) {
    const sessionPath = path.join(SESSIONS_DIR, instanceId);
    fs.rmSync(sessionPath, { recursive: true, force: true });
  }
}

function toJid(toNumber) {
  return toNumber.includes('@') ? toNumber : `${toNumber}@s.whatsapp.net`;
}

export function sendText(instanceId, toNumber, text) {
  const entry = active.get(instanceId);
  if (!entry) throw new Error('Instance is not connected');
  return entry.sock.sendMessage(toJid(toNumber), { text });
}

// Generic sender used by the public API - `content` is a Baileys message content object,
// e.g. { text }, { image: { url }, caption }, { video: { url }, caption }, { document: { url }, mimetype, fileName }.
export function sendContent(instanceId, toNumber, content) {
  const entry = active.get(instanceId);
  if (!entry) throw new Error('Instance is not connected');
  return entry.sock.sendMessage(toJid(toNumber), content);
}

export function isActive(instanceId) {
  return active.has(instanceId);
}