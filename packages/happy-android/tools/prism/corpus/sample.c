// Observe macOS system capability changes for the Happy CLI.
//
// This helper is intentionally read-only. It does not create power
// assertions, acknowledge sleep notifications, or initiate a power event.

#include <CoreFoundation/CoreFoundation.h>
#include <IOKit/IOKitLib.h>
#include <IOKit/IOMessage.h>
#include <IOKit/pwr_mgt/IOPM.h>

#include <signal.h>
#include <stdio.h>
#include <unistd.h>

static volatile sig_atomic_t shouldStop = 0;

static void stopHandler(int signalNumber) {
    (void)signalNumber;
    shouldStop = 1;
}

static void emitCapabilityChange(
    const struct IOPMSystemCapabilityChangeParameters *change
) {
    const char *phase = "unknown";

    if ((change->changeFlags & kIOPMSystemCapabilityDidChange) != 0) {
        phase = "did-change";
    } else if ((change->changeFlags & kIOPMSystemCapabilityWillChange) != 0) {
        phase = "will-change";
    } else if (change->changeFlags == 0 && change->fromCapabilities == 0) {
        phase = "initial";
    }

    // Keep stdout machine-readable: one JSON object per line and no other
    // stdout output. The CLI only consumes the `to` capability mask.
    printf(
        "{\"event\":\"capability-change\",\"phase\":\"%s\",\"flags\":%u,\"from\":%u,\"to\":%u}\n",
        phase,
        change->changeFlags,
        change->fromCapabilities,
        change->toCapabilities
    );
    fflush(stdout);
}

static void capabilityChanged(
    void *refcon,
    io_service_t service,
    uint32_t messageType,
    void *messageArgument
) {
    (void)refcon;
    (void)service;

    if (messageType != kIOMessageSystemCapabilityChange || messageArgument == NULL) {
        return;
    }

    emitCapabilityChange(
        (const struct IOPMSystemCapabilityChangeParameters *)messageArgument
    );
}

int main(void) {
    signal(SIGINT, stopHandler);
    signal(SIGTERM, stopHandler);

    const pid_t parentPid = getppid();
    if (parentPid <= 1) {
        fputs("invalid parent process\n", stderr);
        return 1;
    }

    // A null main port asks IOKit for its default port and avoids depending
    // on the macOS 12-only spelling of that constant.
    IONotificationPortRef notificationPort = IONotificationPortCreate(MACH_PORT_NULL);
    if (notificationPort == NULL) {
        fputs("IONotificationPortCreate failed\n", stderr);
        return 1;
    }

    io_service_t rootDomain = IOServiceGetMatchingService(
        MACH_PORT_NULL,
        IOServiceMatching("IOPMrootDomain")
    );
    if (rootDomain == IO_OBJECT_NULL) {
        fputs("IOPMrootDomain not found\n", stderr);
        IONotificationPortDestroy(notificationPort);
        return 1;
    }

    io_object_t notification = IO_OBJECT_NULL;
    kern_return_t result = IOServiceAddInterestNotification(
        notificationPort,
        rootDomain,
        kIOPriorityPowerStateInterest,
        capabilityChanged,
        NULL,
        &notification
    );
    if (result != KERN_SUCCESS) {
        fprintf(stderr, "IOServiceAddInterestNotification failed: 0x%x\n", result);
        IOObjectRelease(rootDomain);
        IONotificationPortDestroy(notificationPort);
        return 1;
    }

    CFRunLoopRef runLoop = CFRunLoopGetCurrent();
    CFRunLoopSourceRef source = IONotificationPortGetRunLoopSource(notificationPort);
    if (source == NULL) {
        fputs("IOKit notification run-loop source unavailable\n", stderr);
        IOObjectRelease(notification);
        IOObjectRelease(rootDomain);
        IONotificationPortDestroy(notificationPort);
        return 1;
    }
    CFRunLoopAddSource(runLoop, source, kCFRunLoopDefaultMode);

    while (!shouldStop) {
        if (getppid() != parentPid) {
            break;
        }
        CFRunLoopRunInMode(kCFRunLoopDefaultMode, 1.0, true);
    }

    CFRunLoopRemoveSource(runLoop, source, kCFRunLoopDefaultMode);
    IOObjectRelease(notification);
    IOObjectRelease(rootDomain);
    IONotificationPortDestroy(notificationPort);
    return 0;
}