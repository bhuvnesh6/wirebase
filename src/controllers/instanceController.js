import crypto from 'crypto';
import Instance from '../models/Instance.js';
import Message from '../models/Message.js';
import User from '../models/User.js';
import * as baileysManager from '../services/baileysManager.js';
import { getPool } from '../services/proxyService.js';
import { removeInstanceMedia } from '../services/mediaService.js';

// Admin can see/manage every instance system-wide; a sub-admin only ever sees their own.
function scopeFilter(req) {
  if (req.role === 'admin') return {};
  return { ownerRole: 'subadmin', ownerId: req.ownerId };
}

function ownIdentity(req) {
  return { ownerRole: req.role, ownerId: req.role === 'admin' ? null : req.ownerId };
}

async function attachOwnerLabels(instances) {
  const subadminIds = instances.filter((i) => i.ownerRole === 'subadmin').map((i) => i.ownerId);
  const users = await User.find({ _id: { $in: subadminIds } });
  const byId = Object.fromEntries(users.map((u) => [u._id.toString(), u]));

  return instances.map((inst) => {
    const obj = inst.toObject();
    obj.ownerLabel = inst.ownerRole === 'admin' ? 'Admin' : byId[inst.ownerId?.toString()]?.email || 'Unknown sub-admin';
    return obj;
  });
}

export async function listInstances(req, res) {
  const instances = await Instance.find(scopeFilter(req)).sort({ createdAt: -1 });
  res.json({ instances: await attachOwnerLabels(instances) });
}

export async function createInstance(req, res) {
  const { name, useProxy } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  try {
    const instance = await Instance.create({
      ...ownIdentity(req),
      name,
      useProxy: !!useProxy,
      webhookSecret: crypto.randomBytes(16).toString('hex'),
    });
    res.status(201).json({ instance });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'You already have an instance with this name' });
    }
    throw err;
  }
}

async function findOwnedInstance(req) {
  return Instance.findOne({ _id: req.params.id, ...scopeFilter(req) });
}

export async function getInstance(req, res) {
  const instance = await findOwnedInstance(req);
  if (!instance) return res.status(404).json({ error: 'Instance not found' });
  res.json({ instance, connected: baileysManager.isActive(instance._id.toString()) });
}

export async function connectInstance(req, res) {
  const instance = await findOwnedInstance(req);
  if (!instance) return res.status(404).json({ error: 'Instance not found' });

  const io = req.app.get('io');
  try {
    await baileysManager.startInstance(instance._id.toString(), io);
    res.json({ message: 'Connection started, listen for QR / status over socket.io' });
  } catch (err) {
    console.error('connectInstance error:', err);
    res.status(500).json({ error: 'Failed to start instance' });
  }
}

export async function disconnectInstance(req, res) {
  const instance = await findOwnedInstance(req);
  if (!instance) return res.status(404).json({ error: 'Instance not found' });

  await baileysManager.stopInstance(instance._id.toString(), { wipeSession: true });
  instance.status = 'logged_out';
  instance.phoneNumber = null;
  await instance.save();

  res.json({ message: 'Instance disconnected and session cleared' });
}

export async function deleteInstance(req, res) {
  const instance = await findOwnedInstance(req);
  if (!instance) return res.status(404).json({ error: 'Instance not found' });

  await baileysManager.stopInstance(instance._id.toString(), { wipeSession: true });
  await Message.deleteMany({ instance: instance._id });
  removeInstanceMedia(instance._id.toString());
  await instance.deleteOne();

  res.json({ message: 'Instance deleted' });
}

export async function updateWebhook(req, res) {
  const { webhookUrl, includeGroupMessages, includeOwnMessages, regenerateSecret } = req.body;
  const instance = await findOwnedInstance(req);
  if (!instance) return res.status(404).json({ error: 'Instance not found' });

  if (webhookUrl !== undefined) instance.webhookUrl = webhookUrl || null;
  if (includeGroupMessages !== undefined) instance.includeGroupMessages = !!includeGroupMessages;
  if (includeOwnMessages !== undefined) instance.includeOwnMessages = !!includeOwnMessages;
  if (regenerateSecret) instance.webhookSecret = crypto.randomBytes(16).toString('hex');

  await instance.save();
  res.json({ instance });
}

export async function updateProxy(req, res) {
  const { useProxy, proxyUrl } = req.body;
  const instance = await findOwnedInstance(req);
  if (!instance) return res.status(404).json({ error: 'Instance not found' });

  if (useProxy !== undefined) instance.useProxy = !!useProxy;
  if (proxyUrl !== undefined) instance.proxyUrl = proxyUrl || null;
  await instance.save();

  res.json({ instance, note: 'Proxy takes effect the next time this instance connects' });
}

// Lists the groups of the connected WhatsApp number + which ones are currently selected.
export async function listGroups(req, res) {
  const instance = await findOwnedInstance(req);
  if (!instance) return res.status(404).json({ error: 'Instance not found' });

  try {
    const groups = await baileysManager.listGroups(instance._id.toString(), {
      force: req.query.refresh === '1',
    });
    res.json({ groups, selectedGroupIds: instance.selectedGroupIds || [] });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

export async function updateSelectedGroups(req, res) {
  const instance = await findOwnedInstance(req);
  if (!instance) return res.status(404).json({ error: 'Instance not found' });

  const { selectedGroupIds } = req.body;

  if (!Array.isArray(selectedGroupIds) || !selectedGroupIds.every((id) => typeof id === 'string' && id.endsWith('@g.us'))) {
    return res.status(400).json({ error: 'selectedGroupIds must be an array of group IDs ending in @g.us' });
  }

  let ids = [...new Set(selectedGroupIds)];

  // When the instance is connected, only keep IDs that really are groups of this account
  if (baileysManager.isActive(instance._id.toString())) {
    try {
      const live = await baileysManager.listGroups(instance._id.toString());
      const liveIds = new Set(live.map((g) => g.id));
      ids = ids.filter((id) => liveIds.has(id));
    } catch (err) {
      console.warn('updateSelectedGroups: could not verify groups against live list:', err.message);
    }
  }

  instance.selectedGroupIds = ids;
  await instance.save();

  res.json({ selectedGroupIds: instance.selectedGroupIds });
}

export async function getMessages(req, res) {
  const instance = await findOwnedInstance(req);
  if (!instance) return res.status(404).json({ error: 'Instance not found' });

  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const messages = await Message.find({ instance: instance._id }).sort({ createdAt: -1 }).limit(limit);
  res.json({ messages });
}

export async function sendTestMessage(req, res) {
  const { to, text } = req.body;
  const instance = await findOwnedInstance(req);
  if (!instance) return res.status(404).json({ error: 'Instance not found' });
  if (!to || !text) return res.status(400).json({ error: 'to and text are required' });

  try {
    await baileysManager.sendText(instance._id.toString(), to, text);
    res.json({ message: 'Sent' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

export async function listProxyPool(req, res) {
  res.json({ pool: getPool() });
}