/**
 * Compiles the story-card canvas module into the inline script the Worker's
 * shared playback page carries.
 *
 * The host app bundles `src/client/shared/story-card-canvas.ts` the ordinary
 * way. The shared page has no bundler and a strict CSP, so it ships one inline
 * `<script>` instead — but it must be the same code, or the two story cards
 * drift apart. Rather than keep a second copy, this compiles the one module
 * and checks the result in, the same way `wrangler types` checks in
 * `worker-configuration.d.ts`.
 *
 *   pnpm run story-card         rewrite the generated module
 *   pnpm run story-card:check   fail when it has drifted (runs in `pnpm run check`)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

import { format } from 'prettier';
import ts from 'typescript';

const SOURCE = new URL(
  '../src/client/shared/story-card-canvas.ts',
  import.meta.url,
);
const GENERATED = new URL(
  '../src/worker/story-card-script.generated.ts',
  import.meta.url,
);
const SOURCE_LABEL = 'src/client/shared/story-card-canvas.ts';
const GENERATED_LABEL = 'src/worker/story-card-script.generated.ts';

/**
 * CommonJS, not ESM: the page runs this inside one classic `<script>`, so the
 * compiled module needs somewhere to hang its exports rather than `export`
 * statements a classic script would reject. ES2020 keeps optional chaining
 * intact, which Safari 14 — the oldest browser that can share files — reads.
 */
function compile(source: string): string {
  const { outputText, diagnostics } = ts.transpileModule(source, {
    fileName: SOURCE_LABEL,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      isolatedModules: true,
      removeComments: true,
      newLine: ts.NewLineKind.LineFeed,
    },
  });
  if (diagnostics?.length)
    throw new Error(
      `${SOURCE_LABEL} did not compile: ${diagnostics
        .map((diagnostic) =>
          ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
        )
        .join('; ')}`,
    );
  if (/\brequire\s*\(/.test(outputText))
    throw new Error(
      `${SOURCE_LABEL} must not import values: the inline script has no module loader.`,
    );
  return outputText.trim();
}

async function render(): Promise<string> {
  const script = `const storyCard=(()=>{const exports={};${compile(
    readFileSync(SOURCE, 'utf8'),
  )}\nreturn exports})();`;
  const module = `// Generated from ${SOURCE_LABEL} by scripts/build-story-card.ts.
// Run \`pnpm run story-card\` after changing that module; \`pnpm run check\`
// fails when this file has drifted. Do not edit by hand.

/** The story-card module as one classic script, exposed as \`storyCard\`. */
export const STORY_CARD_SCRIPT = ${JSON.stringify(script)};
`;
  return format(module, { parser: 'typescript', singleQuote: true });
}

const expected = await render();
const checking = process.argv.includes('--check');
const current = readFileSync(GENERATED, 'utf8');

if (checking) {
  if (current === expected) {
    console.log(`${GENERATED_LABEL} is up to date.`);
  } else {
    console.error(
      `${GENERATED_LABEL} is stale. Run \`pnpm run story-card\` and commit the result.`,
    );
    process.exitCode = 1;
  }
} else if (current === expected) {
  console.log(`${GENERATED_LABEL} is already up to date.`);
} else {
  writeFileSync(GENERATED, expected);
  console.log(`Wrote ${GENERATED_LABEL}.`);
}
