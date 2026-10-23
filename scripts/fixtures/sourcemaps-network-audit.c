#define _GNU_SOURCE
#include <arpa/inet.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

int roo_sourcemaps_network_audit(void) { return 1; }

static void audit(const char *kind) {
  const char *path = getenv("ROO_SOURCEMAPS_NETWORK_LOG");
  if (!path) _exit(86);
  int fd = open(path, O_WRONLY | O_CREAT | O_APPEND, 0600);
  if (fd < 0 || dprintf(fd, "%s\n", kind) < 0) _exit(86);
  close(fd);
}

static int local_ipv6(const struct in6_addr *address) {
  return IN6_IS_ADDR_LOOPBACK(address) ||
    (IN6_IS_ADDR_V4MAPPED(address) && address->s6_addr[12] == 127);
}

int getaddrinfo(const char *host, const char *service, const struct addrinfo *hints, struct addrinfo **result) {
  int (*original)(const char *, const char *, const struct addrinfo *, struct addrinfo **);
  struct in_addr ipv4;
  struct in6_addr ipv6;
  int local = !host || strcmp(host, "localhost") == 0 ||
    (inet_pton(AF_INET, host, &ipv4) == 1 && (ntohl(ipv4.s_addr) >> 24) == 127) ||
    (inet_pton(AF_INET6, host, &ipv6) == 1 && local_ipv6(&ipv6));
  if (!local) { audit("BLOCK-native-dns"); return EAI_NONAME; }
  original = dlsym(RTLD_NEXT, "getaddrinfo");
  if (!original) _exit(86);
  return original(host, service, hints, result);
}

int connect(int fd, const struct sockaddr *address, socklen_t length) {
  int (*original)(int, const struct sockaddr *, socklen_t);
  int blocked = address &&
    ((address->sa_family == AF_INET && (ntohl(((const struct sockaddr_in *)address)->sin_addr.s_addr) >> 24) != 127) ||
     (address->sa_family == AF_INET6 && !local_ipv6(&((const struct sockaddr_in6 *)address)->sin6_addr)));
  if (blocked) { audit("BLOCK-native-connect"); errno = ENETUNREACH; return -1; }
  original = dlsym(RTLD_NEXT, "connect");
  if (!original) _exit(86);
  return original(fd, address, length);
}
