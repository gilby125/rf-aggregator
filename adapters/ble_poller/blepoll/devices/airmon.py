"""E3 Airmon (エアモン) - discontinued 2015 BLE PM2.5/PM10/temperature/humidity monitor.

Everything peculiar to this device lives here. All of it was established against real
hardware with btmon; see adapters/airmon/README.md for the full account.

WHY HANDLES, NOT UUIDS
The firmware answers ATT_ERROR_ATTRIBUTE_NOT_FOUND to any discovery request whose start
handle falls in its handle gap (0x000a-0x001a) instead of returning the next attribute at
0x001b. Sequential discovery therefore stops at 0x0009 and never sees the vendor service,
so BlueZ - and anything built on it - cannot reach this device by UUID. Handles below came
from the paired phone's own GATT cache (`adb shell dumpsys bluetooth_manager`, section
gatt_cache_<mac>), which needs no root.

    0x001b-0x0027  service baeff316-6be0-4264-9401-142f3e28cf55
      0x001d  REQUEST  7121461c-...  read|write|notify   CCCD 0x001e
      0x0020  cd4d5f64-...  write
      0x0022  DATA     e4856e91-...  read|write|notify   CCCD 0x0023
      0x0025  feb02176-...  indicate

OTHER LOAD-BEARING QUIRKS
  * The vendor service rejects unencrypted access with ATT 0x05, so security=MEDIUM.
    HIGH fails: the kernel then demands MITM + Secure Connections and this device offers
    only "Bonding, No MITM, Legacy", so SMP dies with "Authentication requirements (0x03)".
  * Notifications strictly ALTERNATE. The official app never has both CCCDs enabled at
    once, and enabling both makes the device drop the link.
  * The device holds exactly ONE bond. Pairing anything else to it invalidates this host's
    key; the symptom is "Encryption Change - PIN or Key Missing (0x06)".
"""
import struct

from ..device import BleDevice
from ..transport import CCCD_NOTIFY, CCCD_OFF, SEC_MEDIUM

H_REQUEST, H_REQUEST_CCCD = 0x001D, 0x001E
H_DATA, H_DATA_CCCD = 0x0022, 0x0023

# Commands written to the REQUEST characteristic (from the decompiled app's
# BluetoothLeService: requestAbout / requestReadSensorData / requestTimerStop).
CMD_ABOUT = bytes([0x21, 0x00])
CMD_READ_SENSOR = bytes([0x01, 0x01])
CMD_TIMER_STOP = bytes([0x42, 0x01])


class AirmonDevice(BleDevice):
    name = "airmon"
    security = SEC_MEDIUM
    settle_seconds = 2.0        # absorb the post-encryption Service Changed indication
    negotiate_mtu = False       # 16-byte payload fits the default 23-byte MTU

    def read(self, link) -> dict:
        # Alternation, exactly as the app does it. Enabling both CCCDs drops the link.
        link.set_cccd(H_REQUEST_CCCD, CCCD_NOTIFY)
        link.write_handle(H_REQUEST, CMD_READ_SENSOR)
        link.await_notification(H_REQUEST, timeout=10.0)   # ack; often absent, not required

        link.set_cccd(H_REQUEST_CCCD, CCCD_OFF)
        link.set_cccd(H_DATA_CCCD, CCCD_NOTIFY)

        got = link.await_notification(H_DATA, timeout=30.0)
        payload = got[1] if got else link.read_handle(H_DATA)

        try:
            link.set_cccd(H_DATA_CCCD, CCCD_OFF)
        except Exception:
            pass                                            # cleanup only

        fields = decode(payload)
        if fields is None:
            raise ValueError(f"short payload: {bytes(payload).hex()}")
        return fields


def decode(b) -> dict | None:
    """Decode the 16-byte payload.

    Confirmed against the app's Atmospheric.parseSensorData() AND real device payloads:

      [0:2]   command echo (0x01 0x02)
      [2:8]   device clock: YY MM DD HH MM SS (raw byte values, year + 2000)
      [8:10]  temp     int16  LE, /10 -> C
      [10:12] humidity uint16 LE, /10 -> %   <- also /10; an earlier version missed this
                                                and reported 485%
      [12:14] pm25     uint16 LE, ug/m3
      [14:16] pm10     uint16 LE, ug/m3

    Sample 01021a07140618050c01e5010a000300
        -> 2026-07-20 06:24:05, 26.8 C, 48.5 %, pm25 10, pm10 3

    The device's own clock drifts and is NOT returned - the runner stamps with host time.
    """
    b = bytes(b)
    if len(b) < 16:
        return None
    return {
        "temperature_C": struct.unpack("<h", b[8:10])[0] / 10.0,
        "humidity": struct.unpack("<H", b[10:12])[0] / 10.0,
        "pm25": struct.unpack("<H", b[12:14])[0],
        "pm10": struct.unpack("<H", b[14:16])[0],
    }
