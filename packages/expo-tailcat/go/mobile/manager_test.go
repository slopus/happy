package mobile

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/slopus/happy/packages/expo-tailcat/go/internal/testpeer"
)

func TestTunnelEndToEnd(t *testing.T) {
	p, err := testpeer.Start("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	m := NewManager()
	defer m.Close()
	openTest := func(timeout int) map[string]string {
		t.Helper()
		options, _ := json.Marshal(map[string]any{"address": p.Address, "port": testpeer.Port, "connectTimeoutMs": timeout})
		raw, err := m.OpenTunnel(string(options))
		if err != nil {
			t.Fatal(err)
		}
		var endpoint map[string]string
		if err := json.Unmarshal([]byte(raw), &endpoint); err != nil {
			t.Fatal(err)
		}
		return endpoint
	}
	e := openTest(5000)
	client := &http.Client{Timeout: 10 * time.Second}
	defer client.CloseIdleConnections()
	get := func(path string) *http.Response {
		t.Helper()
		r, err := client.Get(e["httpUrl"] + path)
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	t.Run("binary POST headers query and status", func(t *testing.T) {
		payload := bytes.Repeat([]byte{0, 1, 255, 128, 42}, 100000)
		r, _ := http.NewRequest("POST", e["httpUrl"]+"echo?a=1%2F2", bytes.NewReader(payload))
		r.Header.Set("Authorization", "Bearer test-application-token")
		r.Header.Set("Referer", e["httpUrl"])
		res, err := client.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		body, err := io.ReadAll(res.Body)
		if err != nil || !bytes.Equal(body, payload) || res.StatusCode != 201 {
			t.Fatal("POST failed")
		}
		if res.Header.Get("X-Upstream-Host") != "localhost:8080" || res.Header.Get("X-Upstream-Query") != "a=1%2F2" || res.Header.Get("X-Upstream-Auth") != "Bearer test-application-token" || res.Header.Get("X-Upstream-Referer") != "" {
			t.Fatal("incorrect forwarded headers")
		}
	})
	t.Run("escaped paths and redirects", func(t *testing.T) {
		r := get("a%2Fb?x=%2F")
		defer r.Body.Close()
		var body map[string]string
		json.NewDecoder(r.Body).Decode(&body)
		if body["path"] != "/a%2Fb" || body["query"] != "x=%2F" {
			t.Fatalf("incorrect path: %v", body)
		}
		r2 := get("redirect")
		defer r2.Body.Close()
		if !strings.HasPrefix(r2.Request.URL.String(), e["httpUrl"]+"health?") {
			t.Fatal("redirect escaped tunnel")
		}
	})
	t.Run("capability host and origin boundaries", func(t *testing.T) {
		base, _ := url.Parse(e["httpUrl"])
		for _, tc := range []struct{ path, host, origin string }{
			{"/health", "", ""}, {base.Path + "health", "evil.example", ""},
			{base.Path + "health", "", "https://evil.example"}, {"/wrong/health", "", ""},
		} {
			r, _ := http.NewRequest("GET", "http://"+base.Host+tc.path, nil)
			if tc.host != "" {
				r.Host = tc.host
			}
			r.Header.Set("Origin", tc.origin)
			res, err := client.Do(r)
			if err != nil {
				t.Fatal(err)
			}
			res.Body.Close()
			if res.StatusCode != 404 {
				t.Fatal("endpoint accepted unauthorized request")
			}
		}
	})
	t.Run("concurrent requests", func(t *testing.T) {
		var wg sync.WaitGroup
		for range 8 {
			wg.Go(func() {
				r, err := client.Get(e["httpUrl"] + "health")
				if err != nil {
					t.Error(err)
					return
				}
				io.Copy(io.Discard, r.Body)
				r.Body.Close()
				if r.StatusCode != 200 {
					t.Error("request failed")
				}
			})
		}
		wg.Wait()
	})
	t.Run("request cancellation", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
		defer cancel()
		r, _ := http.NewRequestWithContext(ctx, "GET", e["httpUrl"]+"slow", nil)
		res, err := client.Do(r)
		if res != nil {
			res.Body.Close()
		}
		if err == nil {
			t.Fatal("expected cancellation")
		}
	})
	t.Run("websocket text binary subprotocol and shutdown", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		ws, _, err := websocket.Dial(ctx, e["wsUrl"]+"ws", &websocket.DialOptions{Subprotocols: []string{"tailcat-test"}})
		if err != nil {
			t.Fatal(err)
		}
		defer ws.CloseNow()
		if ws.Subprotocol() != "tailcat-test" {
			t.Fatal("subprotocol missing")
		}
		for _, kind := range []websocket.MessageType{websocket.MessageText, websocket.MessageBinary} {
			if err := ws.Write(ctx, kind, []byte("hello")); err != nil {
				t.Fatal(err)
			}
			gotKind, data, err := ws.Read(ctx)
			if err != nil || gotKind != kind || string(data) != "hello" {
				t.Fatal("websocket echo failed")
			}
		}
		m.CloseTunnel(e["id"])
		m.CloseTunnel(e["id"])
		if _, _, err := ws.Read(ctx); err == nil {
			t.Fatal("websocket survived tunnel close")
		}
		if r, err := client.Get(e["httpUrl"] + "health"); err == nil {
			r.Body.Close()
			t.Fatal("listener survived close")
		}
	})
	t.Run("close all permits reopen and permanent close forbids it", func(t *testing.T) {
		e = openTest(5000)
		m.CloseAll()
		e = openTest(5000)
		m.Close()
		raw, _ := json.Marshal(map[string]any{"address": p.Address, "port": testpeer.Port})
		if _, err := m.OpenTunnel(string(raw)); err == nil {
			t.Fatal("closed manager reopened")
		}
	})
}

func TestValidation(t *testing.T) {
	for _, raw := range []string{"", "{}", "[]", `{"address":"secret invalid","port":80}`, `{"x":true}`} {
		_, err := parseOptions(raw)
		if err == nil || strings.Contains(err.Error(), "secret") {
			t.Fatal("unsafe validation error")
		}
	}
	if err := SetInterfaces(`[{"name":"lo","index":1,"mtu":65536,"up":true,"loopback":true,"addresses":["127.0.0.1/8"]}]`); err != nil {
		t.Fatal(err)
	}
	if err := SetInterfaces(`[{"addresses":["bad"]}]`); err == nil {
		t.Fatal("invalid address accepted")
	}
}
