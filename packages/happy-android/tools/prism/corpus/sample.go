// fixture is a bounded, loopback-only mobile E2E harness. Never ship it.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/slopus/happy/packages/expo-tailcat/go/internal/testpeer"
)

func main() {
	relay := flag.String("relay", "127.0.0.1:18443", "private relay listener")
	control := flag.String("control", "127.0.0.1:18081", "test control listener")
	flag.Parse()
	if err := run(*relay, *control); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(relay, control string) error {
	p, err := testpeer.Start(relay)
	if err != nil {
		return err
	}
	defer p.Close()
	var mu sync.Mutex
	var result json.RawMessage
	mux := http.NewServeMux()
	// Native fetch baseline, to distinguish HTTP client issues from the tunnel.
	mux.HandleFunc("POST /echo", testpeer.Handler)
	mux.HandleFunc("GET /config", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"address": p.Address, "port": testpeer.Port})
	})
	mux.HandleFunc("POST /result", func(w http.ResponseWriter, r *http.Request) {
		var body json.RawMessage
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 65536)).Decode(&body); err != nil {
			http.Error(w, "invalid result", 400)
			return
		}
		mu.Lock()
		result = body
		mu.Unlock()
		w.WriteHeader(204)
	})
	mux.HandleFunc("GET /result", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if result == nil {
			w.WriteHeader(202)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write(result)
	})
	srv := &http.Server{Addr: control, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	errCh := make(chan error, 1)
	go func() { errCh <- srv.ListenAndServe() }()
	fmt.Println("Private Tailcat fixture running (addresses redacted)")
	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
	case <-time.After(20 * time.Minute):
	}
	return srv.Close()
}
