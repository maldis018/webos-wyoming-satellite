'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { findDevices } = require('../src/keys');

// Trimmed from /proc/bus/input/devices on an LG OLED55CX (webOS 5.6.2).
const DEVICES = `I: Bus=0019 Vendor=0000 Product=0000 Version=0000
N: Name="CHECK INPUT"
H: Handlers=kbd event0

I: Bus=0019 Vendor=0000 Product=0000 Version=0000
N: Name="LGE RCU"
H: Handlers=kbd event1

I: Bus=0019 Vendor=0000 Product=0000 Version=0000
N: Name="Bluetooth-audio-source"
H: Handlers=kbd event2

I: Bus=0019 Vendor=0000 Product=0000 Version=0000
N: Name="LGE M-RCU - Builtin [0]"
H: Handlers=kbd mouse0 event3

I: Bus=0019 Vendor=0000 Product=0000 Version=0000
N: Name="LGE Network Input"
H: Handlers=kbd mouse6 event9

I: Bus=0019 Vendor=0000 Product=0000 Version=0000
N: Name="Smart Remote RCU Input"
H: Handlers=kbd mouse5 event8
`;

test('findDevices picks the remote devices and skips the rest', () => {
  const found = findDevices(DEVICES, /LGE RCU|LGE M-RCU|Smart Remote RCU Input|LGE Simple Premium/);
  assert.deepEqual(found.map((d) => d.path), ['/dev/input/event1', '/dev/input/event3', '/dev/input/event8']);
  assert.equal(found[1].name, 'LGE M-RCU - Builtin [0]');
});

test('findDevices copes with no match and with junk', () => {
  assert.deepEqual(findDevices('', /x/), []);
  assert.deepEqual(findDevices('N: Name="LGE RCU"\n', /LGE RCU/), [], 'no handlers line');
});
