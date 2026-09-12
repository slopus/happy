package integration_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/slopus/happy/packages/expo-tailcat/go/internal/testpeer"
	"github.com/slopus/happy/packages/expo-tailcat/go/mobile"
)

func TestBinaryBodySizesThroughTailcat(t *testing.T) {
	p, err := testpeer.Start("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	m := mobile.NewManager()
	defer m.Close()
	options, _ := json.Marshal(map[string]any{"address": p.Address, "port": testpeer.Port})
	raw, err := m.OpenTunnel(string(options))
	if err != nil {
		t.Fatal(err)
	}
	var endpoint map[string]string
	if err := json.Unmarshal([]byte(raw), &endpoint); err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Timeout: 10 * time.Second}
	defer client.CloseIdleConnections()
	for _, size := range []int{1024, 256 * 1024, 500 * 1024} {
		for _, chunked := range []bool{false, true} {
			body := bytes.Repeat([]byte{0, 128, 255, 42}, size/4)
			r, _ := http.NewRequest("POST", endpoint["httpUrl"]+"echo", bytes.NewReader(body))
			if chunked {
				r.ContentLength = -1
			}
			res, err := client.Do(r)
			if err != nil {
				t.Fatal(err)
			}
			got, err := io.ReadAll(res.Body)
			res.Body.Close()
			if err != nil || res.StatusCode != 201 || !bytes.Equal(got, body) {
				t.Errorf("size=%d chunked=%v: status=%d received=%d err=%v", size, chunked, res.StatusCode, len(got), err)
			}
		}
	}
}
