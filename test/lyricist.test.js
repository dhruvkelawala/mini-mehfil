const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// The lyricist reads its API base from the environment at import time, so the mock
// must be listening and exported before the module loads.
async function withMockAnthropic(handler, run) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
      handler(res);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.MINIMAX_ANTHROPIC_BASE = `http://127.0.0.1:${server.address().port}`;
  try {
    const { writeLyrics } = await import(`../lyricist.mjs?${Math.random()}`);
    await run(writeLyrics, requests);
  } finally {
    delete process.env.MINIMAX_ANTHROPIC_BASE;
    await new Promise(resolve => server.close(resolve));
  }
}

const SHEET = {
  title: 'Aloopuri Khavsa',
  language: 'Gujarati',
  languageCode: 'gu',
  nativeScriptName: 'Gujarati',
  isLatinScript: false,
  lyricsNative: '[Verse]\nઆ સાંજ ધીમે',
  lyricsRoman: '[Verse]\naa saanj dhime',
  prompt: 'Gujarati hip hop, upbeat, brass, male vocal, native pronunciation.'
};

test('speaks the Anthropic Messages protocol the way pi-ai did', async () => {
  await withMockAnthropic(
    res => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: '```json\n' + JSON.stringify(SHEET) + '\n```' }
        ],
        usage: { input_tokens: 900, output_tokens: 400 }
      }));
    },
    async (writeLyrics, requests) => {
      const result = await writeLyrics({ token: 'sk-test', idea: 'Aloopuri Khavsa', vibe: 'hip hop' });
      const req = requests[0];
      assert.equal(req.url, '/v1/messages');
      assert.equal(req.headers['x-api-key'], 'sk-test');
      assert.equal(req.headers['anthropic-version'], '2023-06-01');
      assert.equal(req.body.model, 'MiniMax-M3');
      assert.ok(req.body.max_tokens > 0);
      assert.ok(req.body.system.includes('songwriter'));
      assert.match(req.body.messages[0].content, /IDEA: Aloopuri Khavsa/);
      // Thinking blocks are ignored, the fenced JSON is parsed, both scripts survive.
      assert.equal(result.language, 'Gujarati');
      assert.match(result.lyricsNative, /સાંજ/);
      assert.match(result.lyricsRoman, /saanj/);
      assert.equal(result.usage.output_tokens, 400);
    }
  );
});

test('surfaces an upstream auth error with its real message', async () => {
  await withMockAnthropic(
    res => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
    },
    async writeLyrics => {
      await assert.rejects(
        () => writeLyrics({ token: 'sk-bad', idea: 'anything' }),
        error => error.status === 401 && /invalid api key/.test(error.message)
      );
    }
  );
});

test('rejects an empty reply as unreadable rather than crashing', async () => {
  await withMockAnthropic(
    res => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text: 'sorry, no song today' }] }));
    },
    async writeLyrics => {
      await assert.rejects(
        () => writeLyrics({ token: 'sk-test', idea: 'anything' }),
        /could not read/i
      );
    }
  );
});
