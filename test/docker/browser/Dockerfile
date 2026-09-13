# Tier 5 (docs/TESTING.md): the official Node-RED image with this package installed the way a real user would,
# from the package's own tarball (never a bind-mounted workspace copy). Built by build-image.mjs.
FROM nodered/node-red:5.0.7
COPY node-red-contrib-centrifuge.tgz /tmp/pkg.tgz
RUN npm install --unsafe-perm --no-update-notifier --no-fund --save /tmp/pkg.tgz
# Baked in (not bind-mounted), so /data still starts clean every run: see settings.js for what it changes.
COPY settings.js /data/settings.js
