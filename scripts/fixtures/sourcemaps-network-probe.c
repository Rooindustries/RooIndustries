#define _GNU_SOURCE
#include <arpa/inet.h>
#include <dlfcn.h>
#include <errno.h>
#include <netdb.h>
#include <sys/socket.h>
#include <unistd.h>

int main(void) {
  int (*active)(void) = dlsym(RTLD_DEFAULT, "roo_sourcemaps_network_audit");
  if (!active || active() != 1) return 78;
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return 1;
  struct sockaddr_in address = { .sin_family = AF_INET, .sin_port = htons(443) };
  inet_pton(AF_INET, "203.0.113.1", &address.sin_addr);
  int result = connect(fd, (const struct sockaddr *)&address, sizeof(address));
  int refusal = errno;
  close(fd);
  if (result != -1 || refusal != ENETUNREACH) return 1;
  struct addrinfo *addresses = 0;
  return getaddrinfo("sourcemaps-guard.invalid", "443", 0, &addresses) == EAI_NONAME ? 0 : 1;
}
