#!/usr/bin/env python3
"""E3 Airmon BLE -> MQTT poller. The "decoder" half of the airmon adapter.

Unlike the rtl433 adapter (config only - rtl_433 is an external decoder already publishing
to MQTT), the Airmon has no decoder, so this program is it. It polls the device over BLE and
publishes native JSON to AIRMON_TOPIC; adapter.conf then normalises that into the rf_event
envelope (see docs/CONTRACTS.md section 1).

Runs wherever there is BLE range to the device; reaches the backend over MQTT, so the
rf-aggregator backend itself can live anywhere.

REQUIRES the system python (/usr/bin/python3) - a python built without socket.AF_BLUETOOTH
(e.g. linuxbrew's) cannot open the raw ATT socket this uses.

Why raw ATT instead of bleak/BlueZ
----------------------------------
The device's firmware answers ATT_ERROR_ATTRIBUTE_NOT_FOUND to any discovery request whose
start handle lands in its handle gap (0x000a-0x001a) rather than returning the next
attribute at 0x001b. Sequential GATT discovery therefore stops at 0x0009 and never sees the
vendor service, so BlueZ/bleak cannot reach it. We skip discovery and address known handles.

Hard-won requirements (all verified with btmon; change at your peril):
  * bind() with the ADAPTER'S PUBLIC identity (type 1). Destination is type 2 (static random).
  * connect() FIRST, then setsockopt(BT_SECURITY) - the reverse order yields ENOSYS.
  * POLL for the achieved security level; SMP is asynchronous (~200-400 ms).
  * Request MEDIUM (2) only. HIGH (3) makes the kernel demand MITM + Secure Connections;
    this 2015 device offers only "Bonding, No MITM, Legacy" and SMP fails with
    "Authentication requirements (0x03)".
  * The device holds ONE bond. Pairing a phone to it invalidates this host's keys and you
    will see "Encryption Change - PIN or Key Missing (0x06)". Re-pair with:
        ( echo "agent NoInputNoOutput"; sleep 2; echo "default-agent"; sleep 2;
          echo "scan on"; sleep 12; echo "pair <MAC>"; sleep 22; echo "quit" ) | bluetoothctl
  * bluetoothd must stay RUNNING (it loads the LTKs into the kernel via mgmt), but the device
    should be UNTRUSTED so bluetoothd does not auto-reconnect and race this socket.
"""
import argparse
import ctypes
import ctypes.util
import errno
import json
import os
import select
import socket
import struct
import sys
import time

# ---- BLE constants -------------------------------------------------------------------
SOL_BLUETOOTH, BT_SECURITY = 274, 4
SEC_MEDIUM = 2
BDADDR_LE_PUBLIC, BDADDR_LE_RANDOM = 1, 2
ATT_CID = 4

H_REQUEST, H_REQUEST_CCCD = 0x001D, 0x001E
H_DATA, H_DATA_CCCD = 0x0022, 0x0023
CMD_READ_SENSOR = bytes([0x01, 0x01])
NOTIFY_ON = struct.pack("<H", 0x0001)
NOTIFY_OFF = struct.pack("<H", 0x0000)

ATT_ERRORS = {0x02: "read not permitted", 0x03: "write not permitted",
              0x05: "insufficient authentication", 0x08: "insufficient authorization",
              0x0A: "attribute not found", 0x0F: "insufficient encryption"}


def log(msg):
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)


def att_error(pdu):
    if len(pdu) >= 5 and pdu[0] == 0x01:
        return f"ATT 0x{pdu[4]:02x} ({ATT_ERRORS.get(pdu[4], 'unknown')})"
    return None


def _sec_level(s):
    return struct.unpack("BB", s.getsockopt(SOL_BLUETOOTH, BT_SECURITY, 2))[0]


# --- portable L2CAP addressing ------------------------------------------------------
# CPython only accepts the 4-tuple L2CAP address (bdaddr, psm, cid, bdaddr_type) in recent
# versions; on older ones (e.g. 3.11 on Debian bookworm) it raises "bind(): wrong format".
# We need cid=4 (ATT) and an explicit address type, so build the sockaddr_l2 ourselves and
# call bind/connect through libc. Works on every version.
#
#   struct sockaddr_l2 {
#       sa_family_t     l2_family;       uint16
#       unsigned short  l2_psm;          uint16, little-endian
#       bdaddr_t        l2_bdaddr;       6 bytes, reversed
#       unsigned short  l2_cid;          uint16, little-endian
#       uint8_t         l2_bdaddr_type;  uint8
#   };
_libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)


def _sockaddr_l2(bdaddr, psm, cid, addr_type):
    raw = bytes(int(x, 16) for x in reversed(bdaddr.split(":")))
    return struct.pack("<HH6sHB", socket.AF_BLUETOOTH, psm, raw, cid, addr_type) + b"\x00"


def _libc_call(fn, sock, sa, what):
    buf = ctypes.create_string_buffer(sa, len(sa))
    if fn(sock.fileno(), buf, len(sa)) != 0:
        e = ctypes.get_errno()
        raise OSError(e, f"{what}: {os.strerror(e)}")


def _l2_bind(sock, bdaddr, psm, cid, addr_type):
    _libc_call(_libc.bind, sock, _sockaddr_l2(bdaddr, psm, cid, addr_type), "bind")


def _l2_connect(sock, bdaddr, psm, cid, addr_type, timeout):
    """Connect, handling EINPROGRESS.

    sock.settimeout() puts the fd in non-blocking mode, so libc connect() returns
    EINPROGRESS rather than blocking (Python's native .connect() hides this). Wait for
    writability, then read SO_ERROR for the real result.
    """
    sa = _sockaddr_l2(bdaddr, psm, cid, addr_type)
    buf = ctypes.create_string_buffer(sa, len(sa))
    if _libc.connect(sock.fileno(), buf, len(sa)) == 0:
        return
    err = ctypes.get_errno()
    if err not in (errno.EINPROGRESS, errno.EALREADY):
        raise OSError(err, f"connect: {os.strerror(err)}")

    _, wfds, _ = select.select([], [sock], [], timeout)
    if not wfds:
        raise TimeoutError("connect: timed out")
    so_err = sock.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR)
    if so_err != 0:
        raise OSError(so_err, f"connect: {os.strerror(so_err)}")


def connect_encrypted(mac, adapter, timeout=20.0, smp_wait=12.0):
    s = socket.socket(socket.AF_BLUETOOTH, socket.SOCK_SEQPACKET, 0)
    s.settimeout(timeout)
    _l2_bind(s, adapter, 0, ATT_CID, BDADDR_LE_PUBLIC)
    _l2_connect(s, mac, 0, ATT_CID, BDADDR_LE_RANDOM, timeout)
    s.setsockopt(SOL_BLUETOOTH, BT_SECURITY, struct.pack("BB", SEC_MEDIUM, 0))

    deadline = time.time() + smp_wait
    while time.time() < deadline:
        if _sec_level(s) >= SEC_MEDIUM:
            return s
        time.sleep(0.2)
    s.close()
    raise RuntimeError(f"encryption did not complete within {smp_wait}s")


def _write(s, handle, value):
    s.send(struct.pack("<BH", 0x12, handle) + value)
    r = s.recv(512)
    e = att_error(r)
    if e:
        raise RuntimeError(f"write 0x{handle:04x}: {e}")


def _await_notify(s, want_handle, timeout):
    end = time.time() + timeout
    while time.time() < end:
        s.settimeout(max(1.0, end - time.time()))
        try:
            r = s.recv(512)
        except socket.timeout:
            return None
        if not r:
            return None
        if r[0] in (0x1B, 0x1D):
            h = struct.unpack("<H", r[1:3])[0]
            v = r[3:]
            if r[0] == 0x1D:
                s.send(bytes([0x1E]))       # indications must be confirmed
            if h == want_handle:
                return v
    return None


def decode(b):
    """16-byte payload. Confirmed against Atmospheric.parseSensorData() and real payloads.

      [0:2]   command echo (0x01 0x02)
      [2:8]   device clock: YY MM DD HH MM SS (raw byte values; year + 2000)
      [8:10]  temp     int16  LE, /10 -> C
      [10:12] humidity uint16 LE, /10 -> %
      [12:14] pm25     uint16 LE, ug/m3
      [14:16] pm10     uint16 LE, ug/m3

    Sample 01021a07140618050c01e5010a000300
        -> 2026-07-20 06:24:05, 26.8 C, 48.5 %, pm25 10, pm10 3
    The device's own clock drifts and is NOT used as the event timestamp.
    """
    if len(b) < 16:
        return None
    yy, mm, dd, hh, mi, ss = b[2:8]
    device_time = None
    if not (yy == mm == dd == 0xFF):
        device_time = f"20{yy:02d}-{mm:02d}-{dd:02d} {hh:02d}:{mi:02d}:{ss:02d}"
    return {
        "temperature_C": struct.unpack("<h", b[8:10])[0] / 10.0,
        "humidity": struct.unpack("<H", b[10:12])[0] / 10.0,
        "pm25": struct.unpack("<H", b[12:14])[0],
        "pm10": struct.unpack("<H", b[14:16])[0],
        "_device_time": device_time,
    }


def read_sensor(mac, adapter):
    """One full measurement cycle. Returns the decoded dict, or raises."""
    s = connect_encrypted(mac, adapter)
    try:
        # The app never has both CCCDs enabled at once; enabling both makes the device drop
        # the link. Strict alternation, per BluetoothLeService.onDescriptorWrite.
        _write(s, H_REQUEST_CCCD, NOTIFY_ON)
        _write(s, H_REQUEST, CMD_READ_SENSOR)
        _await_notify(s, H_REQUEST, 10.0)          # ack; often absent, not required

        _write(s, H_REQUEST_CCCD, NOTIFY_OFF)
        _write(s, H_DATA_CCCD, NOTIFY_ON)

        payload = _await_notify(s, H_DATA, 30.0)
        if payload is None:
            raise RuntimeError("no DATA notification")
        reading = decode(payload)
        if reading is None:
            raise RuntimeError(f"short payload: {payload.hex()}")
        reading["_raw"] = payload.hex()
        try:
            _write(s, H_DATA_CCCD, NOTIFY_OFF)
        except Exception:
            pass                                    # cleanup only
        return reading
    finally:
        try:
            s.close()
        except Exception:
            pass


def publish(client, topic, sensor_id, reading):
    """Native JSON for adapter.conf to normalise. json_time_key = "time"."""
    msg = {
        "time": int(time.time()),
        "id": sensor_id,
        "temperature_C": reading["temperature_C"],
        "humidity": reading["humidity"],
        "pm25": reading["pm25"],
        "pm10": reading["pm10"],
    }
    client.publish(topic, json.dumps(msg), qos=0)
    return msg


def main():
    p = argparse.ArgumentParser(description="E3 Airmon BLE -> MQTT poller")
    p.add_argument("--mac", default=os.environ.get("AIRMON_MAC", "C2:33:E9:15:D0:F4"))
    p.add_argument("--adapter", default=os.environ.get("AIRMON_ADAPTER", "EC:8E:77:03:FC:04"),
                   help="local BT adapter's PUBLIC address")
    p.add_argument("--id", default=os.environ.get("AIRMON_ID", "airmon001-026210"),
                   help="stable envelope id (must not change across restarts)")
    p.add_argument("--broker", default=os.environ.get("AIRMON_BROKER", "127.0.0.1"))
    p.add_argument("--port", type=int, default=int(os.environ.get("AIRMON_PORT", "1883")))
    p.add_argument("--topic", default=os.environ.get("AIRMON_TOPIC", "airmon/events"))
    p.add_argument("--interval", type=int,
                   default=int(os.environ.get("AIRMON_INTERVAL", "900")),
                   help="seconds between measurements (default 900 = 15 min)")
    p.add_argument("--retries", type=int, default=int(os.environ.get("AIRMON_RETRIES", "5")),
                   help="attempts per cycle; this device drops links often")
    p.add_argument("--once", action="store_true", help="single reading, then exit")
    args = p.parse_args()

    import paho.mqtt.client as mqtt
    # paho 2.x requires the callback-API version as the first positional arg; 1.x (still
    # what Debian bookworm ships as python3-paho-mqtt) does not have it at all.
    if hasattr(mqtt, "CallbackAPIVersion"):
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2,
                             client_id=f"airmon-poller-{args.id}")
    else:
        client = mqtt.Client(client_id=f"airmon-poller-{args.id}")
    client.connect(args.broker, args.port, keepalive=60)
    client.loop_start()
    log(f"MQTT {args.broker}:{args.port} topic={args.topic} id={args.id}")
    log(f"polling {args.mac} every {args.interval}s (retries={args.retries})")

    try:
        while True:
            reading = None
            for attempt in range(1, args.retries + 1):
                try:
                    reading = read_sensor(args.mac, args.adapter)
                    break
                except Exception as e:
                    log(f"attempt {attempt}/{args.retries}: {e}")
                    time.sleep(4.0)

            if reading:
                msg = publish(client, args.topic, args.id, reading)
                log(f"published {msg['temperature_C']}C {msg['humidity']}% "
                    f"pm25={msg['pm25']} pm10={msg['pm10']}  raw={reading['_raw']}")
            else:
                # No stale republish: a missed cycle must look missing downstream, so
                # last_seen ages out and the sensor shows as stale rather than frozen.
                log(f"cycle FAILED after {args.retries} attempts; publishing nothing")

            if args.once:
                return 0 if reading else 1
            time.sleep(args.interval)
    except KeyboardInterrupt:
        log("stopped")
        return 0
    finally:
        client.loop_stop()
        client.disconnect()


if __name__ == "__main__":
    sys.exit(main())
