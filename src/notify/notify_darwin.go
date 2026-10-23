//go:build darwin && !android && !androidtest

package notify

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Foundation -framework UserNotifications -framework AppKit
#include <stdlib.h>
#include "notify_darwin.h"
*/
import "C"

import "unsafe"

func init() {
	postNotice = darwinPostApproval
	closeNotice = darwinCloseApproval
}

func darwinCloseApproval(requestID string) {
	cID := C.CString(requestID)
	defer C.free(unsafe.Pointer(cID))
	C.OrbitNotifyForget(cID)
}

//export OrbitNotifyIsPending
func OrbitNotifyIsPending(requestID *C.char) C.int {
	if isPending(C.GoString(requestID)) {
		return 1
	}
	return 0
}

func darwinPostApproval(title, body, requestID string) bool {
	cTitle := C.CString(title)
	defer C.free(unsafe.Pointer(cTitle))
	cBody := C.CString(body)
	defer C.free(unsafe.Pointer(cBody))
	cID := C.CString(requestID)
	defer C.free(unsafe.Pointer(cID))
	return C.OrbitNotifyApproval(cTitle, cBody, cID) != 0
}

// OrbitNotifyResponse is invoked on the main thread by the notification
// delegate for category actions and the default banner tap. Actions: 0 =
// activate the app, 1 = approve, 2 = reject.
//
//export OrbitNotifyResponse
func OrbitNotifyResponse(action C.int, requestID *C.char) {
	id := C.GoString(requestID)
	notify := pull(id)
	switch action {
	case 0:
		if notify.Activate != nil {
			go notify.Activate()
		}
	case 1, 2:
		if notify.Decide != nil {
			go func(approved bool) {
				_ = notify.Decide(approved)
			}(action == 1)
		}
	}
}
