"""Generic raw-ATT-over-L2CAP transport. No device-specific knowledge lives here.

Why raw ATT rather than bleak/BlueZ: some peripherals have firmware that breaks BlueZ's
GATT service discovery, leaving their real services unreachable by UUID. Addressing
attribute handles directly sidesteps discovery entirely. Devices whose discovery works fine
can still be driven through this by looking their handles up once.

Portability notes, each of which cost real debugging:
  * CPython only accepts the 4-tuple L2CAP address (bdaddr, psm, cid, bdaddr_type) in
    recent versions; older ones raise "bind(): wrong format". We build the sockaddr_l2
    ourselves and call bind/connect through libc, which works on every version.
  * bind() must use the local adapter's PUBLIC identity address. Binding with the wrong
    local address type silently breaks the ATT channel.
  * connect() must happen BEFORE setsockopt(BT_SECURITY); the reverse order yields ENOSYS.
  * getsockopt(BT_SECURITY) on a CONNECTED socket returns the ACHIEVED level, not the
    requested one, and SMP is asynchronous. Poll it - reading once immediately looks like
    failure even on a link that is about to succeed.
"""
import ctypes
import ctypes.util
import errno
import os
import select
import socket
import struct
import time

AF_BLUETOOTH = getattr(socket, "AF_BLUETOOTH", 31)
BTPROTO_L2CAP = 0
ATT_CID = 4

BDADDR_LE_PUBLIC, BDADDR_LE_RANDOM = 1, 2

SOL_BLUETOOTH, BT_SECURITY = 274, 4
SEC_NONE, SEC_LOW, SEC_MEDIUM, SEC_HIGH = 0, 1, 2, 3

# ATT opcodes
OP_ERROR = 0x01
OP_MTU_REQ, OP_MTU_RSP = 0x02, 0x03
OP_FIND_INFO_REQ, OP_FIND_INFO_RSP = 0x04, 0x05
OP_READ_REQ, OP_READ_RSP = 0x0A, 0x0B
OP_READ_BY_GROUP_REQ, OP_READ_BY_GROUP_RSP = 0x10, 0x11
OP_WRITE_REQ, OP_WRITE_RSP = 0x12, 0x13
OP_NOTIFY, OP_INDICATE, OP_CONFIRM = 0x1B, 0x1D, 0x1E

ATT_ERRORS = {
    0x01: "invalid handle", 0x02: "read not permitted", 0x03: "write not permitted",
    0x05: "insufficient authentication", 0x08: "insufficient authorization",
    0x0A: "attribute not found", 0x0C: "insufficient encryption key size",
    0x0F: "insufficient encryption",
}

CCCD_NOTIFY = struct.pack("<H", 0x0001)
CCCD_INDICATE = struct.pack("<H", 0x0002)
CCCD_OFF = struct.pack("<H", 0x0000)

_libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)


class AttError(RuntimeError):
    """The peer returned an ATT error response."""

    def __init__(self, code, handle):
        self.code, self.handle = code, handle
        super().__init__(f"ATT 0x{code:02x} ({ATT_ERRORS.get(code, 'unknown')}) "
                         f"on handle 0x{handle:04x}")


def _sockaddr_l2(bdaddr, psm, cid, addr_type):
    raw = bytes(int(x, 16) for x in reversed(bdaddr.split(":")))
    return struct.pack("<HH6sHB", AF_BLUETOOTH, psm, raw, cid, addr_type) + b"\x00"


class AttLink:
    """One ATT connection. Handle-addressed; knows nothing about any particular device."""

    def __init__(self, sock, mtu=23):
        self._s = sock
        self.mtu = mtu
        self._pending = []          # notifications received while awaiting a response

    # -- lifecycle ---------------------------------------------------------------------
    @classmethod
    def connect(cls, mac, adapter, security=SEC_MEDIUM, timeout=20.0,
                smp_wait=12.0, peer_type=BDADDR_LE_RANDOM):
        s = socket.socket(AF_BLUETOOTH, socket.SOCK_SEQPACKET, BTPROTO_L2CAP)
        s.settimeout(timeout)

        sa = _sockaddr_l2(adapter, 0, ATT_CID, BDADDR_LE_PUBLIC)
        buf = ctypes.create_string_buffer(sa, len(sa))
        if _libc.bind(s.fileno(), buf, len(sa)) != 0:
            e = ctypes.get_errno()
            s.close()
            raise OSError(e, f"bind: {os.strerror(e)}")

        cls._connect_fd(s, mac, peer_type, timeout)

        if security:
            s.setsockopt(SOL_BLUETOOTH, BT_SECURITY, struct.pack("BB", security, 0))
            if not cls._await_security(s, security, smp_wait):
                s.close()
                raise RuntimeError(f"encryption did not reach level {security} "
                                   f"within {smp_wait}s")
        return cls(s)

    @staticmethod
    def _connect_fd(s, mac, peer_type, timeout):
        sa = _sockaddr_l2(mac, 0, ATT_CID, peer_type)
        buf = ctypes.create_string_buffer(sa, len(sa))
        if _libc.connect(s.fileno(), buf, len(sa)) == 0:
            return
        e = ctypes.get_errno()
        if e not in (errno.EINPROGRESS, errno.EALREADY):
            s.close()
            raise OSError(e, f"connect: {os.strerror(e)}")
        # settimeout() made the fd non-blocking, so connect() returns EINPROGRESS.
        _, w, _ = select.select([], [s], [], timeout)
        if not w:
            s.close()
            raise TimeoutError("connect: timed out")
        err = s.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR)
        if err:
            s.close()
            raise OSError(err, f"connect: {os.strerror(err)}")

    @staticmethod
    def _await_security(s, want, seconds):
        deadline = time.time() + seconds
        while time.time() < deadline:
            got = struct.unpack("BB", s.getsockopt(SOL_BLUETOOTH, BT_SECURITY, 2))[0]
            if got >= want:
                return True
            time.sleep(0.2)
        return False

    def close(self):
        try:
            self._s.close()
        except OSError:
            pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    # -- primitives --------------------------------------------------------------------
    def negotiate_mtu(self, mtu=517):
        """Optional. Some firmware drops the link on this - callers decide."""
        self._s.send(struct.pack("<BH", OP_MTU_REQ, mtu))
        r = self._s.recv(64)
        if r and r[0] == OP_MTU_RSP:
            self.mtu = struct.unpack("<H", r[1:3])[0]
        return self.mtu

    def _txn(self, pdu, expect):
        """Send a request, return the matching response, queueing any notifications."""
        self._s.send(pdu)
        while True:
            r = self._s.recv(512)
            if not r:
                raise ConnectionError("link closed")
            if r[0] in (OP_NOTIFY, OP_INDICATE):
                self._stash(r)
                continue
            if r[0] == OP_ERROR and len(r) >= 5:
                raise AttError(r[4], struct.unpack("<H", r[2:4])[0])
            if r[0] != expect:
                raise RuntimeError(f"unexpected ATT opcode 0x{r[0]:02x}")
            return r

    def _stash(self, pdu):
        handle = struct.unpack("<H", pdu[1:3])[0]
        self._pending.append((handle, pdu[3:]))
        if pdu[0] == OP_INDICATE:
            self._s.send(bytes([OP_CONFIRM]))   # indications must be confirmed

    def read_handle(self, handle):
        return self._txn(struct.pack("<BH", OP_READ_REQ, handle), OP_READ_RSP)[1:]

    def write_handle(self, handle, value):
        self._txn(struct.pack("<BH", OP_WRITE_REQ, handle) + bytes(value), OP_WRITE_RSP)

    def set_cccd(self, handle, value=CCCD_NOTIFY):
        self.write_handle(handle, value)

    def await_notification(self, handle=None, timeout=30.0):
        """Wait for a notification, optionally on a specific handle.

        Returns (handle, payload) or None on timeout. Notifications that arrived while a
        request was in flight are returned first.
        """
        for i, (h, v) in enumerate(self._pending):
            if handle is None or h == handle:
                return self._pending.pop(i)
        end = time.time() + timeout
        while time.time() < end:
            self._s.settimeout(max(0.5, end - time.time()))
            try:
                r = self._s.recv(512)
            except socket.timeout:
                return None
            if not r:
                return None
            if r[0] in (OP_NOTIFY, OP_INDICATE):
                h = struct.unpack("<H", r[1:3])[0]
                v = r[3:]
                if r[0] == OP_INDICATE:
                    self._s.send(bytes([OP_CONFIRM]))
                if handle is None or h == handle:
                    return (h, v)
                self._pending.append((h, v))
        return None

    def drain(self, seconds=2.0):
        """Absorb anything the peer pushes unprompted (e.g. Service Changed after SMP)."""
        end = time.time() + seconds
        while time.time() < end:
            self._s.settimeout(max(0.2, end - time.time()))
            try:
                r = self._s.recv(512)
            except socket.timeout:
                return
            except OSError:
                return
            if not r:
                return
            if r[0] in (OP_NOTIFY, OP_INDICATE):
                self._stash(r)

    # -- optional discovery ------------------------------------------------------------
    def discover_services(self):
        """Read By Group Type over 0x2800. Returns [(start, end, uuid_str)].

        Provided for devices whose discovery works. Not used by plugins that hard-code
        handles, and known to fail (or drop the link) on some firmware.
        """
        out, start = [], 1
        while start <= 0xFFFF:
            try:
                r = self._txn(struct.pack("<BHHH", OP_READ_BY_GROUP_REQ, start,
                                          0xFFFF, 0x2800), OP_READ_BY_GROUP_RSP)
            except AttError:
                break
            sz = r[1]
            last = start
            for i in range(2, len(r) - sz + 1, sz):
                h, end_h = struct.unpack("<HH", r[i:i + 4])
                out.append((h, end_h, _uuid_str(r[i + 4:i + sz])))
                last = end_h
            if last <= start:
                break
            start = last + 1
        return out


def _uuid_str(raw):
    if len(raw) == 2:
        return f"{struct.unpack('<H', raw)[0]:04x}"
    h = raw[::-1].hex()
    return f"{h[0:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}"
