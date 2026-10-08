import { spawnSync } from 'node:child_process';

/**
 * `preflight [android] [ios]` — checks the things a Capacitor build needs
 * before it fails halfway through with a Gradle stack trace that does not
 * mention any of them.
 *
 * Only the platforms named are checked, so each mobile shell's `preflight`
 * asks only about its own: an Android-only app on a Mac without Xcode is not a
 * failed preflight. With none named, both are.
 */
export function preflight(args: readonly string[]): number {
  const platforms = args.length > 0 ? args : ['android', 'ios'];
  const unknown = platforms.filter((platform) => platform !== 'android' && platform !== 'ios');
  if (unknown.length > 0) {
    process.stderr.write(`preflight: unknown platform ${unknown.join(', ')}. Use android, ios.\n`);
    return 2;
  }

  let failed = false;
  const note = (what: string, detail: string) =>
    process.stdout.write(`  ${what.padEnd(22)} ${detail}\n`);
  const missing = (what: string, detail: string) => {
    note(what, `MISSING — ${detail}`);
    failed = true;
  };

  process.stdout.write(`Capacitor preflight (${platforms.join(' ')})\n`);

  if (platforms.includes('android')) {
    // `java -version` prints to stderr.
    const java = firstLine('java', ['-version'], 'stderr');
    if (java) note('java', java);
    else missing('java', 'Android builds need a JDK (17 or newer)');

    const sdk = process.env['ANDROID_HOME'] || process.env['ANDROID_SDK_ROOT'];
    if (sdk) note('android sdk', sdk);
    else missing('android sdk', 'set ANDROID_HOME or ANDROID_SDK_ROOT');
  }

  if (platforms.includes('ios')) {
    if (process.platform !== 'darwin') {
      note('xcode', 'skipped (iOS builds require macOS)');
    } else {
      const xcode = firstLine('xcodebuild', ['-version'], 'stdout');
      if (xcode) note('xcode', xcode);
      else missing('xcode', 'iOS builds need Xcode and its command line tools');
    }
  }

  if (failed) {
    process.stdout.write('\nPreflight failed. Fix the items marked MISSING above.\n');
    return 1;
  }
  process.stdout.write('\nPreflight passed.\n');
  return 0;
}

/** The first line a command prints, or `undefined` when it is not there to run. */
function firstLine(
  command: string,
  args: string[],
  stream: 'stdout' | 'stderr',
): string | undefined {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    return undefined;
  }
  return result[stream].split('\n')[0]?.trim() || undefined;
}
