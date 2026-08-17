import { describe, expect, test } from 'vitest';

import { launchDevelopment, resolveDevTopology } from '../../scripts/dev.ts';

describe('development topology resolver', () => {
  test('defaults to web 4173 and API 4174 without launching on import', () => {
    expect(resolveDevTopology([])).toEqual({ webPort: 4173, apiPort: 4174 });
    expect(typeof launchDevelopment).toBe('function');
  });

  test('accepts independent web and API port overrides', () => {
    expect(resolveDevTopology(['--web-port', '5180'])).toEqual({
      webPort: 5180,
      apiPort: 4174,
    });
    expect(resolveDevTopology(['--api-port', '5181'])).toEqual({
      webPort: 4173,
      apiPort: 5181,
    });
    expect(
      resolveDevTopology(['--web-port', '5180', '--api-port', '5181']),
    ).toEqual({ webPort: 5180, apiPort: 5181 });
  });

  test('rejects missing, malformed, and out-of-range values', () => {
    for (const args of [
      ['--web-port'],
      ['--api-port', 'nope'],
      ['--web-port', '1.5'],
      ['--api-port', '0'],
      ['--web-port', '65536'],
    ]) {
      expect(() => resolveDevTopology(args)).toThrow(/integer TCP port/);
    }
  });

  test('rejects duplicate options and equal ports', () => {
    expect(() =>
      resolveDevTopology(['--web-port', '5000', '--web-port', '5001']),
    ).toThrow(/only be provided once/);
    expect(() =>
      resolveDevTopology(['--api-port', '5001', '--api-port', '5002']),
    ).toThrow(/only be provided once/);
    expect(() =>
      resolveDevTopology(['--web-port', '5000', '--api-port', '5000']),
    ).toThrow(/must be different/);
  });
});
