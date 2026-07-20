"""The polling loop. Device-agnostic: connect, hand the link to the plugin, publish, sleep."""
import time

from .transport import AttLink


def log(msg):
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)


def read_once(device, mac, adapter, connect_timeout=20.0):
    """One full cycle against a freshly established link. Raises on failure."""
    link = AttLink.connect(mac, adapter, security=device.security,
                           timeout=connect_timeout, peer_type=device.peer_type)
    try:
        if device.negotiate_mtu:
            link.negotiate_mtu()
        if device.settle_seconds:
            link.drain(device.settle_seconds)
        return device.read(link)
    finally:
        link.close()


def poll(device, mac, adapter, sink, sensor_id, interval, retries=5,
         retry_delay=4.0, once=False):
    """Run until interrupted (or one cycle if `once`). Returns exit status."""
    log(f"device={device.describe()} mac={mac} adapter={adapter}")
    log(f"polling every {interval}s (retries={retries})")

    while True:
        fields = None
        for attempt in range(1, retries + 1):
            try:
                fields = read_once(device, mac, adapter)
                break
            except Exception as e:
                log(f"attempt {attempt}/{retries}: {e}")
                if attempt < retries:
                    time.sleep(retry_delay)

        if fields:
            msg = sink.publish(sensor_id, fields)
            log("published " + " ".join(f"{k}={v}" for k, v in fields.items()))
        else:
            # No stale republish: a missed cycle must look missing downstream so the
            # sensor ages out as stale rather than appearing frozen-but-live.
            log(f"cycle FAILED after {retries} attempts; publishing nothing")

        if once:
            return 0 if fields else 1
        time.sleep(interval)
