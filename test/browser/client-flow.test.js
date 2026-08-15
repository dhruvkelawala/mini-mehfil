const { test, expect } = require('@playwright/test');

const lyrics = {
  title: 'Monsoon Mehfil',
  language: 'Gujarati',
  nativeScriptName: 'Gujarati',
  isLatinScript: false,
  lyricsNative: '[Verse]\nઆ સાંજ ભીની છે\nસુરોમાં વરસાદ',
  lyricsRoman: '[Verse]\naa saanj bhini chhe\nsuroma varsaad',
  prompt: 'Warm Gujarati monsoon folk'
};

const audioUrl = 'https://media.invalid/song.mp3';
let unexpectedRequests;

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body)
  });
}

function expectPayload(request, keys) {
  expect(request.method()).toBe('POST');
  expect(request.headers()['content-type']).toContain('application/json');
  const payload = request.postDataJSON();
  expect(Object.keys(payload).sort()).toEqual([...keys].sort());
  if ('token' in payload) expect(typeof payload.token).toBe('string');
  return payload;
}

async function fillAndSubmit(page, idea = 'Rain over Ahmedabad') {
  await page.getByLabel('MiniMax token').fill('sk-cp-browser-fixture');
  await page.getByLabel("What's the song about?").fill(idea);
  await page.getByLabel('Vibe').fill('warm folk');
  await page.locator('#language').selectOption('Gujarati');
  await page.getByRole('button', { name: 'Start the mehfil' }).click();
}

async function installMediaStub(page) {
  await page.addInitScript(() => {
    const mediaSources = new WeakMap();
    Object.defineProperty(HTMLMediaElement.prototype, 'src', {
      configurable: true,
      get() { return mediaSources.get(this) || ''; },
      set(value) { mediaSources.set(this, new URL(value, document.baseURI).href); }
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'play', {
      configurable: true,
      value() {
        const rejection = window.__mediaPlayRejections?.shift();
        if (rejection) {
          return Promise.reject(new DOMException(rejection.message, rejection.name));
        }
        this.dispatchEvent(new Event('play'));
        return Promise.resolve();
      }
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
      configurable: true,
      value() { this.dispatchEvent(new Event('pause')); }
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'load', {
      configurable: true,
      value() {}
    });
  });
}

async function interceptSongFlow(page, options = {}) {
  const requests = [];
  await page.route('**/api/write-lyrics', async route => {
    const payload = expectPayload(route.request(), ['token', 'idea', 'vibe', 'language']);
    expect(payload.idea).toBeTruthy();
    requests.push({ endpoint: 'lyrics', payload });
    if (options.lyricFailure) return json(route, { error: 'Lyricist fixture refused the prompt.' }, 422);
    return json(route, lyrics);
  });
  await page.route('**/api/generate', async route => {
    const payload = expectPayload(route.request(), ['token', 'prompt', 'lyrics']);
    expect(payload.prompt).toBe(lyrics.prompt);
    expect(payload.lyrics).toBe(lyrics.lyricsNative);
    requests.push({ endpoint: 'generate', payload });
    if (options.generationFailure) return json(route, { error: 'Music fixture could not record.' }, 502);
    const result = { data: { audio: audioUrl }, share_ref: options.shareRef || 'share-ref-one' };
    return json(route, result);
  });
  await page.route(audioUrl, route => route.fulfill({
    status: 200,
    contentType: 'audio/mpeg',
    body: Buffer.from([73, 68, 51])
  }));
  return requests;
}

test.beforeEach(async ({ page }, testInfo) => {
  unexpectedRequests = [];
  await installMediaStub(page);
  const appOrigin = new URL(testInfo.project.use.baseURL).origin;
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === appOrigin && !url.pathname.startsWith('/api/')) {
      return route.fallback();
    }
    unexpectedRequests.push(`${url.origin}${url.pathname}`);
    return route.abort('blockedbyclient');
  });
});

test.afterEach(() => {
  expect(unexpectedRequests).toEqual([]);
});

test('writes lyrics, records a song, and exposes native and roman presentation', async ({ page }) => {
  const requests = await interceptSongFlow(page);
  await page.goto('/');
  await fillAndSubmit(page);

  await expect(page.getByRole('dialog', { name: 'Your mehfil performance' })).toBeVisible();
  await expect(page.locator('#track-title')).toHaveText(lyrics.title);
  await expect(page.getByRole('button', { name: 'Pause' })).toBeEnabled();
  await expect(page.getByRole('link', { name: 'Save this song' })).toHaveAttribute('aria-disabled', 'false');
  await expect(page.getByRole('button', { name: 'Share this song' })).toBeEnabled();
  await expect(page.locator('#reveal-language')).toHaveText('Gujarati · Gujarati');
  await expect(page.locator('#reveal-lines')).toContainText('આ સાંજ ભીની છે');
  await expect(page.locator('#reveal-lines')).toContainText('aa saanj bhini chhe');
  expect(requests.map(request => request.endpoint)).toEqual(['lyrics', 'generate']);
});

test('returns lyric and generation failures to a clean form state', async ({ page }) => {
  for (const failure of ['lyricFailure', 'generationFailure']) {
    await interceptSongFlow(page, { [failure]: true });
    await page.goto('/');
    await fillAndSubmit(page, `${failure} fixture`);

    const expected = failure === 'lyricFailure'
      ? 'Lyricist fixture refused the prompt.'
      : 'Music fixture could not record.';
    await expect(page.locator('#notice')).toHaveText(expected);
    await expect(page.locator('#performance')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Start the mehfil' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Play' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Share this song' })).toBeDisabled();
    await expect(page.locator('#download')).toHaveAttribute('aria-disabled', 'true');
  }
});

test('Escape closes the performance and restores focus to the opener', async ({ page }) => {
  await interceptSongFlow(page);
  await page.goto('/');
  await fillAndSubmit(page);
  await expect(page.locator('#performance')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start the mehfil' })).toBeEnabled();

  await page.keyboard.press('Escape');

  await expect(page.locator('#performance')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Start the mehfil' })).toBeFocused();
  await expect(page.locator('main')).not.toHaveAttribute('inert', '');
});

test('a delayed old share completion cannot mutate a newer generation', async ({ page }) => {
  let generation = 0;
  let signalOldShareStarted;
  let releaseOldShare;
  const oldShareStarted = new Promise(resolve => { signalOldShareStarted = resolve; });
  const oldShareGate = new Promise(resolve => { releaseOldShare = resolve; });
  const sharedReferences = [];

  await page.route('**/api/write-lyrics', route => {
    expectPayload(route.request(), ['token', 'idea', 'vibe', 'language']);
    return json(route, { ...lyrics, title: generation ? 'Second Song' : 'First Song' });
  });
  await page.route('**/api/generate', route => {
    expectPayload(route.request(), ['token', 'prompt', 'lyrics']);
    generation += 1;
    return json(route, {
      data: { audio: audioUrl },
      share_ref: generation === 1 ? 'share-ref-old' : 'share-ref-new'
    });
  });
  await page.route('**/api/share', async route => {
    const payload = expectPayload(route.request(), [
      'shareRef', 'title', 'language', 'nativeScriptName', 'isLatinScript', 'lyricsNative', 'lyricsRoman'
    ]);
    sharedReferences.push(payload.shareRef);
    if (payload.shareRef === 'share-ref-old') {
      signalOldShareStarted();
      await oldShareGate;
    }
    return json(route, { url: `https://share.invalid/${payload.shareRef}` }, 201);
  });
  await page.route(audioUrl, route => route.fulfill({ status: 200, contentType: 'audio/mpeg', body: 'ID3' }));

  await page.goto('/');
  await fillAndSubmit(page, 'First idea');
  await expect(page.locator('#track-title')).toHaveText('First Song');
  await page.getByRole('button', { name: 'Share this song' }).click();
  await oldShareStarted;

  await page.keyboard.press('Escape');
  await fillAndSubmit(page, 'Second idea');
  await expect(page.locator('#track-title')).toHaveText('Second Song');
  await expect(page.locator('#notice')).toHaveText('Your recording is ready.');
  releaseOldShare();
  await expect(page.getByRole('button', { name: 'Share this song' })).toHaveText('Share');
  await expect(page.locator('#notice')).toHaveText('Your recording is ready.');

  await page.getByRole('button', { name: 'Share this song' }).click();
  await expect.poll(() => sharedReferences).toEqual(['share-ref-old', 'share-ref-new']);
});

test('rejected automatic playback stays recoverable and retries from Play', async ({ page }) => {
  await page.addInitScript(() => {
    window.__mediaPlayRejections = [{ name: 'NotAllowedError', message: 'Synthetic autoplay rejection' }];
  });
  await interceptSongFlow(page);
  await page.goto('/');
  await fillAndSubmit(page);

  expect(new URL(page.url()).searchParams.has('mediaDebug')).toBe(false);
  await expect(page.locator('#track-title')).toHaveText(lyrics.title);
  await expect(page.locator('#performance-status')).toHaveText('Your song is ready — tap Play.');
  await expect(page.locator('#performance')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Share this song' })).toBeEnabled();
  await expect(page.getByRole('link', { name: 'Save this song' })).toHaveAttribute('href', audioUrl);
  await expect(page.getByRole('link', { name: 'Save this song' })).toHaveAttribute('aria-disabled', 'false');
  await expect(page.locator('#media-diagnostics')).toBeHidden();

  await page.getByRole('button', { name: 'Play' }).click();

  await expect(page.locator('#player-shell')).toHaveClass(/playing/);
  await expect(page.locator('#performance')).toHaveAttribute('data-stage', 'playing');
  await expect(page.locator('#performance-status')).toHaveText('');
  await expect(page.locator('#notice')).toHaveText('');
});

test('a non-policy play rejection keeps Play, Save, and Share available', async ({ page }) => {
  await page.addInitScript(() => {
    window.__mediaPlayRejections = [{ name: 'NotSupportedError', message: 'Raw decoder detail' }];
  });
  await interceptSongFlow(page);
  await page.goto('/');
  await fillAndSubmit(page);

  await expect(page.locator('#performance-status')).toContainText('Play');
  await expect(page.locator('#performance-status')).toContainText('Save');
  await expect(page.locator('#performance-status')).not.toContainText('Raw decoder detail');
  await expect(page.locator('#performance')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Share this song' })).toBeEnabled();
  await expect(page.getByRole('link', { name: 'Save this song' })).toHaveAttribute('href', audioUrl);
  await expect(page.getByRole('link', { name: 'Save this song' })).toHaveAttribute('aria-disabled', 'false');
});

test('a media error surfaces sanitized recovery without clearing controls', async ({ page }) => {
  const signedUrlDetail = 'https://media.invalid/song.mp3?token=do-not-render';
  const rawMediaDetail = `Decoder exposed ${signedUrlDetail}`;
  await interceptSongFlow(page);
  await page.goto('/');
  await fillAndSubmit(page);
  await expect(page.locator('#track-title')).toHaveText(lyrics.title);

  await page.locator('#audio').evaluate((element, message) => {
    Object.defineProperty(element, 'error', {
      configurable: true,
      value: { code: 3, message }
    });
    element.dispatchEvent(new Event('error'));
  }, rawMediaDetail);

  await expect(page.locator('#performance-status')).toContainText('Play');
  await expect(page.locator('#performance-status')).toContainText('Save');
  await expect(page.locator('#player-shell')).not.toHaveClass(/playing/);
  await expect(page.locator('#performance')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Share this song' })).toBeEnabled();
  await expect(page.getByRole('link', { name: 'Save this song' })).toHaveAttribute('href', audioUrl);
  await expect(page.getByRole('link', { name: 'Save this song' })).toHaveAttribute('aria-disabled', 'false');
  await expect(page.locator('#performance-status')).not.toContainText(rawMediaDetail);
  await expect(page.locator('#notice')).not.toContainText(signedUrlDetail);
  await expect(page.locator('#media-diagnostics')).toBeHidden();
});
