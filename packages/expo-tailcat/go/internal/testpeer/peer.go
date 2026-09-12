// Package testpeer supplies a private DERP relay and a real Tailcat HTTP/WS peer.
// It is only imported by tests and the CI fixture, never by the mobile library.
package testpeer

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/tailscale/tailcat"
	"tailscale.com/derp/derpserver"
	"tailscale.com/envknob"
	"tailscale.com/tailcfg"
	"tailscale.com/types/key"
	"tailscale.com/types/logger"
)

const Port = 8080

type Peer struct {
	Address   string
	Server    *tailcat.Server
	relay     *derpserver.Server
	relayHTTP *httptest.Server
	upstream  *httptest.Server
}

// Start binds exclusively to loopback. relayAddr is 127.0.0.1:0 in unit tests
// or a fixed port forwarded with adb reverse for Android emulator tests.
func Start(relayAddr string) (*Peer, error) {
	// No STUN, port mapping, or public relay traffic. This also proves that
	// HTTP and WebSockets work when UDP traversal is impossible.
	envknob.Setenv("IN_TS_TEST", "true")
	// Leave UDP sockets real: the upstream ALWAYS_USE_DERP debug knob uses
	// synthetic sockets that can hang during engine shutdown. With no STUN
	// service and no advertised local addresses, peers still use DERP only.
	envknob.Setenv("TS_DEBUG_OMIT_LOCAL_ADDRS", "true")
	p := &Peer{}
	p.upstream = httptest.NewServer(http.HandlerFunc(Handler))
	p.relay = derpserver.New(key.NewNode(), logger.Discard)
	ln, err := net.Listen("tcp4", relayAddr)
	if err != nil {
		p.Close()
		return nil, err
	}
	p.relayHTTP = httptest.NewUnstartedServer(derpserver.Handler(p.relay))
	p.relayHTTP.Listener.Close()
	p.relayHTTP.Listener = ln
	p.relayHTTP.Config.ErrorLog = log.New(io.Discard, "", 0)
	p.relayHTTP.Config.TLSNextProto = make(map[string]func(*http.Server, *tls.Conn, http.Handler))
	p.relayHTTP.StartTLS()
	region := &tailcfg.DERPRegion{
		RegionID: 1, RegionCode: "private-test",
		// A hostname (without a fixed IPv4 override) exercises the mobile OS
		// resolver too, without depending on external DNS or a public relay.
		Nodes: []*tailcfg.DERPNode{{Name: "test", RegionID: 1, HostName: "localhost", IPv6: "none",
			DERPPort: ln.Addr().(*net.TCPAddr).Port, STUNPort: -1, InsecureForTests: true}},
	}
	p.Server = &tailcat.Server{
		Region: region, Logf: logger.Discard,
		OnTCP: func(port uint16) func(net.Conn) {
			if port != Port {
				return nil
			}
			return func(c net.Conn) {
				defer c.Close()
				upstream, err := net.DialTimeout("tcp", strings.TrimPrefix(p.upstream.URL, "http://"), 5*time.Second)
				if err != nil {
					return
				}
				tailcat.ProxyConns(c, upstream)
			}
		},
	}
	if err := p.Server.Start(); err != nil {
		p.Close()
		return nil, err
	}
	p.Address = string(p.Server.TailcatAddr())
	return p, nil
}

func Handler(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/echo":
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("X-Upstream-Host", r.Host)
		w.Header().Set("X-Upstream-Query", r.URL.RawQuery)
		w.Header().Set("X-Upstream-Auth", r.Header.Get("Authorization"))
		w.Header().Set("X-Upstream-Referer", r.Header.Get("Referer"))
		w.WriteHeader(http.StatusCreated)
		io.Copy(w, io.LimitReader(r.Body, 4<<20))
	case "/redirect":
		http.Redirect(w, r, "/health?redirected=yes", http.StatusFound)
	case "/slow":
		select {
		case <-time.After(2 * time.Second):
			io.WriteString(w, "late")
		case <-r.Context().Done():
		}
	case "/ws":
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{"tailcat-test"}})
		if err != nil {
			return
		}
		defer c.CloseNow()
		ctx, cancel := context.WithTimeout(r.Context(), time.Minute)
		defer cancel()
		for {
			kind, data, err := c.Read(ctx)
			if err != nil {
				return
			}
			if err = c.Write(ctx, kind, data); err != nil {
				return
			}
		}
	default:
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "ok", "path": r.URL.EscapedPath(), "query": r.URL.RawQuery})
	}
}

func (p *Peer) Close() {
	if p.Server != nil {
		p.Server.Close()
	}
	if p.relay != nil {
		p.relay.Close()
	}
	if p.relayHTTP != nil {
		p.relayHTTP.CloseClientConnections()
		p.relayHTTP.Close()
	}
	if p.upstream != nil {
		p.upstream.CloseClientConnections()
		p.upstream.Close()
	}
}
