function normalizeOrigin(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    const localHttp = url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
    if (url.protocol !== 'https:' && !localHttp) return '';
    if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) return '';
    return url.origin;
  } catch {
    return '';
  }
}

function createVercelConfig(environment = {}) {
  const shareOrigin = normalizeOrigin(environment.MEHFIL_SHARE_URL);
  return {
    functions: {
      'api/index.js': { maxDuration: 300 }
    },
    rewrites: [
      ...(shareOrigin ? [{ source: '/s/:path*', destination: `${shareOrigin}/s/:path*` }] : []),
      { source: '/(.*)', destination: '/api/index.js' }
    ]
  };
}

exports.createVercelConfig = createVercelConfig;
