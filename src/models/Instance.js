import mongoose from 'mongoose';

const instanceSchema = new mongoose.Schema(
  {
    // Owner is either the Admin (ownerRole: 'admin', ownerId: null) or a sub-admin User.
    ownerRole: { type: String, enum: ['admin', 'subadmin'], required: true },
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    name: { type: String, required: true, trim: true },

    status: {
      type: String,
      enum: ['created', 'qr_pending', 'connecting', 'connected', 'disconnected', 'logged_out'],
      default: 'created',
    },

    phoneNumber: { type: String, default: null },
    pushName: { type: String, default: null },

    webhookUrl: { type: String, default: null },
    webhookSecret: { type: String, default: null },

    // Master switch for group recording. Only groups listed in selectedGroupIds are recorded.
    includeGroupMessages: { type: Boolean, default: false },
    selectedGroupIds: { type: [String], default: [] },

    includeOwnMessages: { type: Boolean, default: true },

    useProxy: { type: Boolean, default: false },
    proxyUrl: { type: String, default: null },

    lastConnectedAt: { type: Date, default: null },
    lastDisconnectReason: { type: String, default: null },
  },
  { timestamps: true }
);

// An owner can't have two instances with the same name - this is what lets the public
// send API accept a human-readable `instanceName` and always resolve to the right number.
instanceSchema.index({ ownerRole: 1, ownerId: 1, name: 1 }, { unique: true });

export default mongoose.model('Instance', instanceSchema);