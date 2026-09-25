'use strict';

const mongoose = require('mongoose');

/** Small key/value store for runtime settings changed from Telegram. */
const SettingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    value: mongoose.Schema.Types.Mixed,
  },
  { timestamps: true }
);

module.exports = mongoose.models.Setting || mongoose.model('Setting', SettingSchema);
