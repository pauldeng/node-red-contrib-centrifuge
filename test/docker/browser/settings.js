"use strict";
// Thin override of the official image's own default settings.js (which Node-RED would otherwise auto-generate
// under /data on first boot): disables only the first-run "Welcome to Node-RED" tour and "Enable Update
// Notifications" telemetry prompt, both of which otherwise pop up over the node dialog during the
// palette/dialog assertions in image.spec.js (the same two settings test/helpers/node-red.js's local harness
// disables, for the same reason). Everything else stays the real distribution's default. Baked into the image
// at build time (see Dockerfile), not bind-mounted, so the container still starts clean every run.
const path = require("node:path");
const base = require(path.join(path.dirname(require.resolve("node-red/package.json")), "settings.js"));
module.exports = {
  ...base,
  editorTheme: { ...base.editorTheme, tours: false },
  telemetry: { enabled: false },
};
