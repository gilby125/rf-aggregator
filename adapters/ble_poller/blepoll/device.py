"""The plugin interface. One subclass per BLE device type; nothing else is device-specific.

To support a new sensor, add a module under blepoll/devices/ with a BleDevice subclass and
register it in devices/__init__.py. Everything else - transport, retries, MQTT, CLI - is
reused unchanged.

Deliberately narrow: a plugin declares how to connect (security level, address type) and
implements read(), which drives an already-connected AttLink and returns plain numbers.
It does not open sockets, publish, retry, or log - the runner owns all of that.
"""
from abc import ABC, abstractmethod

from .transport import BDADDR_LE_RANDOM, SEC_MEDIUM


class BleDevice(ABC):
    """Base class for device plugins."""

    #: Short identifier, used for --device and as the default MQTT topic segment.
    name: str = "unnamed"

    #: BLE security to establish before read(). SEC_NONE(0) for open devices;
    #: SEC_MEDIUM(2) for encrypted-but-unauthenticated. SEC_HIGH(3) demands MITM +
    #: Secure Connections, which many older peripherals refuse outright - prefer MEDIUM
    #: unless you know the device supports it.
    security: int = SEC_MEDIUM

    #: Peer address type. Most BLE sensors use a static random address.
    peer_type: int = BDADDR_LE_RANDOM

    #: Seconds to absorb unprompted traffic after connecting, before read(). Some firmware
    #: pushes a Service Changed indication once the link is encrypted and drops the link if
    #: you write over it. 0 disables.
    settle_seconds: float = 0.0

    #: Negotiate a larger ATT MTU before read(). Off by default: it is optional in the spec
    #: and some firmware aborts the link on it. Only enable if payloads exceed 20 bytes.
    negotiate_mtu: bool = False

    @abstractmethod
    def read(self, link) -> dict:
        """Perform one measurement cycle over an established, secured link.

        Args:
            link: a connected `AttLink`.

        Returns:
            A flat dict of numeric fields, e.g. {"temperature_C": 18.2, "pm25": 7}.
            Keys become envelope field names, so include units where they could be
            ambiguous (temperature_C vs temperature_F) - aggregators average by field
            name, and mixing units under one name produces silent nonsense.

        Raises:
            Any exception to signal a failed cycle; the runner handles retries.
        """

    def describe(self) -> str:
        """One-line summary for logs. Override if useful."""
        return f"{self.name} (security={self.security})"
