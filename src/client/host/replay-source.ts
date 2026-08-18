declare const __MEHFIL_REPLAY__: boolean;

function replayBuild(): boolean {
  // __MEHFIL_REPLAY__ is a Vite build-time `define`: normal builds leave the
  // identifier unsubstituted (reading it throws ReferenceError), while the
  // replay build inlines the literal `true`/`false`.
  try {
    return Boolean(__MEHFIL_REPLAY__);
  } catch {
    return false;
  }
}

/** HTTPS in production; loopback HTTP only in the explicit replay build. */
export function trustedRemoteAudioSource(source: string): boolean {
  try {
    const url = new URL(source);
    if (url.username || url.password) return false;
    if (url.protocol === 'https:') return true;
    return (
      replayBuild() &&
      url.protocol === 'http:' &&
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
    );
  } catch {
    return false;
  }
}
