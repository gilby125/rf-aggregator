// rf-aggregator bridge agent: the outbound-only link between the private backend and the
// Cloudflare edge (docs/CONTRACTS.md §2). It subscribes to the gateway MQTT topics, keeps
// per-sensor latest values and per-group aggregates in memory, pushes catalog+aggregates UP
// every SYNC_PERIOD, pulls group_defs DOWN when defs_version changes, and renders the
// Telegraf id->group lookup (mapping.json + a version-stamped telegraf.d snippet whose
// rewrite fires Telegraf's --watch-config reload). No inbound connections.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
)

const contractVersion = 1

type sensorState struct {
	Source   string             `json:"source"`
	Type     string             `json:"type"`
	LastSeen int64              `json:"last_seen"`
	Latest   map[string]float64 `json:"latest"`
}

type groupAgg struct {
	TS     int64              `json:"ts"`
	Fields map[string]float64 `json:"fields"`
}

// telegrafMetric is the JSON shape Telegraf's json serializer emits on the gateway topics.
type telegrafMetric struct {
	Name      string             `json:"name"`
	Tags      map[string]string  `json:"tags"`
	Fields    map[string]float64 `json:"fields"`
	Timestamp int64              `json:"timestamp"`
}

type ingestRequest struct {
	V       int           `json:"v"`
	Catalog []catalogItem `json:"catalog"`
	Agg     aggDoc        `json:"aggregates"`
}

type catalogItem struct {
	ID string `json:"id"`
	sensorState
}

type aggDoc struct {
	PeriodS int64               `json:"period_s"`
	Groups  map[string]groupAgg `json:"groups"`
}

type ingestResponse struct {
	V           int  `json:"v"`
	OK          bool `json:"ok"`
	DefsVersion int  `json:"defs_version"`
}

type defsResponse struct {
	V           int                 `json:"v"`
	DefsVersion int                 `json:"defs_version"`
	GroupDefs   map[string][]string `json:"group_defs"`
}

type bridge struct {
	mu       sync.Mutex
	catalog  map[string]*sensorState
	agg      map[string]groupAgg
	defsVer  int
	edgeURL  string
	token    string
	cfID     string // Cloudflare Access service token (edge auth in front of the Worker)
	cfSecret string
	periodS  int64
	dynDir   string
	http     *http.Client
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func mustDuration(key, def string) time.Duration {
	s := env(key, def)
	d, err := time.ParseDuration(s)
	if err != nil {
		log.Fatalf("bad %s=%q: %v", key, s, err)
	}
	return d
}

func main() {
	feedURL := env("FEED_MQTT_URL", "tcp://mosquitto:1883")
	b := &bridge{
		catalog: map[string]*sensorState{},
		agg:     map[string]groupAgg{},
		defsVer: -1, // force a defs pull on first successful ingest
		edgeURL:  env("EDGE_URL", ""),
		token:    env("BRIDGE_TOKEN", ""),
		cfID:     env("CF_ACCESS_CLIENT_ID", ""),
		cfSecret: env("CF_ACCESS_CLIENT_SECRET", ""),
		periodS:  int64(mustDuration("AGG_PERIOD", "5m").Seconds()),
		dynDir:  env("DYNAMIC_DIR", "/dynamic"),
		http:    &http.Client{Timeout: 30 * time.Second},
	}

	if err := b.seedDynamicConf(); err != nil {
		log.Fatalf("seeding dynamic config: %v", err)
	}

	opts := mqtt.NewClientOptions().
		AddBroker(feedURL).
		SetClientID("rf-aggregator-bridge").
		SetAutoReconnect(true).
		SetConnectRetry(true).
		SetConnectRetryInterval(5 * time.Second).
		SetOnConnectHandler(func(c mqtt.Client) {
			log.Printf("mqtt connected to %s", feedURL)
			if t := c.Subscribe("rf/events/#", 0, b.onEvent); t.Wait() && t.Error() != nil {
				log.Printf("subscribe rf/events/#: %v", t.Error())
			}
			if t := c.Subscribe("rf/agg/#", 0, b.onAgg); t.Wait() && t.Error() != nil {
				log.Printf("subscribe rf/agg/#: %v", t.Error())
			}
		})
	client := mqtt.NewClient(opts)
	if t := client.Connect(); t.Wait() && t.Error() != nil {
		log.Fatalf("mqtt connect: %v", t.Error())
	}

	syncPeriod := mustDuration("SYNC_PERIOD", "60s")
	if b.edgeURL == "" {
		log.Printf("EDGE_URL empty — running standalone (no edge sync); backend pipeline unaffected")
		select {} // keep consuming MQTT so ops can inspect; nothing to sync
	}
	log.Printf("syncing to %s every %s", b.edgeURL, syncPeriod)
	for range time.Tick(syncPeriod) {
		if err := b.sync(); err != nil {
			log.Printf("sync: %v", err)
		}
	}
}

func (b *bridge) onEvent(_ mqtt.Client, msg mqtt.Message) {
	var m telegrafMetric
	if err := json.Unmarshal(msg.Payload(), &m); err != nil || m.Tags["id"] == "" {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	s, ok := b.catalog[m.Tags["id"]]
	if !ok {
		s = &sensorState{Latest: map[string]float64{}}
		b.catalog[m.Tags["id"]] = s
	}
	s.Source = m.Tags["source"]
	s.Type = m.Tags["type"]
	s.LastSeen = m.Timestamp
	for k, v := range m.Fields {
		s.Latest[k] = v
	}
}

func (b *bridge) onAgg(_ mqtt.Client, msg mqtt.Message) {
	var m telegrafMetric
	if err := json.Unmarshal(msg.Payload(), &m); err != nil || m.Tags["group"] == "" {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.agg[m.Tags["group"]] = groupAgg{TS: m.Timestamp, Fields: m.Fields}
}

func (b *bridge) snapshot() ingestRequest {
	b.mu.Lock()
	defer b.mu.Unlock()
	req := ingestRequest{
		V:   contractVersion,
		Agg: aggDoc{PeriodS: b.periodS, Groups: map[string]groupAgg{}},
	}
	for id, s := range b.catalog {
		cp := *s
		cp.Latest = map[string]float64{}
		for k, v := range s.Latest {
			cp.Latest[k] = v
		}
		req.Catalog = append(req.Catalog, catalogItem{ID: id, sensorState: cp})
	}
	for g, a := range b.agg {
		req.Agg.Groups[g] = a
	}
	return req
}

func (b *bridge) sync() error {
	body, err := json.Marshal(b.snapshot())
	if err != nil {
		return err
	}
	var ing ingestResponse
	if err := b.call("POST", "/api/bridge/ingest", body, &ing); err != nil {
		return fmt.Errorf("ingest: %w", err)
	}
	if ing.DefsVersion == b.defsVer {
		return nil
	}
	var defs defsResponse
	if err := b.call("GET", "/api/bridge/defs", nil, &defs); err != nil {
		return fmt.Errorf("defs: %w", err)
	}
	if err := b.renderMapping(defs); err != nil {
		return fmt.Errorf("render mapping: %w", err)
	}
	b.defsVer = defs.DefsVersion
	log.Printf("group_defs updated to version %d (%d groups) — telegraf will reload", defs.DefsVersion, len(defs.GroupDefs))
	return nil
}

func (b *bridge) call(method, path string, body []byte, out any) error {
	req, err := http.NewRequest(method, b.edgeURL+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+b.token)
	// Cloudflare Access service token: authenticated at the edge before the Worker runs, so
	// unauthenticated probes are rejected without consuming a Worker invocation.
	if b.cfID != "" {
		req.Header.Set("CF-Access-Client-Id", b.cfID)
		req.Header.Set("CF-Access-Client-Secret", b.cfSecret)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := b.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s %s: HTTP %d", method, path, resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

// renderMapping writes mapping.json first, then the version-stamped snippet — the snippet
// rewrite is what fires --watch-config, so the mapping must already be in place.
func (b *bridge) renderMapping(defs defsResponse) error {
	mapping := map[string]map[string]string{}
	for group, ids := range defs.GroupDefs {
		for _, id := range ids {
			mapping[id] = map[string]string{"group": group}
		}
	}
	mj, err := json.MarshalIndent(mapping, "", "  ")
	if err != nil {
		return err
	}
	if err := atomicWrite(filepath.Join(b.dynDir, "mapping.json"), mj); err != nil {
		return err
	}
	return atomicWrite(filepath.Join(b.dynDir, "telegraf.d", "50-group-mapping.conf"),
		[]byte(snippet(defs.DefsVersion)))
}

// seedDynamicConf makes first boot deterministic: an empty mapping + snippet exist before
// Telegraf starts (compose orders telegraf after the bridge).
func (b *bridge) seedDynamicConf() error {
	if err := os.MkdirAll(filepath.Join(b.dynDir, "telegraf.d"), 0o755); err != nil {
		return err
	}
	mp := filepath.Join(b.dynDir, "mapping.json")
	if _, err := os.Stat(mp); os.IsNotExist(err) {
		if err := atomicWrite(mp, []byte("{}\n")); err != nil {
			return err
		}
	}
	sp := filepath.Join(b.dynDir, "telegraf.d", "50-group-mapping.conf")
	if _, err := os.Stat(sp); os.IsNotExist(err) {
		return atomicWrite(sp, []byte(snippet(0)))
	}
	return nil
}

func snippet(version int) string {
	return fmt.Sprintf(`# rendered by rf-aggregator bridge — do not edit
# defs_version: %d
[[processors.lookup]]
  order = 2
  namepass = ["rf_event"]
  format = "json"
  files = ["/etc/telegraf/dynamic/mapping.json"]
  key = '{{.Tag "id"}}'
`, version)
}

func atomicWrite(path string, data []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
