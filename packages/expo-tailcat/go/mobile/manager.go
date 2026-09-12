// Package mobile is the deliberately small gomobile binding surface.
package mobile

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/tailscale/tailcat"
	"tailscale.com/types/logger"
)

type options struct {
	Address          string `json:"address"`
	Port             int    `json:"port"`
	Scheme           string `json:"scheme"`
	Hostname         string `json:"hostname"`
	DERPMapURL       string `json:"derpMapUrl"`
	ConnectTimeoutMs int    `json:"connectTimeoutMs"`
}

func parseOptions(raw string) (options, error) {
	var o options
	d := json.NewDecoder(strings.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(&o) != nil || d.Decode(new(any)) != io.EOF {
		return o, errors.New("invalid tunnel options")
	}
	if len(o.Address) > 16384 {
		return o, errors.New("invalid tailcat address")
	}
	if _, err := tailcat.ParseAddr(tailcat.Addr(o.Address)); err != nil {
		return o, errors.New("invalid tailcat address")
	}
	if o.Port < 1 || o.Port > 65535 {
		return o, errors.New("port must be between 1 and 65535")
	}
	if o.Scheme == "" {
		o.Scheme = "http"
	}
	if o.Scheme != "http" && o.Scheme != "https" {
		return o, errors.New("scheme must be http or https")
	}
	if o.Hostname == "" {
		o.Hostname = "localhost"
	}
	if strings.ContainsAny(o.Hostname, "/\\:@?#[] \t\r\n") || len(o.Hostname) > 253 {
		return o, errors.New("hostname must be a DNS name or IPv4 address")
	}
	if o.ConnectTimeoutMs == 0 {
		o.ConnectTimeoutMs = 15000
	}
	if o.ConnectTimeoutMs < 100 || o.ConnectTimeoutMs > 120000 {
		return o, errors.New("connectTimeoutMs must be between 100 and 120000")
	}
	if o.DERPMapURL != "" {
		u, err := url.Parse(o.DERPMapURL)
		if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Fragment != "" {
			return o, errors.New("derpMapUrl must be an HTTPS URL")
		}
	}
	return o, nil
}

// Manager owns tunnels for one native module instance. Close permanently closes
// it, including pending opens. CloseAll keeps the manager usable.
type Manager struct {
	mu      sync.Mutex
	ctx     context.Context
	cancel  context.CancelFunc
	closed  bool
	tunnels map[string]*tunnel
}

func NewManager() *Manager {
	ctx, cancel := context.WithCancel(context.Background())
	return &Manager{ctx: ctx, cancel: cancel, tunnels: make(map[string]*tunnel)}
}

// OpenTunnel returns JSON with id, httpUrl and wsUrl. The loopback listener is
// ready on return; the remote TCP port has been checked. HTTP/TLS handshakes
// happen with the first request. Errors never contain addresses or endpoint keys.
func (m *Manager) OpenTunnel(raw string) (string, error) {
	o, err := parseOptions(raw)
	if err != nil {
		return "", err
	}
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return "", errors.New("tailcat manager is closed")
	}
	parent := m.ctx
	m.mu.Unlock()
	t, err := open(parent, o)
	if err != nil {
		return "", err
	}
	m.mu.Lock()
	if m.closed || parent.Err() != nil {
		m.mu.Unlock()
		t.close()
		return "", errors.New("tunnel opening was cancelled")
	}
	m.tunnels[t.id] = t
	m.mu.Unlock()
	result, _ := json.Marshal(map[string]string{
		"id": t.id, "httpUrl": t.endpoint, "wsUrl": "ws" + strings.TrimPrefix(t.endpoint, "http"),
	})
	return string(result), nil
}

// CloseTunnel is idempotent and also terminates upgraded WebSocket connections.
func (m *Manager) CloseTunnel(id string) {
	m.mu.Lock()
	t := m.tunnels[id]
	delete(m.tunnels, id)
	m.mu.Unlock()
	if t != nil {
		t.close()
	}
}

func (m *Manager) closeAll(permanent bool) {
	m.mu.Lock()
	m.cancel()
	if permanent {
		m.closed = true
	}
	if !m.closed {
		m.ctx, m.cancel = context.WithCancel(context.Background())
	}
	old := m.tunnels
	m.tunnels = make(map[string]*tunnel)
	m.mu.Unlock()
	for _, t := range old {
		t.close()
	}
}

func (m *Manager) CloseAll() { m.closeAll(false) }
func (m *Manager) Close()    { m.closeAll(true) }

type tunnel struct {
	id        string
	endpoint  string
	client    *tailcat.Client
	server    *http.Server
	transport *http.Transport
	listener  *trackedListener
	cancel    context.CancelFunc
	once      sync.Once
}

func open(parent context.Context, o options) (_ *tunnel, err error) {
	ctx, cancel := context.WithCancel(parent)
	t := &tunnel{cancel: cancel}
	defer func() {
		if err != nil {
			t.close()
		}
	}()
	t.client = &tailcat.Client{Server: tailcat.Addr(o.Address), DERPMapURL: o.DERPMapURL, Logf: logger.Discard}
	timeout := time.Duration(o.ConnectTimeoutMs) * time.Millisecond
	probeCtx, probeCancel := context.WithTimeout(ctx, timeout)
	probe, probeErr := t.client.DialTCPPort(probeCtx, uint16(o.Port))
	probeCancel()
	if probeErr != nil {
		return nil, errors.New("tailcat connection failed or timed out")
	}
	probe.Close()
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, errors.New("could not open local endpoint")
	}
	t.listener = &trackedListener{Listener: ln, connections: make(map[*trackedConn]struct{})}
	secret := make([]byte, 32)
	if _, err = rand.Read(secret); err != nil {
		return nil, errors.New("could not generate endpoint key")
	}
	t.id = hex.EncodeToString(secret)
	prefix := "/" + t.id + "/"
	t.endpoint = "http://" + ln.Addr().String() + prefix
	target := &url.URL{Scheme: o.Scheme, Host: net.JoinHostPort(o.Hostname, strconv.Itoa(o.Port))}
	t.transport = &http.Transport{
		Proxy: nil, // never consult ambient proxy environment variables
		DialContext: func(requestCtx context.Context, _, _ string) (net.Conn, error) {
			dialCtx, stop := context.WithTimeout(requestCtx, timeout)
			defer stop()
			return t.client.DialTCPPort(dialCtx, uint16(o.Port))
		},
		TLSClientConfig:     &tls.Config{MinVersion: tls.VersionTLS12, ServerName: o.Hostname},
		TLSHandshakeTimeout: timeout, ResponseHeaderTimeout: timeout,
		IdleConnTimeout: 30 * time.Second, MaxIdleConns: 8, MaxIdleConnsPerHost: 8,
		MaxConnsPerHost: 32, MaxResponseHeaderBytes: 1 << 20,
	}
	proxy := &httputil.ReverseProxy{
		Rewrite: func(p *httputil.ProxyRequest) {
			p.SetURL(target)
			p.Out.Host = target.Host
			p.Out.URL.Path = "/" + strings.TrimPrefix(p.In.URL.Path, prefix)
			if p.In.URL.RawPath != "" {
				p.Out.URL.RawPath = "/" + strings.TrimPrefix(p.In.URL.RawPath, prefix)
			}
			// Do not disclose the local capability through Origin or Referer.
			p.Out.Header.Del("Referer")
			p.Out.Header.Del("Origin")
		},
		Transport:     t.transport,
		FlushInterval: -1, // stream SSE and large responses, without bridge buffering
		ErrorLog:      log.New(io.Discard, "", 0),
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
			http.Error(w, "tailcat upstream unavailable", http.StatusBadGateway)
		},
		ModifyResponse: func(r *http.Response) error {
			r.Header.Set("Referrer-Policy", "no-referrer")
			// Keep relative and same-origin redirects within the selected tunnel.
			if location := r.Header.Get("Location"); location != "" {
				if u, e := r.Request.URL.Parse(location); e == nil && u.Scheme == target.Scheme && u.Host == target.Host {
					u.Scheme, u.Host = "http", ln.Addr().String()
					u.Path = prefix + strings.TrimPrefix(u.Path, "/")
					if u.RawPath != "" {
						u.RawPath = prefix + strings.TrimPrefix(u.RawPath, "/")
					}
					r.Header.Set("Location", u.String())
				}
			}
			return nil
		},
	}
	t.server = &http.Server{
		ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 64 << 10,
		ErrorLog:    log.New(io.Discard, "", 0),
		BaseContext: func(net.Listener) context.Context { return ctx },
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Host != ln.Addr().String() || !strings.HasPrefix(r.URL.EscapedPath(), prefix) ||
				(r.Header.Get("Origin") != "" && r.Header.Get("Origin") != "http://"+ln.Addr().String()) {
				http.NotFound(w, r)
				return
			}
			proxy.ServeHTTP(w, r)
		}),
	}
	go t.server.Serve(t.listener)
	return t, nil
}

func (t *tunnel) close() {
	t.once.Do(func() {
		t.cancel()
		if t.server != nil {
			t.server.Close()
		}
		if t.listener != nil {
			t.listener.Close()
		}
		if t.transport != nil {
			t.transport.CloseIdleConnections()
		}
		if t.client != nil {
			t.client.Close()
		}
	})
}

// http.Server.Close does not close hijacked sockets. Track accepted sockets too.
type trackedListener struct {
	net.Listener
	mu          sync.Mutex
	closed      bool
	connections map[*trackedConn]struct{}
}

type trackedConn struct {
	net.Conn
	owner *trackedListener
}

func (l *trackedListener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		c.Close()
		return nil, net.ErrClosed
	}
	tc := &trackedConn{Conn: c, owner: l}
	l.connections[tc] = struct{}{}
	return tc, nil
}

func (c *trackedConn) Close() error {
	c.owner.mu.Lock()
	delete(c.owner.connections, c)
	c.owner.mu.Unlock()
	return c.Conn.Close()
}

func (l *trackedListener) Close() error {
	err := l.Listener.Close()
	l.mu.Lock()
	l.closed = true
	for c := range l.connections {
		c.Conn.Close()
	}
	l.connections = make(map[*trackedConn]struct{})
	l.mu.Unlock()
	return err
}
