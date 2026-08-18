import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type AddressInfo, type Server } from 'node:net';

const LOOPBACK = '127.0.0.1';
const STARTUP_TIMEOUT_MS = 15_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_CHARACTERS = 64 * 1024;

interface Reservation {
  server: Server;
  port: number;
}

class TopologyFailure extends Error {
  output: string;

  constructor(message: string, output: string) {
    super(message);
    this.output = output;
  }
}

function wait(delay: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delay));
}

function reservePort(): Promise<Reservation> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, LOOPBACK, () => {
      server.removeListener('error', reject);
      // SAFETY: we are inside the listen() callback of a server bound to a
      // TCP port on the loopback (never a unix socket), so address() returns
      // an AddressInfo carrying the assigned port.
      const address = server.address() as AddressInfo;
      resolve({ server, port: address.port });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function choosePorts(): Promise<{ webPort: number; apiPort: number }> {
  const web = await reservePort();
  let api: Reservation | null = null;
  try {
    do {
      if (api) await closeServer(api.server);
      api = await reservePort();
    } while (api.port === web.port);
    const topology = { webPort: web.port, apiPort: api.port };
    await Promise.all([closeServer(web.server), closeServer(api.server)]);
    return topology;
  } catch (error) {
    await closeServer(web.server).catch(() => undefined);
    if (api) await closeServer(api.server).catch(() => undefined);
    throw error;
  }
}

function waitForExit(child: ChildProcess, timeout: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', exited);
      resolve(false);
    }, timeout);
    const exited = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', exited);
  });
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      error.code !== 'ESRCH'
    ) {
      throw error;
    }
  }
}

async function terminateWindowsTree(pid: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
    });
    killer.once('error', () => resolve());
    killer.once('exit', () => resolve());
  });
}

async function terminateOwnedTree(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  if (process.platform === 'win32') {
    await terminateWindowsTree(child.pid);
    await waitForExit(child, CLEANUP_TIMEOUT_MS);
    return;
  }
  signalProcessGroup(child.pid, 'SIGTERM');
  if (await waitForExit(child, 3_000)) return;
  signalProcessGroup(child.pid, 'SIGKILL');
  if (!(await waitForExit(child, 2_000))) {
    throw new Error('The owned development process tree did not terminate.');
  }
}

function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen(port, LOOPBACK, () => {
      server.close(() => resolve(true));
    });
  });
}

async function assertPortsReleased(ports: readonly number[]): Promise<void> {
  const deadline = Date.now() + CLEANUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const released = await Promise.all(ports.map((port) => canBind(port)));
    if (released.every(Boolean)) return;
    await wait(100);
  }
  throw new Error(`Owned development ports were not released after cleanup.`);
}

async function responds(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(800) });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForTopology(
  child: ChildProcess,
  webPort: number,
  apiPort: number,
): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('The development command exited before becoming ready.');
    }
    const [web, api] = await Promise.all([
      responds(`http://${LOOPBACK}:${webPort}/`),
      responds(`http://${LOOPBACK}:${apiPort}/`),
    ]);
    if (web && api) return;
    await wait(100);
  }
  throw new Error(
    'The development topology did not become ready within 15 seconds.',
  );
}

async function assertTokenValidation(port: number): Promise<void> {
  const response = await fetch(`http://${LOOPBACK}:${port}/api/write-lyrics`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(2_000),
  });
  const value: unknown = await response.json();
  const exact =
    JSON.stringify(value) ===
    JSON.stringify({
      error: 'Add your MiniMax API token.',
    });
  if (response.status !== 400 || !exact) {
    throw new Error(
      `Port ${port} did not return the expected token validation response.`,
    );
  }
}

let activeChild: ChildProcess | null = null;
let activePorts: readonly number[] = [];
let handlingSignal = false;

async function handleSignal(signal: NodeJS.Signals): Promise<void> {
  if (handlingSignal) return;
  handlingSignal = true;
  if (activeChild) await terminateOwnedTree(activeChild).catch(() => undefined);
  await assertPortsReleased(activePorts).catch(() => undefined);
  process.exit(signal === 'SIGINT' ? 130 : 143);
}

process.once('SIGINT', () => void handleSignal('SIGINT'));
process.once('SIGTERM', () => void handleSignal('SIGTERM'));

async function runAttempt(): Promise<void> {
  const { webPort, apiPort } = await choosePorts();
  activePorts = [webPort, apiPort];
  let output = '';
  const append = (chunk: Buffer) => {
    output = `${output}${chunk.toString()}`.slice(-MAX_OUTPUT_CHARACTERS);
  };
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const child = spawn(
    pnpm,
    [
      'run',
      'dev',
      '--web-port',
      String(webPort),
      '--api-port',
      String(apiPort),
    ],
    {
      detached: process.platform !== 'win32',
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  activeChild = child;
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  let primaryFailure: TopologyFailure | null = null;
  const cleanupFailures: unknown[] = [];
  try {
    await waitForTopology(child, webPort, apiPort);
    await assertTokenValidation(webPort);
    await assertTokenValidation(apiPort);
  } catch (error) {
    primaryFailure = new TopologyFailure(
      error instanceof Error ? error.message : String(error),
      output,
    );
  } finally {
    try {
      await terminateOwnedTree(child);
    } catch (error) {
      cleanupFailures.push(error);
    }
    activeChild = null;
    try {
      await assertPortsReleased([webPort, apiPort]);
    } catch (error) {
      cleanupFailures.push(error);
    }
    activePorts = [];
  }
  if (primaryFailure) {
    if (cleanupFailures.length) {
      primaryFailure.output = `${primaryFailure.output}\nCleanup errors:\n${cleanupFailures
        .map((error) =>
          error instanceof Error ? error.message : String(error),
        )
        .join('\n')}`;
    }
    throw primaryFailure;
  }
  if (cleanupFailures.length)
    throw new AggregateError(cleanupFailures, 'Development cleanup failed.');
}

async function main(): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await runAttempt();
      console.log('Development topology verified.');
      return;
    } catch (error) {
      const failure =
        error instanceof TopologyFailure
          ? error
          : new TopologyFailure(
              error instanceof Error ? error.message : String(error),
              '',
            );
      const bindRace =
        /EADDRINUSE|address already in use|Port \d+ is already in use/i.test(
          failure.output,
        );
      if (bindRace && attempt < 3) continue;
      const diagnostics = failure.output.trim();
      throw new Error(
        diagnostics
          ? `${failure.message}\nDevelopment command output:\n${diagnostics}`
          : failure.message,
        { cause: error },
      );
    }
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
