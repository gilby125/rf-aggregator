"""Device plugin registry.

Adding a device:
  1. Write blepoll/devices/<name>.py with a BleDevice subclass.
  2. Import and add it to REGISTRY below.
Nothing else changes - transport, retries, MQTT and CLI are all device-agnostic.
"""
from .airmon import AirmonDevice

REGISTRY = {
    AirmonDevice.name: AirmonDevice,
}


def get(name):
    try:
        return REGISTRY[name]()
    except KeyError:
        raise SystemExit(f"unknown device '{name}'. known: {', '.join(sorted(REGISTRY))}")


def names():
    return sorted(REGISTRY)
