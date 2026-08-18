import { createR2Storage, createShareHandler } from './sharing.ts';
import { createDurableRoomDirectory, createRoomRouter } from './rooms.ts';
import { roomPage } from './room-page.ts';

export { MehfilRoom } from './mehfil-room.ts';

interface WorkerEnv extends Env {
  MEHFIL_SHARE_SECRET?: string;
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname.startsWith('/assets/')) return env.ASSETS.fetch(request);
    const storage = createR2Storage(env.SHARES);
    const rateLimit = async (ip: string) =>
      (await env.UPLOAD_RATE_LIMIT.limit({ key: ip })).success;
    const shareHandler = createShareHandler({
      storage,
      rateLimit,
      uploadSecret: env.MEHFIL_SHARE_SECRET ?? '',
      publicBaseUrl: env.MEHFIL_PUBLIC_URL,
      previewImageUrl: env.SHARE_PREVIEW_IMAGE_URL,
    });
    const routeRoomRequest = createRoomRouter({
      directory: createDurableRoomDirectory(env.ROOMS),
      rateLimit,
      secret: env.MEHFIL_SHARE_SECRET ?? '',
      renderPage: (roomId) => roomPage(roomId, env.ASSETS),
    });
    return (await routeRoomRequest(request)) || shareHandler(request);
  },
};
