const server = require('../server');

// Keep Vercel's entrypoint explicit instead of relying on its framework
// detector to infer how server.js should be invoked.
module.exports = function handler(req, res) {
  server.emit('request', req, res);
};
