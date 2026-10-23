//go:build darwin && !android && !androidtest

package notify

import (
	"testing"
	"time"
)

func TestDarwinNotificationCannotApprovePreview(t *testing.T) {
	testBackend(t, nil, nil)
	for _, action := range []int{0, 1, 2} {
		activated := make(chan struct{}, 1)
		decided := make(chan bool, 1)
		const id = "darwin-preview"
		Register(id, Handlers{
			Activate: func() { activated <- struct{}{} },
			Decide: func(approved bool) error {
				decided <- approved
				return nil
			},
		})
		darwinHandleResponse(action, id)
		if action == 2 {
			select {
			case approved := <-decided:
				if approved {
					t.Fatal("notification approved hidden content")
				}
			case <-time.After(time.Second):
				t.Fatal("reject did not resolve")
			}
		} else {
			select {
			case <-activated:
			case approved := <-decided:
				t.Fatalf("preview action decided request: %v", approved)
			case <-time.After(time.Second):
				t.Fatal("preview did not open full command")
			}
		}
		Forget(id)
	}
}
