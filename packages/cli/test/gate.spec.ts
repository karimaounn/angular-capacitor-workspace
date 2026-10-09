import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NpmRun } from '../src/gate/npm';
import type { AcceptedAdvisory, Policy, PolicyContext } from '../src/policy/types';

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

/**
 * `audit` never applies the policy, so the gate is the only place an accepted
 * advisory's date and scope can be enforced there.
 */
describe('accepted advisories', () => {
  const FINDING = JSON.stringify({
    auditReportVersion: 2,
    vulnerabilities: {
      'left-pad': {
        name: 'left-pad',
        severity: 'high',
        isDirect: true,
        via: [
          {
            source: 1,
            name: 'left-pad',
            dependency: 'left-pad',
            title: 'Pads too far',
            url: 'https://github.com/advisories/GHSA-test',
            severity: 'high',
            range: '<2.0.0',
          },
        ],
        effects: [],
        range: '<2.0.0',
        nodes: ['node_modules/left-pad'],
        fixAvailable: false,
      },
    },
  });

  const policy = (accepted: Partial<AcceptedAdvisory>): Policy => ({
    reviewed: '2026-01-01',
    prune: [],
    overrides: [],
    floors: [],
    retired: [],
    allowScripts: {},
    accepted: [
      { id: 'GHSA-test', packages: ['left-pad'], reason: 'test', until: '2026-12-31', ...accepted },
    ],
  });

  const context = (builders: string[] = []): PolicyContext => ({
    features: new Set(),
    builders: new Set(builders),
    today: new Date('2026-06-01T00:00:00Z'),
  });

  beforeEach(() => {
    // `clearAllMocks` keeps a mocked return value, and the floor tests above
    // leave an npm behind that the gate refuses before it reaches any of this.
    npmVersion.mockReturnValue('11.6.0');
    auditJson.mockReturnValue({ status: 1, stdout: FINDING, stderr: '' });
  });

  it('lets an acceptance in force through', () => {
    const result = runGate({ cwd: '/nowhere', policy: policy({}), context: context() });

    expect(result.ok).toBe(true);
    expect(result.accepted.map((finding) => finding.id)).toEqual(['GHSA-test']);
  });

  it('fails on an acceptance that has expired, as generation and doctor do', () => {
    const result = runGate({
      cwd: '/nowhere',
      policy: policy({ until: '2026-01-01' }),
      context: context(),
    });

    expect(result.ok).toBe(false);
    expect(result.report).toContain('GHSA-test expired on 2026-01-01');
    // Before the resolve: the answer does not depend on the tree.
    expect(resolveLockfile).not.toHaveBeenCalled();
  });

  it('excuses nothing outside its onlyWhen scope', () => {
    const scoped = policy({ onlyWhen: ['legacy:*'] });

    const outside = runGate({ cwd: '/nowhere', policy: scoped, context: context() });
    expect(outside.ok).toBe(false);
    expect(outside.unhandled.map((finding) => finding.id)).toEqual(['GHSA-test']);

    const inside = runGate({
      cwd: '/nowhere',
      policy: scoped,
      context: context(['legacy:build']),
    });
    expect(inside.ok).toBe(true);
  });

  it('does not fail on an expired acceptance outside its scope', () => {
    // An entry kept for an older kind of workspace must not fail this one —
    // here the advisory is simply unhandled, which is what the report says.
    const result = runGate({
      cwd: '/nowhere',
      policy: policy({ until: '2026-01-01', onlyWhen: ['legacy:*'] }),
      context: context(),
    });

    expect(result.report).not.toContain('expired');
    expect(resolveLockfile).toHaveBeenCalled();
  });
});
