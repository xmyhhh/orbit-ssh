// Compile with: clang -fobjc-arc -framework Cocoa -framework CoreFoundation
// scripts/tests/macos-termination.m -o <temporary-output>
// This test intercepts the AppKit reply. It never calls real system shutdown.
#import <Cocoa/Cocoa.h>
#import <CoreFoundation/CoreFoundation.h>
#import "../../src/tray/tray_darwin.m"

static int actionCount = 0;
static int replyCount = 0;
static BOOL lastReply = NO;
static int lastReason = -1;

void OrbitTrayAction(int action, int value) {
    if (action == OrbitTrayActionTerminate) {
        actionCount++;
        lastReason = value;
    }
}

@interface TestApplication : NSApplication
@end
@implementation TestApplication
- (void)replyToApplicationShouldTerminate:(BOOL)approved {
    replyCount++;
    lastReply = approved;
}
@end

@interface TestDelegate : NSObject <NSApplicationDelegate>
@end
@implementation TestDelegate
- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender {
    return NSTerminateCancel;
}
@end

static void PumpUntilReply(int expected) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:2];
    while (replyCount < expected && [deadline timeIntervalSinceNow] > 0) {
        CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.01, false);
    }
    NSCAssert(replyCount == expected, @"native completion did not arrive");
}

int main(void) {
    @autoreleasepool {
        TestApplication *app = [TestApplication sharedApplication];
        TestDelegate *delegate = [TestDelegate new];
        app.delegate = delegate;
        NSMenu *menu = [NSMenu new];
        NSMenuItem *quit = [menu addItemWithTitle:@"Quit" action:NSSelectorFromString(@"Quit") keyEquivalent:@"q"];
        app.mainMenu = menu;
        OrbitTrayInstallApplicationHooks(YES);
        NSCAssert(quit.action == @selector(terminate:) && quit.target == app, @"Command-Q still follows window-close path");
        NSCAssert(OrbitIsSystemQuitReason(kAEShutDown) && OrbitIsSystemQuitReason(kAERestart) &&
                  OrbitIsSystemQuitReason(kAEReallyLogOut) && OrbitIsSystemQuitReason(kAELogOut) &&
                  OrbitIsSystemQuitReason(kAEQuitAll) && !OrbitIsSystemQuitReason(0), @"quit reason classification failed");
        NSCAssert([delegate applicationShouldTerminate:app] == NSTerminateLater, @"request was cancelled immediately");
        NSCAssert([delegate applicationShouldTerminate:app] == NSTerminateLater, @"duplicate request not deferred");
        NSCAssert(actionCount == 1 && lastReason == 0 && sTerminationPending, @"duplicate Go work or missing pending state");
        OrbitTrayReplyToTermination(0, 0);
        NSCAssert(replyCount == 0, @"reply was synchronous");
        PumpUntilReply(1);
        NSCAssert(!lastReply && !sTerminationPending, @"cancel did not reset pending state");
        OrbitTrayReplyToTermination(1, 0);
        CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.05, false);
        NSCAssert(replyCount == 1, @"duplicate reply was sent");
        NSCAssert([delegate applicationShouldTerminate:app] == NSTerminateLater, @"retry not deferred");
        NSCAssert(actionCount == 2, @"retry did not reach Go");
        // Simulate a pending user Quit being superseded by OS end-session.
        sTerminationSystem = YES;
        OrbitTrayReplyToTermination(0, 0);
        CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.05, false);
        NSCAssert(replyCount == 1 && sTerminationPending, @"stale user cancellation blocked OS shutdown");
        OrbitTrayReplyToTermination(1, 1);
        PumpUntilReply(2);
        NSCAssert(lastReply && !sTerminationPending, @"approval not delivered");
        // Match Wails' scheduling: a main-dispatch block pumps a nested modal
        // loop, so another serial main-dispatch block cannot deliver the reply.
        __block BOOL nestedCompleted = NO;
        sTerminationPending = YES;
        sTerminationSystem = YES;
        dispatch_async(dispatch_get_main_queue(), ^{
            dispatch_async(dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0), ^{
                OrbitTrayReplyToTermination(1, 1);
            });
            NSDate *limit = [NSDate dateWithTimeIntervalSinceNow:2];
            while (replyCount < 3 && [limit timeIntervalSinceNow] > 0) {
                CFRunLoopRunInMode((__bridge CFStringRef)NSModalPanelRunLoopMode, 0.01, false);
            }
            NSCAssert(replyCount == 3, @"reply was trapped behind Wails' modal main-queue block");
            nestedCompleted = YES;
        });
        NSDate *limit = [NSDate dateWithTimeIntervalSinceNow:3];
        while (!nestedCompleted && [limit timeIntervalSinceNow] > 0) {
            CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.01, false);
        }
        NSCAssert(nestedCompleted, @"nested-modal regression did not finish");
        puts("PASS: native quit, system reasons, deferred/modal replies, duplicates, cancellation, retry and stale reply suppression");
    }
    return 0;
}
