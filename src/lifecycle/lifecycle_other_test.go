//go:build (!windows && !linux && !darwin) || android || androidtest

package lifecycle

import "testing"

func TestLifecycleFallbackDoesNotInvokeCallback(t *testing.T) {
	stop, err := Start(func() { t.Fatal("unsupported-platform monitor invoked callback") })
	if err != nil || stop == nil {
		t.Fatalf("Start: stop available=%v err=%v", stop != nil, err)
	}
	stop()
	stop()
}

func TestLifecycleFallbackNilCallback(t *testing.T) {
	stop, err := Start(nil)
	if err != nil || stop == nil {
		t.Fatalf("Start(nil): stop available=%v err=%v", stop != nil, err)
	}
	stop()
}
