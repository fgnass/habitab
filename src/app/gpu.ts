// GPU time of a process on macOS: the sum of its Metal clients in the IO
// registry (accumulatedGPUTime, in ns), as Activity Monitor shows it. No
// root needed. Other platforms: undefined.
import { execFile } from 'node:child_process';

export function gpuTimeNs(pid: number): Promise<number | undefined> {
  if (process.platform !== 'darwin') return Promise.resolve(undefined);
  return new Promise(resolve => {
    execFile('/usr/sbin/ioreg', ['-l', '-w', '0', '-r', '-c', 'AGXDeviceUserClient'], { maxBuffer: 16 << 20 }, (err, out) => {
      if (err) return resolve(undefined);
      resolve(sumFor(out, pid));
    });
  });
}

/** The GPU time of one process in ioreg's output (exported for the tests). */
export function sumFor(out: string, pid: number): number {
  let sum = 0;
  for (const block of out.split('+-o ').slice(1)) {
    if (!block.includes(`"IOUserClientCreator" = "pid ${pid},`)) continue;
    for (const m of block.matchAll(/"accumulatedGPUTime"=(\d+)/g)) sum += Number(m[1]);
  }
  return sum;
}
