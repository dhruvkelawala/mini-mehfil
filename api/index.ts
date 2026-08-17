import type { IncomingMessage, ServerResponse } from 'node:http';

import server from '../src/server/index.ts';

// Keep Vercel's entrypoint explicit instead of relying on its framework
// detector to infer how server.js should be invoked.
export default function handler(req: IncomingMessage, res: ServerResponse) {
  server.emit('request', req, res);
}
