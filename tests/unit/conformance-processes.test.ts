import { open } from 'node:fs/promises';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';

describe.skipIf(process.platform === 'win32')('owned conformance process groups', () => {
  it.each(['before-stop', 'on-term'])('reaps a TERM-resistant descendant when its leader exits %s', async mode => {
    const { start, stop } = await import('../../scripts/run-conformance.mjs');
    const directory = mkdtempSync(join(tmpdir(), 'transit-process-regression-'));
    const log = await open(join(directory, 'process.log'), 'w');
    const pidFile = join(directory, 'descendant.pid');
    const descendantCode = `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.send('ready');`;
    const leaderCode = `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantCode)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      child.on('message', () => {
        require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
        child.disconnect(); child.unref();
        ${mode === 'before-stop' ? 'process.exit(0);' : "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);"}
      });
    `;
    const leader = start(['-e', leaderCode], directory, log, { PATH: process.env.PATH });
    const unrelated = start(['-e', 'setInterval(() => {}, 1000)'], directory, log, { PATH: process.env.PATH });
    try {
      await expect.poll(() => existsSync(pidFile)).toBe(true);
      if (mode === 'before-stop') await leader.done;
      const descendant = Number(readFileSync(pidFile, 'utf8'));
      expect(() => process.kill(descendant, 0)).not.toThrow();
      await Promise.all([stop(leader), stop(leader)]);
      expect(() => process.kill(descendant, 0)).toThrow();
      expect(() => process.kill(-leader.child.pid!, 0)).toThrow();
      expect(() => process.kill(unrelated.child.pid!, 0)).not.toThrow();
      await stop(leader); // Idempotent even after the entire group disappeared.
    } finally {
      // Only groups created by this test, including on the intentional RED run.
      for (const owned of [leader, unrelated]) {
        try { process.kill(-owned.child.pid!, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
      await Promise.all([leader.done, unrelated.done]);
      await delay(100);
      await log.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);
});
