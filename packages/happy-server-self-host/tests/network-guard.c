#define _GNU_SOURCE

#include <arpa/inet.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>

static void record_attempt(const char *operation, const char *target) {
    const char *log_path = getenv("HAPPY_NETWORK_GUARD_LOG");
    if (!log_path || !*log_path) {
        return;
    }

    char line[1024];
    int length = snprintf(line, sizeof(line), "pid=%ld operation=%s target=%s\n",
                          (long)getpid(), operation, target ? target : "<null>");
    if (length <= 0) {
        return;
    }
    if ((size_t)length >= sizeof(line)) {
        length = (int)sizeof(line) - 1;
    }

    int fd = open(log_path, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0600);
    if (fd >= 0) {
        (void)write(fd, line, (size_t)length);
        (void)close(fd);
    }
}

static bool is_ipv4_loopback(const struct in_addr *address) {
    return (ntohl(address->s_addr) >> 24) == 127;
}

static bool is_ipv6_loopback_or_mapped_loopback(const struct in6_addr *address) {
    if (IN6_IS_ADDR_LOOPBACK(address)) {
        return true;
    }
    if (!IN6_IS_ADDR_V4MAPPED(address)) {
        return false;
    }
    struct in_addr mapped;
    memcpy(&mapped, &address->s6_addr[12], sizeof(mapped));
    return is_ipv4_loopback(&mapped);
}

static bool is_loopback_sockaddr(const struct sockaddr *address) {
    if (!address) {
        return true;
    }
    if (address->sa_family == AF_INET) {
        return is_ipv4_loopback(&((const struct sockaddr_in *)address)->sin_addr);
    }
    if (address->sa_family == AF_INET6) {
        return is_ipv6_loopback_or_mapped_loopback(
            &((const struct sockaddr_in6 *)address)->sin6_addr);
    }
    return true;
}

static void format_sockaddr(const struct sockaddr *address, char *buffer, size_t size) {
    if (!address) {
        snprintf(buffer, size, "<connected-socket>");
        return;
    }

    char host[INET6_ADDRSTRLEN] = {0};
    unsigned int port = 0;
    if (address->sa_family == AF_INET) {
        const struct sockaddr_in *ipv4 = (const struct sockaddr_in *)address;
        inet_ntop(AF_INET, &ipv4->sin_addr, host, sizeof(host));
        port = ntohs(ipv4->sin_port);
    } else if (address->sa_family == AF_INET6) {
        const struct sockaddr_in6 *ipv6 = (const struct sockaddr_in6 *)address;
        inet_ntop(AF_INET6, &ipv6->sin6_addr, host, sizeof(host));
        port = ntohs(ipv6->sin6_port);
    } else {
        snprintf(buffer, size, "family=%d", address->sa_family);
        return;
    }
    snprintf(buffer, size, "%s:%u", host, port);
}

static bool is_allowed_name(const char *node) {
    if (!node || strcmp(node, "localhost") == 0 || strcmp(node, "localhost.") == 0) {
        return true;
    }

    struct in_addr ipv4;
    if (inet_pton(AF_INET, node, &ipv4) == 1) {
        return is_ipv4_loopback(&ipv4);
    }

    struct in6_addr ipv6;
    if (inet_pton(AF_INET6, node, &ipv6) == 1) {
        return is_ipv6_loopback_or_mapped_loopback(&ipv6);
    }

    return false;
}

int getaddrinfo(const char *node, const char *service,
                const struct addrinfo *hints, struct addrinfo **result) {
    static int (*real_getaddrinfo)(const char *, const char *,
                                   const struct addrinfo *, struct addrinfo **) = NULL;
    if (!real_getaddrinfo) {
        real_getaddrinfo = dlsym(RTLD_NEXT, "getaddrinfo");
    }
    if (!is_allowed_name(node)) {
        char target[768];
        snprintf(target, sizeof(target), "%s:%s", node, service ? service : "<none>");
        record_attempt("dns", target);
        return EAI_NONAME;
    }
    return real_getaddrinfo(node, service, hints, result);
}

int connect(int socket_fd, const struct sockaddr *address, socklen_t length) {
    static int (*real_connect)(int, const struct sockaddr *, socklen_t) = NULL;
    if (!real_connect) {
        real_connect = dlsym(RTLD_NEXT, "connect");
    }
    if ((address && (address->sa_family == AF_INET || address->sa_family == AF_INET6)) &&
        !is_loopback_sockaddr(address)) {
        char target[128];
        format_sockaddr(address, target, sizeof(target));
        record_attempt("connect", target);
        errno = ENETUNREACH;
        return -1;
    }
    return real_connect(socket_fd, address, length);
}

ssize_t sendto(int socket_fd, const void *buffer, size_t length, int flags,
               const struct sockaddr *destination, socklen_t destination_length) {
    static ssize_t (*real_sendto)(int, const void *, size_t, int,
                                  const struct sockaddr *, socklen_t) = NULL;
    if (!real_sendto) {
        real_sendto = dlsym(RTLD_NEXT, "sendto");
    }
    if ((destination && (destination->sa_family == AF_INET || destination->sa_family == AF_INET6)) &&
        !is_loopback_sockaddr(destination)) {
        char target[128];
        format_sockaddr(destination, target, sizeof(target));
        record_attempt("sendto", target);
        errno = ENETUNREACH;
        return -1;
    }
    return real_sendto(socket_fd, buffer, length, flags, destination, destination_length);
}

ssize_t sendmsg(int socket_fd, const struct msghdr *message, int flags) {
    static ssize_t (*real_sendmsg)(int, const struct msghdr *, int) = NULL;
    if (!real_sendmsg) {
        real_sendmsg = dlsym(RTLD_NEXT, "sendmsg");
    }
    const struct sockaddr *destination = message ? (const struct sockaddr *)message->msg_name : NULL;
    if ((destination && (destination->sa_family == AF_INET || destination->sa_family == AF_INET6)) &&
        !is_loopback_sockaddr(destination)) {
        char target[128];
        format_sockaddr(destination, target, sizeof(target));
        record_attempt("sendmsg", target);
        errno = ENETUNREACH;
        return -1;
    }
    return real_sendmsg(socket_fd, message, flags);
}
