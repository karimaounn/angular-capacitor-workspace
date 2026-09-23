import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NpmRun } from '../src/gate/npm';

const { npmVersion, resolveLockfile, auditJson } = vi.hoisted(() => ({
  npmVersion: vi.fn<() => string | undefined>(),
  resolveLockfile: vi.fn<() => NpmRun>(),
  auditJson: vi.fn<() => NpmRun>(),
}));

vi.mock('../src/gate/npm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/gate/npm')>()),
  npmVersion,
  resolveLockfile,
  auditJson,
}));

const { runGate } = await import('../src/gate');

const CLEAN = '{"auditReportVersion":2,"vulnerabilities":{},"metadata":{"vulnerabilities":{}}}';

beforeEach(() => {
  vi.clearAllMocks();
  resolveLockfile.mockReturnValue({ status: 0, stdout: '', stderr: '' });
  auditJson.mockReturnValue({ status: 0, stdout: CLEAN, stderr: '' });
});

describe('the npm floor', () => {
  // The failure this guards against is not "npm is old" but "npm silently did
  // less than it said". On npm 10 `allowScripts` is inert and
  // `--strict-allow-scripts` is accepted and ignored, so the gate would report
  // a clean tree that was never actually gated.
  it('refuses to audit on an npm that cannot enforce the allowlist', () => {
    npmVersion.mockReturnValue('10.9.8');

    const result = runGate({ cwd: '/nowhere' });

    expect(result.ok).toBe(false);
    expect(result.report).toContain('npm 10.9.8');
    expect(result.report).toContain('11.6.0');
    // Not merely a different message: on this npm the resolve does not fail
    // cleanly, it crashes inside arborist. Reaching it at all is the bug.
    expect(resolveLockfile).not.toHaveBeenCalled();
    expect(auditJson).not.toHaveBeenCalled();
  });

  it('points at the Node line, which is how people actually hit this', () => {
    npmVersion.mockReturnValue('10.9.8');

    // Nobody installs an npm; they install a Node and get one. Naming the Node
    // that carries the floor is the actionable half of the message.
    expect(runGate({ cwd: '/nowhere' }).report).toMatch(/Node 24\.8/);
  });

  it('proceeds on the floor itself', () => {
    npmVersion.mockReturnValue('11.6.0');

    expect(runGate({ cwd: '/nowhere' }).ok).toBe(true);
    expect(resolveLockfile).toHaveBeenCalled();
  });

  it('proceeds when the npm version cannot be determined', () => {
    // Guessing "too old" would fail the gate on every environment that prints
    // a version we cannot parse, which is a worse failure than not checking.
    npmVersion.mockReturnValue(undefined);

    expect(runGate({ cwd: '/nowhere' }).ok).toBe(true);
    expect(resolveLockfile).toHaveBeenCalled();
  });

  it('still checks when the resolve is skipped', () => {
    // `doctor` and `audit --skip-resolve` read an existing lockfile, but the
    // audit that follows is only as trustworthy as the npm that writes it.
    npmVersion.mockReturnValue('10.9.8');

    expect(runGate({ cwd: '/nowhere', skipResolve: true }).ok).toBe(false);
    expect(auditJson).not.toHaveBeenCalled();
  });
});
