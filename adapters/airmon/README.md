# airmon adapter

E3 Airmon (エアモン) — a discontinued 2015 Japanese BLE PM2.5/PM10/temperature/humidity
monitor — into the `rf_event` envelope.

Unlike [`../rtl433/`](../rtl433/), this adapter is **not config-only**. `rtl_433` is an
external decoder that already publishes to MQTT; the Airmon has no such decoder, so
`airmon_poller.py` here **is** the decoder. Two pieces:

| File | Role |
|---|---|
| `airmon_poller.py` | Polls the device over BLE, publishes native JSON to `AIRMON_TOPIC`. Runs within BLE range of the device. |
| `adapter.conf` | Telegraf `mqtt_consumer` → `rf_event` envelope (see [docs/CONTRACTS.md](../../docs/CONTRACTS.md) §1). Runs in the backend. |

Because the two halves talk over MQTT, only the poller must be near the device — the
rf-aggregator backend can live anywhere.

## Envelope produced

```json
{"name":"rf_event",
 "tags":{"source":"airmon","type":"sensor","id":"airmon001-026210"},
 "fields":{"temperature_C":24.8,"humidity":47.5,"pm25":1,"pm10":1},
 "timestamp":1784512748}
```

Fields use **`temperature_C`**, not `temperature_F`. `aggregators.basicstats` computes
per-group means by field name, so distinct names stop Celsius and Fahrenheit being averaged
together if a group ever spans both this and the rtl433 adapter.

## Running the poller

Needs the **system python** (`/usr/bin/python3`). A python built without
`socket.AF_BLUETOOTH` (linuxbrew's, for one) cannot open the raw ATT socket this uses.

```sh
/usr/bin/python3 -m pip install --user paho-mqtt

/usr/bin/python3 airmon_poller.py \
    --broker <backend-host> \
    --interval 900          # seconds; default 900 = 15 min

/usr/bin/python3 airmon_poller.py --once     # single reading, for testing
```

All flags have `AIRMON_*` environment equivalents: `AIRMON_MAC`, `AIRMON_ADAPTER`,
`AIRMON_ID`, `AIRMON_BROKER`, `AIRMON_PORT`, `AIRMON_TOPIC`, `AIRMON_INTERVAL`,
`AIRMON_RETRIES`.

`--id` is the envelope `id` and **must be stable across restarts** (contract requirement).

## One-time device setup

The device must be bonded to the host running the poller:

```sh
( echo "agent NoInputNoOutput"; sleep 2; echo "default-agent"; sleep 2; echo "scan on";
  sleep 12; echo "pair C2:33:E9:15:D0:F4"; sleep 22; echo "quit" ) | bluetoothctl

bluetoothctl untrust C2:33:E9:15:D0:F4   # stop bluetoothd racing the poller's socket
```

`bluetoothctl` **needs an explicit agent** — without it pairing fails with
`org.bluez.Error.AuthenticationCanceled`. Keep `bluetoothd` running: it loads the LTKs into
the kernel via mgmt, and kernel SMP cannot encrypt without them.

> **The device holds exactly ONE bond.** Pairing a phone to it (the official app, nRF
> Connect, anything) **invalidates this host's keys**. The symptom is
> `Encryption Change — PIN or Key Missing (0x06)` and every read failing. Re-pair to recover.

## Why this talks raw ATT instead of using bleak

The firmware answers `ATT_ERROR_ATTRIBUTE_NOT_FOUND` to any discovery request whose start
handle lands in its handle gap (`0x000a`–`0x001a`) instead of returning the next attribute at
`0x001b`. Sequential GATT discovery therefore stops at `0x0009` and never sees the vendor
service, so BlueZ — and anything built on it — cannot reach the device by UUID. The poller
skips discovery and addresses known handles directly.

Handle map (recovered from a paired Android phone via
`adb shell dumpsys bluetooth_manager`, section `gatt_cache_<mac>` — no root required):

```
0x001b-0x0027  service baeff316-6be0-4264-9401-142f3e28cf55
  0x001d  REQUEST  7121461c-...  read|write|notify   CCCD 0x001e
  0x0020  cd4d5f64-...  write
  0x0022  DATA     e4856e91-...  read|write|notify   CCCD 0x0023
  0x0025  feb02176-...  indicate
```

## Constraints that are load-bearing

Changing any of these breaks it. All were confirmed with `btmon`:

1. `bind()` with the **adapter's public identity** (type 1). Destination is type 2 (static
   random). A wildcard/random local bind fails.
2. `connect()` **first**, *then* `setsockopt(BT_SECURITY)`. The reverse order yields `ENOSYS`.
3. **Poll** for the achieved security level — SMP is asynchronous (~200–400 ms).
   `getsockopt(BT_SECURITY)` on a connected socket returns the *achieved* level, not the
   requested one, so reading it immediately looks like failure.
4. Request **MEDIUM (2) only**. `HIGH (3)` makes the kernel demand MITM + Secure Connections;
   this device offers only `Bonding, No MITM, Legacy` and SMP dies with
   `Pairing Failed — Authentication requirements (0x03)`.
5. **Never enable both CCCDs at once.** The app strictly alternates
   (`REQUEST` → write → ack → `DATA` → payload). Enabling both makes the device drop the link.

## Payload format

16 bytes, confirmed against `Atmospheric.parseSensorData()` in the decompiled app *and*
against real device payloads:

```
[0:2]   command echo (0x01 0x02)
[2:8]   device clock: YY MM DD HH MM SS (raw byte values, year + 2000)
[8:10]  temp     int16  LE, /10 -> C
[10:12] humidity uint16 LE, /10 -> %     <- also /10
[12:14] pm25     uint16 LE, ug/m3
[14:16] pm10     uint16 LE, ug/m3
```

Example `01021a07140618050c01e5010a000300` → `2026-07-20 06:24:05, 26.8 C, 48.5 %, pm25 10,
pm10 3`. The device's clock drifts and is **not** used as the event timestamp — the poller
stamps with host time.

## Reliability

This is 2015 hardware and it drops connections often; the owner reports it needs periodic
button resets. The poller retries `--retries` times per cycle (default 5). A cycle that fails
entirely **publishes nothing** rather than republishing a stale value, so the sensor ages out
of `catalog.last_seen` and shows as stale downstream instead of appearing frozen-but-live.

Long-term unattended operation has **not** been validated — only single and repeated manual
cycles.
