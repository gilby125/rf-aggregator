#!/bin/sh
# Synthetic rtl_433 event feed for hardware-free dev/testing. Publishes plausible
# Acurite-Tower JSON to $FEED_TOPIC every $INTERVAL_S seconds for three sensor ids.
set -eu
BROKER_HOST="${BROKER_HOST:-mosquitto}"
FEED_TOPIC="${FEED_TOPIC:-rtl_433/events}"
INTERVAL_S="${INTERVAL_S:-5}"

# Wait for the broker.
until mosquitto_pub -h "$BROKER_HOST" -t "$FEED_TOPIC/ping" -m up 2>/dev/null; do
  echo "feedgen: waiting for broker $BROKER_HOST..."
  sleep 2
done
echo "feedgen: publishing to $FEED_TOPIC on $BROKER_HOST every ${INTERVAL_S}s"

while true; do
  NOW="$(date +%s)"
  for ID in 1234 5678 9012; do
    # Deterministic-ish wander per id so group means are recognizable.
    T="$(awk -v id="$ID" -v now="$NOW" 'BEGIN{srand(now+id); printf "%.1f", 60+id%20+rand()*5}')"
    H="$(awk -v id="$ID" -v now="$NOW" 'BEGIN{srand(now+id*7); printf "%d", 35+id%30+rand()*10}')"
    mosquitto_pub -h "$BROKER_HOST" -t "$FEED_TOPIC" -m \
      "{\"time\":$NOW,\"model\":\"Acurite-Tower\",\"id\":$ID,\"channel\":\"A\",\"battery_ok\":1,\"temperature_F\":$T,\"humidity\":$H}"
  done
  sleep "$INTERVAL_S"
done
