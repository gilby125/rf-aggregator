# blepoll — generic BLE sensor poller

Polls a BLE sensor over **raw ATT** and publishes readings to MQTT for a Telegraf
`mqtt_consumer` adapter to normalise into the `rf_event` envelope.

Everything device-specific lives in a plugin. The transport, retry loop, MQTT sink and CLI
are device-agnostic and shared.

## Status

> **The `airmon` plugin is a refactor of `../airmon/airmon_poller.py`, which is the version
> currently running in production on pve1.** Structure and payload decode are verified
> (decode is asserted against a known-good real payload), but **the refactor has NOT been
> tested end-to-end against the physical device** — the sensor was out of BLE range when it
> was written. `airmon_poller.py` is deliberately left in place until this is proven on
> hardware. Do not swap the running service over until you have seen this produce a real
> reading.

## Why raw ATT and not bleak/BlueZ

Some peripherals ship firmware that breaks BlueZ's GATT service discovery, leaving their
real services unreachable by UUID. The Airmon is one: it answers
`ATT_ERROR_ATTRIBUTE_NOT_FOUND` to any discovery request starting inside its handle gap
(`0x000a`–`0x001a`) rather than returning the next attribute at `0x001b`, so sequential
discovery stops at `0x0009`. Addressing handles directly avoids discovery entirely.

Devices whose discovery works normally can still use this — look their handles up once
(`AttLink.discover_services()`, or the paired phone's cache via
`adb shell dumpsys bluetooth_manager`) and hard-code them in the plugin.

## Layout

```
blepoll/
  transport.py      AttLink — raw ATT over L2CAP. Connect, encrypt, read/write handles,
                    notifications, optional discovery. No device knowledge.
  device.py         BleDevice — the plugin interface.
  devices/
    __init__.py     REGISTRY
    airmon.py       E3 Airmon plugin: handles, commands, notification sequence, decode
  sink.py           MqttSink / StdoutSink
  runner.py         poll loop, retries
  cli.py            argument parsing, plugin + sink selection
```

## Running

Needs a Python with `socket.AF_BLUETOOTH` (system python; linuxbrew's lacks it) and
`paho-mqtt` for the MQTT sink.

```sh
# print envelopes, no MQTT — use this to test a new plugin
python3 -m blepoll --device airmon \
    --mac C2:33:E9:15:D0:F4 --adapter 40:9C:A7:56:81:81 \
    --stdout --once

# normal operation
python3 -m blepoll --device airmon \
    --mac C2:33:E9:15:D0:F4 --adapter 40:9C:A7:56:81:81 \
    --id airmon001-026210 --broker 192.168.1.200 --interval 900
```

Every flag has a `BLEPOLL_*` environment equivalent. `--adapter` is the **local controller's
public address** (`bluetoothctl list`) — binding with the wrong local address type silently
breaks the ATT socket. `--id` becomes the envelope `id` and must be stable across restarts.

## Adding a device

1. Create `blepoll/devices/<name>.py` with a `BleDevice` subclass:

```python
from ..device import BleDevice
from ..transport import CCCD_NOTIFY, CCCD_OFF, SEC_MEDIUM

class MySensor(BleDevice):
    name = "mysensor"
    security = SEC_MEDIUM        # SEC_NONE if the device does not require encryption

    def read(self, link) -> dict:
        link.set_cccd(0x0012, CCCD_NOTIFY)
        link.write_handle(0x0011, bytes([0x01]))
        _, payload = link.await_notification(0x0014, timeout=20.0)
        return {"temperature_C": payload[0] / 10.0}
```

2. Register it in `devices/__init__.py`.

Nothing else changes. Return field names carrying units where ambiguous (`temperature_C`,
not `temperature`) — aggregators average by field name, and mixing units under one name
produces silent nonsense.

## Gotchas the transport already handles

Each of these cost real debugging time; they are handled in `transport.py` so plugins
don't have to think about them:

- `bind()` uses the adapter's **public** identity; the peer address type is per-plugin
- `connect()` happens **before** `setsockopt(BT_SECURITY)` — the reverse yields `ENOSYS`
- The achieved security level is **polled**, because SMP is asynchronous and
  `getsockopt(BT_SECURITY)` on a connected socket returns the *achieved* level, not the
  requested one
- `sockaddr_l2` is built by hand and passed through libc, because older CPython rejects the
  4-tuple L2CAP address form with `bind(): wrong format`
- `connect()` handles `EINPROGRESS` (the socket is non-blocking once a timeout is set)
- Notifications arriving mid-request are queued rather than mistaken for responses

Per-plugin knobs for firmware quirks: `settle_seconds` (absorb unprompted traffic after
encryption — some devices push Service Changed and drop the link if you write over it) and
`negotiate_mtu` (off by default; optional in the spec and some firmware aborts on it).
