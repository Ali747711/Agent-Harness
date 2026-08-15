import { readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { type Config, probeSandbox, SandboxedCommandRunner, sandboxPolicyFor } from '@harness/core';

/**
 * `harness doctor` — answers "would the sandbox actually confine bash on THIS
 * machine?" by running real commands through it, not by trusting a dependency
 * check. Dependency presence is not confinement; only a blocked escape is.
 */
interface Probe {
  name: string;
  expectation: string;
  passed: boolean;
  detail: string;
}

const PROBE_TIMEOUT_MS = 12_000;

/** Allowlist entries may carry an `:port` suffix; curl wants the bare host. */
export function stripPort(pattern: string): string {
  // IPv6 literals are bracketed, so a colon inside brackets is not a port.
  const match = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(pattern);
  return match?.[1] ?? pattern;
}

async function runProbes(workspaceRoot: string, config: Config): Promise<Probe[]> {
  // Probe with the sandbox forced ON regardless of config: the question is
  // whether enabling it would work, not whether it is currently enabled.
  //
  // The probe uses the REAL policy — an earlier version tightened allowWrite to
  // the workspace alone and aimed the escape at $TMPDIR, so it reported
  // "confinement verified" for a policy stricter than the one it printed.
  // $TMPDIR is writable by default, so the escape target must sit outside it.
  const policy = sandboxPolicyFor(workspaceRoot, config.sandbox);
  const runner = new SandboxedCommandRunner(policy);
  const marker = join(homedir(), '.harness-doctor-escape-probe');
  const inside = join(workspaceRoot, '.harness-doctor-probe');

  const run = async (command: string) =>
    runner.run({
      command,
      cwd: workspaceRoot,
      timeoutMs: PROBE_TIMEOUT_MS,
      maxOutputBytes: 64_000,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS + 2_000)
    });

  const probes: Probe[] = [];
  try {
    const escapeProbe = await run(`echo escaped > ${JSON.stringify(marker)}`);
    let leaked = false;
    try {
      await readFile(marker, 'utf8');
      leaked = true;
    } catch {
      leaked = false;
    }
    probes.push({
      name: 'write to $HOME (outside allowWrite)',
      expectation: 'blocked',
      passed: !leaked,
      detail: leaked
        ? 'FILE WAS WRITTEN — the sandbox did not confine this command'
        : `exit ${escapeProbe.exitCode}: ${escapeProbe.stderr.trim().split('\n')[0] ?? 'blocked'}`
    });

    const allowed = await run(
      `echo ok > ${JSON.stringify(inside)} && cat ${JSON.stringify(inside)}`
    );
    probes.push({
      name: 'write inside the workspace',
      expectation: 'allowed',
      passed: allowed.exitCode === 0 && allowed.stdout.includes('ok'),
      detail:
        allowed.exitCode === 0 ? 'succeeded' : `exit ${allowed.exitCode}: ${allowed.stderr.trim()}`
    });

    // Egress is the knob most likely to bite: the runtime has no "allow all",
    // so an empty allowlist denies everything. Which direction is worth
    // probing depends on the policy — with domains configured, the open
    // question is whether the allowlist actually LETS TRAFFIC THROUGH, not
    // whether deny works.
    const target = policy.allowedDomains[0];
    const host = target === undefined ? 'example.com' : stripPort(target).replace(/^\*\./, '');
    const net = await run(
      `curl -s -m 6 -o /dev/null -w '%{http_code}' https://${host} || echo blocked`
    );
    const reachable = net.stdout.includes('200');
    probes.push(
      target === undefined
        ? {
            name: 'egress with an empty allowlist',
            expectation: 'blocked',
            passed: !reachable,
            detail: reachable ? 'REACHABLE — egress is not being restricted' : 'blocked'
          }
        : {
            name: `egress to allowlisted ${host}`,
            expectation: 'reachable',
            passed: reachable,
            detail: reachable
              ? 'reachable (allowlist works on this machine)'
              : 'NOT REACHABLE — the allowlist proxy is not passing traffic here; ' +
                'commands needing the network will hang until they time out'
          }
    );
  } finally {
    // Defensive: these exist only if confinement FAILED.
    await rm(marker, { force: true });
    await rm(inside, { force: true });
  }
  return probes;
}

export async function runDoctor(workspaceRoot: string, config: Config): Promise<number> {
  const out = (line: string) => process.stdout.write(`${line}\n`);
  const status = await probeSandbox();

  out('harness doctor\n');
  out('sandbox');
  out(`  platform    ${status.platform}`);
  out(`  supported   ${status.supported ? 'yes' : 'no'}`);
  out(`  enabled     ${config.sandbox.enabled ? 'yes' : 'no  (set sandbox.enabled=true)'}`);
  for (const error of status.errors) {
    out(`  error       ${error}`);
  }
  for (const warning of status.warnings) {
    out(`  warning     ${warning}`);
  }

  if (!status.supported) {
    out('\nSandboxing is unavailable here; bash would run unconfined.');
    return 1;
  }

  const policy = sandboxPolicyFor(workspaceRoot, config.sandbox);
  // $TMPDIR is writable so build tools work — say so, since "confined to the
  // workspace" would otherwise read as stricter than it is.
  out(`  writable    ${policy.allowWrite.join(', ')}`);
  out(`  denied read ${policy.denyRead.length} credential path(s)`);
  out(
    `  egress      ${
      policy.allowedDomains.length === 0
        ? 'all denied (no sandbox.allowedDomains)'
        : policy.allowedDomains.join(', ')
    }`
  );

  out('\nprobes (sandbox forced on)');
  let failures = 0;
  for (const probe of await runProbes(workspaceRoot, config)) {
    failures += probe.passed ? 0 : 1;
    out(
      `  ${probe.passed ? 'ok  ' : 'FAIL'} ${probe.name.padEnd(34)} ${probe.expectation.padEnd(8)} ${probe.detail}`
    );
  }

  if (failures > 0) {
    out(`\n${failures} probe(s) failed — do not rely on the sandbox on this machine.`);
    return 1;
  }
  out(
    policy.allowedDomains.length === 0
      ? '\nConfinement verified. Set sandbox.enabled=true to use it — but note that egress\n' +
          'is denied entirely until you list domains in sandbox.allowedDomains. Add one and\n' +
          're-run doctor to check that allowlisted traffic actually gets through.'
      : '\nConfinement verified, and the allowlist passes traffic. Safe to set\nsandbox.enabled=true.'
  );
  return 0;
}
