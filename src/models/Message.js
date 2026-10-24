import mongoose from 'mongoose';

const mediaSchema = new mongoose.Schema(
  {
    kind: { type: String, default: null }, // image | video | audio | document | sticker
    mimeType: { type: String, default: null },
    fileName: { type: String, default: null },
    caption: { type: String, default: null },
    size: { type: Number, default: null },
    sha256: { type: String, default: null },
    url: { type: String, default: null }, // signed URL to the file stored on OUR server
    storedName: { type: String, default: null }, // file name inside MEDIA_DIR/<instanceId>/
    status: { type: String, enum: ['stored', 'skipped', 'failed'], default: 'failed' },
    error: { type: String, default: null },
  },
  { _id: false }
);

const quotedSchema = new mongoose.Schema(
  {
    messageId: { type: String, default: null },
    participant: { type: String, default: null },
    text: { type: String, default: null },
    mediaType: { type: String, default: null },
  },
  { _id: false }
);

const messageSchema = new mongoose.Schema(
  {
    instance: { type: mongoose.Schema.Types.ObjectId, ref: 'Instance', required: true, index: true },
    direction: { type: String, enum: ['in', 'out'], default: 'in' },

    number: { type: String, required: true, index: true },
    isLid: { type: Boolean, default: false }, // true if `number` is a WhatsApp LID, not a real phone number
    senderJid: { type: String, default: null },
    message: { type: String, default: '' },
    isGroup: { type: Boolean, default: false },
    groupId: { type: String, default: null }, // full JID, e.g. 1203630...@g.us
    groupName: { type: String, default: null },
    pushName: { type: String, default: null },
    messageId: { type: String, default: null },
    rawMessageType: { type: String, default: null },

    media: { type: mediaSchema, default: null },
    quotedMessage: { type: quotedSchema, default: null },

    webhookDelivered: { type: Boolean, default: false },
    webhookAttempts: { type: Number, default: 0 },

    waTimestamp: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// used for duplicate protection when WhatsApp re-delivers messages after a reconnect
messageSchema.index({ instance: 1, messageId: 1 });

export default mongoose.model('Message', messageSchema);