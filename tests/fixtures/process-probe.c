#include <arpa/inet.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc != 2) return 2;
  if (!strcmp(argv[1], "wait")) {
    const char *host = getenv("FIXTURE_HOST");
    if (host) {
      int server = socket(AF_INET6, SOCK_STREAM, 0);
      struct sockaddr_in6 address = {0};
      address.sin6_family = AF_INET6;
      address.sin6_port = htons(atoi(getenv("FIXTURE_PORT")));
      if (inet_pton(AF_INET6, host, &address.sin6_addr) != 1 || server < 0 ||
          bind(server, (struct sockaddr *)&address, sizeof(address)) || listen(server, 16)) return 3;
    }
    printf("%d\n", getpid());
    fflush(stdout);
    for (;;) pause();
  }
  if (strcmp(argv[1], "immediate-detach")) return 2;
  int channel[2];
  if (pipe(channel)) return 4;
  pid_t first = fork();
  if (first < 0) return 5;
  if (first == 0) {
    close(channel[0]);
    if (setsid() < 0) _exit(6);
    pid_t second = fork();
    if (second < 0) _exit(7);
    if (second > 0) _exit(0);
    int null = open("/dev/null", O_RDWR);
    for (int fd = 0; fd < 3; fd++) dup2(null, fd);
    close(null);
    pid_t pid = getpid();
    const char *pid_file = getenv("FIXTURE_PID_FILE");
    if (pid_file) {
      FILE *file = fopen(pid_file, "w");
      if (!file) _exit(10);
      fprintf(file, "%d\n", pid);
      fclose(file);
    }
    if (write(channel[1], &pid, sizeof(pid)) != sizeof(pid)) _exit(8);
    close(channel[1]);
    for (;;) pause();
  }
  close(channel[1]);
  pid_t detached;
  ssize_t bytes = read(channel[0], &detached, sizeof(detached));
  close(channel[0]);
  waitpid(first, NULL, 0);
  if (bytes != sizeof(detached)) return 9;
  printf("%d\n", detached);
  return 0;
}
