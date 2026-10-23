//go:build darwin && !android && !androidtest

#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>
#import "notify_darwin.h"

extern void OrbitNotifyResponse(int action, char *requestID);
extern int OrbitNotifyIsPending(char *requestID);

static NSString *const OrbitApprovalCategory = @"ORBIT_APPROVAL";
static NSString *const OrbitApprovalAllow = @"ORBIT_APPROVAL_ALLOW";
static NSString *const OrbitApprovalDeny = @"ORBIT_APPROVAL_DENY";

API_AVAILABLE(macos(10.14))
@interface OrbitNotifyDelegate : NSObject <UNUserNotificationCenterDelegate>
@end

static OrbitNotifyDelegate *sDelegate API_AVAILABLE(macos(10.14));

@implementation OrbitNotifyDelegate
- (void)userNotificationCenter:(UNUserNotificationCenter *)center
    didReceiveNotificationResponse:(UNNotificationResponse *)response
    withCompletionHandler:(void (^)(void))completionHandler {
    NSString *requestID = response.notification.request.content.userInfo[@"requestID"];
    NSString *action = response.actionIdentifier;
    if (requestID != nil) {
        if ([action isEqualToString:OrbitApprovalAllow]) {
            // Legacy banners may still carry Allow. Never approve a preview:
            // open the app so the entire command can be inspected instead.
            OrbitNotifyResponse(0, (char *)requestID.UTF8String);
        } else if ([action isEqualToString:OrbitApprovalDeny]) {
            OrbitNotifyResponse(2, (char *)requestID.UTF8String);
        } else if ([action isEqualToString:UNNotificationDefaultActionIdentifier]) {
            OrbitNotifyResponse(0, (char *)requestID.UTF8String);
        }
    }
    completionHandler();
}

- (void)userNotificationCenter:(UNUserNotificationCenter *)center
    willPresentNotification:(UNNotification *)notification
    withCompletionHandler:(void (^)(UNNotificationPresentationOptions))completionHandler {
    // Remind even while Orbit SSH is active: a command may target a different
    // terminal than the one the user is looking at.
    if (@available(macOS 11.0, *)) {
        completionHandler(UNNotificationPresentationOptionList |
            UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionSound);
    } else {
        completionHandler(UNNotificationPresentationOptionAlert | UNNotificationPresentationOptionSound);
    }
}
@end

static UNUserNotificationCenter *OrbitNotifyCenter(void) API_AVAILABLE(macos(10.14));
static UNUserNotificationCenter *OrbitNotifyCenter(void) {
    static UNUserNotificationCenter *center;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        center = [UNUserNotificationCenter currentNotificationCenter];
        sDelegate = [OrbitNotifyDelegate new];
        center.delegate = sDelegate;
        UNNotificationAction *open = [UNNotificationAction
            actionWithIdentifier:OrbitApprovalAllow title:@"查看命令"
            options:UNNotificationActionOptionForeground];
        UNNotificationAction *deny = [UNNotificationAction
            actionWithIdentifier:OrbitApprovalDeny title:@"拒绝"
            options:UNNotificationActionOptionNone];
        UNNotificationCategory *category = [UNNotificationCategory
            categoryWithIdentifier:OrbitApprovalCategory actions:@[open, deny]
            intentIdentifiers:@[] options:UNNotificationCategoryOptionNone];
        [center setNotificationCategories:[NSSet setWithObject:category]];
    });
    return center;
}

static void OrbitPostApproval(UNUserNotificationCenter *center,
    NSString *title, NSString *body, NSString *requestID) API_AVAILABLE(macos(10.14));
static void OrbitPostApproval(UNUserNotificationCenter *center,
    NSString *title, NSString *body, NSString *requestID) {
    // Authorization can stay open for longer than the MCP request. Never post
    // a stale banner after the user has already decided or the request expired.
    if (!OrbitNotifyIsPending((char *)requestID.UTF8String)) {
        return;
    }
    UNMutableNotificationContent *content = [UNMutableNotificationContent new];
    content.title = title;
    content.body = body;
    content.categoryIdentifier = OrbitApprovalCategory;
    content.userInfo = @{@"requestID": requestID};
    content.sound = [UNNotificationSound defaultSound];
    UNNotificationRequest *request = [UNNotificationRequest
        requestWithIdentifier:requestID content:content trigger:nil];
    __weak UNUserNotificationCenter *weakCenter = center;
    [center addNotificationRequest:request withCompletionHandler:^(NSError *error) {
        if (error != nil) {
            NSLog(@"OrbitSSH notification failed: %@", error);
        }
        if (!OrbitNotifyIsPending((char *)requestID.UTF8String)) {
            [weakCenter removePendingNotificationRequestsWithIdentifiers:@[requestID]];
            [weakCenter removeDeliveredNotificationsWithIdentifiers:@[requestID]];
        }
    }];
}

int OrbitNotifyApproval(const char *title, const char *body, const char *requestID) {
    if (@available(macOS 10.14, *)) {
        // Copy before returning to Go; the caller frees the C strings.
        NSString *orbitTitle = [NSString stringWithUTF8String:title];
        NSString *orbitBody = [NSString stringWithUTF8String:body];
        NSString *orbitID = [NSString stringWithUTF8String:requestID];
        dispatch_async(dispatch_get_main_queue(), ^{
            UNUserNotificationCenter *center = OrbitNotifyCenter();
            [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
                if (settings.authorizationStatus == UNAuthorizationStatusNotDetermined) {
                    [center requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionSound)
                        completionHandler:^(BOOL granted, NSError *error) {
                            if (granted) {
                                OrbitPostApproval(center, orbitTitle, orbitBody, orbitID);
                            }
                        }];
                } else if (settings.authorizationStatus == UNAuthorizationStatusAuthorized ||
                           settings.authorizationStatus == UNAuthorizationStatusProvisional) {
                    OrbitPostApproval(center, orbitTitle, orbitBody, orbitID);
                }
            }];
        });
        return 1;
    }
    return 0;
}

void OrbitNotifyForget(const char *requestID) {
    if (@available(macOS 10.14, *)) {
        NSString *orbitID = [NSString stringWithUTF8String:requestID];
        dispatch_async(dispatch_get_main_queue(), ^{
            UNUserNotificationCenter *center = OrbitNotifyCenter();
            [center removePendingNotificationRequestsWithIdentifiers:@[orbitID]];
            [center removeDeliveredNotificationsWithIdentifiers:@[orbitID]];
        });
    }
}
