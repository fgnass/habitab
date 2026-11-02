import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sumFor } from '../../app/gpu';

// Shape of `ioreg -l -w 0 -r -c AGXDeviceUserClient` (shortened).
const out = `+-o AGXDeviceUserClient  <class AGXDeviceUserClient, id 0x1>
    {
      "IOUserClientCreator" = "pid 410, WindowServer"
      "AppUsage" = ({"API"="Metal","lastSubmittedTime"=1,"accumulatedGPUTime"=500})
    }
+-o AGXDeviceUserClient  <class AGXDeviceUserClient, id 0x2>
    {
      "IOUserClientCreator" = "pid 4100, Habitab Helper"
      "AppUsage" = ({"API"="Metal","lastSubmittedTime"=2,"accumulatedGPUTime"=1000},{"API"="Metal","lastSubmittedTime"=3,"accumulatedGPUTime"=234})
    }
+-o AGXDeviceUserClient  <class AGXDeviceUserClient, id 0x3>
    {
      "IOUserClientCreator" = "pid 4100, Habitab Helper"
      "AppUsage" = ({"API"="Metal","lastSubmittedTime"=4,"accumulatedGPUTime"=6})
    }
`;

test('GPU time of a process: all its Metal clients, no other process', () => {
  assert.equal(sumFor(out, 4100), 1240);
  assert.equal(sumFor(out, 410), 500);
  assert.equal(sumFor(out, 41), 0);
});
