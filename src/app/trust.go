package app

import (
	"net"
	"strconv"
)

// hostAddress returns the key used by the known-hosts table and by dialing.
func hostAddress(host Host) string {
	return net.JoinHostPort(host.Address, strconv.Itoa(host.Port))
}

// TrustedFingerprint returns the SHA-256 fingerprint saved for the host's own
// endpoint, or an empty string when the host has not been trusted yet. Only the
// target host is exposed; jump host trust stays internal to the connection.
func (a *App) TrustedFingerprint(hostID string) (string, error) {
	if err := a.ready(); err != nil {
		return "", err
	}
	host, err := a.store.host(hostID)
	if err != nil {
		return "", err
	}
	address := hostAddress(host)
	a.store.mu.Lock()
	defer a.store.mu.Unlock()
	return a.store.state.KnownHosts[address], nil
}

// ForgetHostKey removes the saved fingerprint for the host's own endpoint so the
// next connection asks for confirmation again. Sessions that are already
// connected keep their verified transport; only future handshakes are affected.
func (a *App) ForgetHostKey(hostID string) error {
	if err := a.ready(); err != nil {
		return err
	}
	host, err := a.store.host(hostID)
	if err != nil {
		return err
	}
	address := hostAddress(host)
	a.store.mu.Lock()
	defer a.store.mu.Unlock()
	previous, ok := a.store.state.KnownHosts[address]
	if !ok {
		return nil
	}
	delete(a.store.state.KnownHosts, address)
	if err := a.store.persistLocked(); err != nil {
		a.store.state.KnownHosts[address] = previous
		return err
	}
	return nil
}
