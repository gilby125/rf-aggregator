"""Output sinks. Generic: they take a reading dict and ship it somewhere."""
import json
import sys
import time


class Sink:
    def publish(self, sensor_id: str, fields: dict) -> dict:
        raise NotImplementedError

    def close(self):
        pass


class MqttSink(Sink):
    """Publish native JSON for a Telegraf mqtt_consumer adapter to normalise.

    Shape matches what adapters/<name>/adapter.conf expects: a flat object with a unix
    `time`, a stable `id`, and numeric fields (json_time_key = "time").
    """

    def __init__(self, broker, port=1883, topic="ble/events", client_id=None,
                 username=None, password=None, keepalive=60):
        import paho.mqtt.client as mqtt
        # paho 2.x wants the callback-API version as first positional arg; 1.x (what
        # Debian bookworm still ships) has no such attribute.
        if hasattr(mqtt, "CallbackAPIVersion"):
            self._c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=client_id)
        else:
            self._c = mqtt.Client(client_id=client_id)
        if username:
            self._c.username_pw_set(username, password)
        self._c.connect(broker, port, keepalive=keepalive)
        self._c.loop_start()
        self.topic = topic

    def publish(self, sensor_id, fields):
        msg = {"time": int(time.time()), "id": sensor_id, **fields}
        self._c.publish(self.topic, json.dumps(msg), qos=0)
        return msg

    def close(self):
        try:
            self._c.loop_stop()
            self._c.disconnect()
        except Exception:
            pass


class StdoutSink(Sink):
    """For testing: print the envelope instead of publishing."""

    def publish(self, sensor_id, fields):
        msg = {"time": int(time.time()), "id": sensor_id, **fields}
        print(json.dumps(msg), flush=True, file=sys.stdout)
        return msg
