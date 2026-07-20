"""Entry point. Generic: selects a device plugin and a sink, then runs the poll loop."""
import argparse
import os
import sys

from . import devices
from .runner import poll
from .sink import MqttSink, StdoutSink


def build_parser():
    p = argparse.ArgumentParser(
        prog="blepoll",
        description="Poll a BLE sensor over raw ATT and publish to MQTT.")
    p.add_argument("--device", default=os.environ.get("BLEPOLL_DEVICE", "airmon"),
                   choices=devices.names(),
                   help="device plugin (default: airmon)")
    p.add_argument("--mac", default=os.environ.get("BLEPOLL_MAC"),
                   help="sensor BLE address")
    p.add_argument("--adapter", default=os.environ.get("BLEPOLL_ADAPTER"),
                   help="local BT controller PUBLIC address (bluetoothctl list)")
    p.add_argument("--id", default=os.environ.get("BLEPOLL_ID"),
                   help="stable envelope id; MUST NOT change across restarts")
    p.add_argument("--broker", default=os.environ.get("BLEPOLL_BROKER"),
                   help="MQTT broker host (omit with --stdout)")
    p.add_argument("--port", type=int, default=int(os.environ.get("BLEPOLL_PORT", "1883")))
    p.add_argument("--topic", default=os.environ.get("BLEPOLL_TOPIC"),
                   help="MQTT topic (default: <device>/events)")
    p.add_argument("--username", default=os.environ.get("BLEPOLL_USERNAME"))
    p.add_argument("--password", default=os.environ.get("BLEPOLL_PASSWORD"))
    p.add_argument("--interval", type=int,
                   default=int(os.environ.get("BLEPOLL_INTERVAL", "900")),
                   help="seconds between cycles (default 900 = 15 min)")
    p.add_argument("--retries", type=int,
                   default=int(os.environ.get("BLEPOLL_RETRIES", "5")),
                   help="attempts per cycle; flaky devices need several")
    p.add_argument("--once", action="store_true", help="single cycle, then exit")
    p.add_argument("--stdout", action="store_true",
                   help="print envelopes instead of publishing (testing)")
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)

    missing = [n for n in ("mac", "adapter") if not getattr(args, n)]
    if missing:
        raise SystemExit(f"missing required: {', '.join('--' + m for m in missing)}")
    if not args.stdout and not args.broker:
        raise SystemExit("need --broker (or --stdout for testing)")

    device = devices.get(args.device)
    sensor_id = args.id or f"{device.name}-{args.mac.replace(':', '').lower()}"
    topic = args.topic or f"{device.name}/events"

    sink = StdoutSink() if args.stdout else MqttSink(
        args.broker, args.port, topic,
        client_id=f"blepoll-{sensor_id}",
        username=args.username, password=args.password)

    try:
        return poll(device, args.mac, args.adapter, sink, sensor_id,
                    args.interval, args.retries, once=args.once)
    except KeyboardInterrupt:
        return 0
    finally:
        sink.close()


if __name__ == "__main__":
    sys.exit(main())
