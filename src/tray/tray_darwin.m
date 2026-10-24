//go:build darwin && !android && !androidtest

#import <Cocoa/Cocoa.h>
#import <CoreServices/CoreServices.h>
#import <objc/runtime.h>

#import "tray_darwin.h"

// Implemented in Go, see tray_darwin_callbacks.go.
extern void OrbitTrayAction(int action, int value);

enum {
    OrbitTrayActionReady = 0,
    OrbitTrayActionShow = 1,
    OrbitTrayActionHide = 2,
    OrbitTrayActionQuit = 3,
    OrbitTrayActionTerminate = 4
};

@interface OrbitTrayTarget : NSObject
@property (nonatomic, assign) int action;
@end

@implementation OrbitTrayTarget
- (void)clicked:(id)sender {
    OrbitTrayAction(self.action, 0);
}
@end

static NSStatusItem *sStatusItem = nil;
static OrbitTrayTarget *sShowTarget = nil;
static OrbitTrayTarget *sHideTarget = nil;
static OrbitTrayTarget *sQuitTarget = nil;

static void OrbitTrayAddAction(NSMenu *menu, NSString *title, OrbitTrayTarget *target) {
    NSMenuItem *item = [menu addItemWithTitle:title action:@selector(clicked:) keyEquivalent:@""];
    item.target = target;
}

// Draws a template image for systems without SF Symbols so the menu bar entry
// never ends up blank.
static NSImage *OrbitTrayFallbackImage(void) {
    NSImage *image = [[NSImage alloc] initWithSize:NSMakeSize(18, 18)];
    [image lockFocus];
    [[NSColor blackColor] setStroke];
    NSBezierPath *path = [NSBezierPath bezierPath];
    path.lineWidth = 1.6;
    path.lineCapStyle = NSLineCapStyleRound;
    path.lineJoinStyle = NSLineJoinStyleRound;
    // The ">" of a shell prompt.
    [path moveToPoint:NSMakePoint(4.0, 4.5)];
    [path lineToPoint:NSMakePoint(8.0, 9.0)];
    [path lineToPoint:NSMakePoint(4.0, 13.5)];
    // The "/" of a shell prompt.
    [path moveToPoint:NSMakePoint(9.5, 4.0)];
    [path lineToPoint:NSMakePoint(14.0, 14.0)];
    [path stroke];
    [image unlockFocus];
    image.template = YES;
    return image;
}

static NSImage *OrbitTrayImageFromPNG(NSData *data) {
    if (data == nil || data.length == 0) {
        return nil;
    }
    NSImage *image = [[NSImage alloc] initWithData:data];
    if (image == nil) {
        return nil;
    }
    image.template = YES;
    [image setSize:NSMakeSize(18, 18)];
    return image;
}

// The system symbol and the hand drawn glyph are fallbacks for a missing or
// unreadable artwork payload only, so the menu bar keeps showing the logo.
static NSImage *OrbitTrayImage(NSString *label) {
    if (@available(macOS 11.0, *)) {
        NSImage *image = [NSImage imageWithSystemSymbolName:@"terminal" accessibilityDescription:label];
        if (image == nil) {
            image = [NSImage imageWithSystemSymbolName:@"chevron.left.forwardslash.chevron.right" accessibilityDescription:label];
        }
        if (image != nil) {
            image.template = YES;
            [image setSize:NSMakeSize(18, 18)];
            return image;
        }
    }
    return OrbitTrayFallbackImage();
}

// Wails' AppDelegate does not implement applicationShouldHandleReopen:, so
// after the close button hides the window with orderOut: (close-to-tray) a
// Dock icon click activates the app but leaves the hidden window hidden. When
// the running delegate class misses the method, this hook is added to it and
// routes the reopen event to the same Show callback the tray menu uses.
static BOOL OrbitReopenShowWindow(id self, SEL cmd, NSApplication *sender, BOOL hasVisibleWindows) {
    OrbitTrayAction(OrbitTrayActionShow, 0);
    return YES;
}

// Wails 2.11 returns NSTerminateCancel immediately for every native Quit,
// including logout/restart/shutdown. It also routes those requests through the
// window-close path. Defer the native reply instead, while Go confirms exit and
// flushes history/closes sessions off the main thread.
static BOOL sTerminationPending = NO;
static BOOL sTerminationSystem = NO;

static BOOL OrbitIsSystemQuitReason(AEEventID reason) {
    return reason == kAEShutDown || reason == kAERestart ||
           reason == kAEReallyLogOut || reason == kAELogOut || reason == kAEQuitAll;
}

static NSApplicationTerminateReply OrbitApplicationShouldTerminate(id self, SEL cmd, NSApplication *sender) {
    NSAppleEventDescriptor *event = [[NSAppleEventManager sharedAppleEventManager] currentAppleEvent];
    NSAppleEventDescriptor *reason = [event attributeDescriptorForKeyword:kAEQuitReason];
    if (reason == nil) {
        reason = [event paramDescriptorForKeyword:kAEQuitReason];
    }
    BOOL system = OrbitIsSystemQuitReason(reason.typeCodeValue);
    if (system && NSApp.modalWindow != nil) {
        // A pre-existing user-Quit alert must not outlive OS end-session.
        [NSApp abortModal];
        [NSApp.modalWindow orderOut:nil];
    }
    if (!sTerminationPending || (system && !sTerminationSystem)) {
        sTerminationPending = YES;
        sTerminationSystem = system;
        OrbitTrayAction(OrbitTrayActionTerminate, system);
    }
    return NSTerminateLater;
}

// Wails' built-in Command-Q menu emits the same message as a window close.
// Route it through AppKit instead so it gets explicit-Quit confirmation.
static void OrbitRouteQuitMenu(NSMenu *menu) {
    for (NSMenuItem *item in menu.itemArray) {
        if (item.action == NSSelectorFromString(@"Quit")) {
            item.target = NSApp;
            item.action = @selector(terminate:);
        }
        if (item.submenu != nil) {
            OrbitRouteQuitMenu(item.submenu);
        }
    }
}

void OrbitTrayReplyToTermination(int approved, int system) {
    // Wails runs NSAlert.runModal inside a main-dispatch block. Another block
    // on that serial queue cannot run until the alert returns. Run-loop work
    // also executes inside AppKit's nested modal loop, so system shutdown can
    // dismiss a stale user confirmation and still deliver its native reply.
    CFRunLoopPerformBlock(CFRunLoopGetMain(),
                         (__bridge CFArrayRef)@[NSRunLoopCommonModes, NSModalPanelRunLoopMode], ^{
        if (!sTerminationPending || (sTerminationSystem && !system)) {
            return;
        }
        if (system && NSApp.modalWindow != nil) {
            NSWindow *modal = NSApp.modalWindow;
            [NSApp abortModal];
            [modal orderOut:nil];
        }
        sTerminationPending = NO;
        sTerminationSystem = NO;
        [NSApp replyToApplicationShouldTerminate:approved != 0];
    });
    CFRunLoopWakeUp(CFRunLoopGetMain());
}

static void OrbitTrayInstallApplicationHooks(BOOL handleTermination) {
    NSApplication *app = [NSApplication sharedApplication];
    if (app == nil || app.delegate == nil) {
        // The delegate is set before the run loop starts, so this retry is
        // only insurance for an unexpected launch order.
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
            OrbitTrayInstallApplicationHooks(handleTermination);
        });
        return;
    }
    Class delegateClass = object_getClass(app.delegate);
    if (delegateClass == nil) {
        return;
    }
    SEL reopenSelector = @selector(applicationShouldHandleReopen:hasVisibleWindows:);
    // Leave a delegate that handles reopen itself untouched, so a future Wails
    // version that ships the method keeps working unchanged.
    if (!class_respondsToSelector(delegateClass, reopenSelector)) {
        class_addMethod(delegateClass, reopenSelector, (IMP)OrbitReopenShowWindow, "c@:@c");
    }
    if (handleTermination) {
        OrbitRouteQuitMenu(app.mainMenu);
        SEL terminateSelector = @selector(applicationShouldTerminate:);
        Method method = class_getInstanceMethod(delegateClass, terminateSelector);
        // Use the existing ABI encoding (NSInteger return type differs by arch).
        if (method != NULL) {
            class_replaceMethod(delegateClass, terminateSelector,
                                (IMP)OrbitApplicationShouldTerminate, method_getTypeEncoding(method));
        }
    }
}

void OrbitTrayCreate(const char *title, const unsigned char *imageData, int imageLength, int handleTermination) {
    // Copy Go-owned buffers before returning, not later inside the async block.
    NSString *label = [NSString stringWithUTF8String:title];
    NSData *imageDataCopy = nil;
    if (imageData != NULL && imageLength > 0) {
        imageDataCopy = [NSData dataWithBytes:imageData length:(NSUInteger)imageLength];
    }
    dispatch_async(dispatch_get_main_queue(), ^{
        OrbitTrayInstallApplicationHooks(handleTermination != 0);
        if (sStatusItem != nil) {
            OrbitTrayAction(OrbitTrayActionReady, 1);
            return;
        }
        sStatusItem = [[NSStatusBar systemStatusBar] statusItemWithLength:NSSquareStatusItemLength];
        if (sStatusItem == nil) {
            OrbitTrayAction(OrbitTrayActionReady, 0);
            return;
        }
        NSImage *image = OrbitTrayImageFromPNG(imageDataCopy);
        if (image == nil) {
            image = OrbitTrayImage(label);
        }
        sStatusItem.button.image = image;
        sStatusItem.button.toolTip = label;

        sShowTarget = [[OrbitTrayTarget alloc] init];
        sShowTarget.action = OrbitTrayActionShow;
        sHideTarget = [[OrbitTrayTarget alloc] init];
        sHideTarget.action = OrbitTrayActionHide;
        sQuitTarget = [[OrbitTrayTarget alloc] init];
        sQuitTarget.action = OrbitTrayActionQuit;

        NSMenu *menu = [[NSMenu alloc] init];
        OrbitTrayAddAction(menu, @"打开 Orbit SSH", sShowTarget);
        OrbitTrayAddAction(menu, @"隐藏到菜单栏", sHideTarget);
        [menu addItem:[NSMenuItem separatorItem]];
        OrbitTrayAddAction(menu, @"退出 Orbit SSH", sQuitTarget);
        sStatusItem.menu = menu;
        OrbitTrayAction(OrbitTrayActionReady, 1);
    });
}

void OrbitTrayDestroy(void) {
    dispatch_async(dispatch_get_main_queue(), ^{
        if (sStatusItem == nil) {
            return;
        }
        [[NSStatusBar systemStatusBar] removeStatusItem:sStatusItem];
        sStatusItem = nil;
        sShowTarget = nil;
        sHideTarget = nil;
        sQuitTarget = nil;
    });
}
