import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';

import { isDirectEntry, parseTcpPort } from '../src/config/runtime.ts';

export interface DevTopology {
  webPort: number;
  apiPort: number;
}

export function resolveDevTopology(args: readonly string[]): DevTopology {
  const values = new Map<'--web-port' | '--api-port', string>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument !== '--web-port' && argument !== '--api-port') {
      throw new Error(`Unknown development option: ${argument ?? ''}`);
    }
    if (values.has(argument)) {
      throw new Error(`${argument} may only be provided once.`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(
        `${argument} requires an integer TCP port from 1 to 65535.`,
      );
    }
    values.set(argument, value);
    index += 1;
  }
  const webPort = parseTcpPort(
    values.get('--web-port') ?? '4173',
    '--web-port',
  );
  const apiPort = parseTcpPort(
    values.get('--api-port') ?? '4174',
    '--api-port',
  );
  if (webPort === apiPort) {
    throw new Error('The web and API development ports must be different.');
  }
  return { webPort, apiPort };
}

function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
}

export function launchDevelopment(topology: DevTopology): void {
  const children: ChildProcess[] = [];
  let shuttingDown = false;
  const stop = (signal: NodeJS.Signals, exitCode: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of children) signalChild(child, signal);
    const pending = children.filter(
      (child) => child.exitCode === null && child.signalCode === null,
    );
    if (!pending.length) process.exit(exitCode);
    let remaining = pending.length;
    for (const child of pending) {
      child.once('exit', () => {
        remaining -= 1;
        if (remaining === 0) process.exit(exitCode);
      });
    }
  };

  const api = spawn(
    process.execPath,
    [
      '--watch',
      resolve('src/server/index.ts'),
      '--api-only',
      '--port',
      String(topology.apiPort),
    ],
    { stdio: 'inherit' },
  );
  children.push(api);
  const vite = spawn(
    process.execPath,
    [
      resolve('node_modules/vite/bin/vite.js'),
      '--mode',
      'host',
      '--host',
      '127.0.0.1',
      '--port',
      String(topology.webPort),
    ],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        MEHFIL_DEV_API_PORT: String(topology.apiPort),
      },
    },
  );
  children.push(vite);

  for (const child of children) {
    child.once('error', (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      stop('SIGTERM', 1);
    });
    child.once('exit', (code, signal) => {
      if (shuttingDown) return;
      const exitCode = code ?? (signal ? 1 : 0);
      stop('SIGTERM', exitCode);
    });
  }
  process.once('SIGINT', () => stop('SIGINT', 130));
  process.once('SIGTERM', () => stop('SIGTERM', 143));
}

if (isDirectEntry(import.meta.url)) {
  try {
    launchDevelopment(resolveDevTopology(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
