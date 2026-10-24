//go:build (!windows && !linux && !darwin) || android || androidtest

package lifecycle

// Mobile and unsupported desktop platforms have no native session monitor.
func startPlatform(func()) (func(), error) {
	return func() {}, nil
}
