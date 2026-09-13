package mobile

import (
	"encoding/json"
	"errors"
	"net"
	"runtime"
	"sync"

	"tailscale.com/net/netmon"
)

var interfaceMu sync.RWMutex
var interfaceSnapshot []netmon.Interface

func init() {
	if runtime.GOOS == "android" {
		netmon.RegisterInterfaceGetter(func() ([]netmon.Interface, error) {
			interfaceMu.RLock()
			defer interfaceMu.RUnlock()
			return append([]netmon.Interface(nil), interfaceSnapshot...), nil
		})
	}
}

// SetInterfaces supplies Android's Java NetworkInterface snapshot, avoiding
// Android's restriction on Go's netlink-based net.Interfaces. Call before open
// and on connectivity changes. Does not affect interface discovery on Apple.
func SetInterfaces(raw string) error {
	var input []struct {
		Name      string   `json:"name"`
		Index     int      `json:"index"`
		MTU       int      `json:"mtu"`
		Up        bool     `json:"up"`
		Loopback  bool     `json:"loopback"`
		Multicast bool     `json:"multicast"`
		Addresses []string `json:"addresses"`
	}
	if json.Unmarshal([]byte(raw), &input) != nil {
		return errors.New("invalid interface snapshot")
	}
	output := make([]netmon.Interface, 0, len(input))
	for _, item := range input {
		flags := net.Flags(0)
		if item.Up {
			flags |= net.FlagUp | net.FlagRunning
		}
		if item.Loopback {
			flags |= net.FlagLoopback
		}
		if item.Multicast {
			flags |= net.FlagMulticast
		}
		iface := netmon.Interface{Interface: &net.Interface{Name: item.Name, Index: item.Index, MTU: item.MTU, Flags: flags}, AltAddrs: []net.Addr{}}
		for _, rawAddr := range item.Addresses {
			ip, subnet, err := net.ParseCIDR(rawAddr)
			if err != nil {
				return errors.New("invalid interface address")
			}
			subnet.IP = ip
			iface.AltAddrs = append(iface.AltAddrs, subnet)
		}
		output = append(output, iface)
	}
	interfaceMu.Lock()
	interfaceSnapshot = output
	interfaceMu.Unlock()
	return nil
}
