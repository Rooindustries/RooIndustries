#define _GNU_SOURCE
#include <errno.h>
#include <signal.h>
#include <sys/prctl.h>
#include <sys/wait.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc < 2 || prctl(PR_SET_CHILD_SUBREAPER, 1) < 0) return 1;
  pid_t child = fork();
  if (child < 0) return 1;
  if (!child) { execvp(argv[1], &argv[1]); return 127; }
  close_range(0, ~0U, 0);
  int status;
  while (waitpid(child, &status, 0) < 0) if (errno != EINTR) return 1;
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) {
    int signal_number = WTERMSIG(status);
    signal(signal_number, SIG_DFL);
    raise(signal_number);
  }
  return 1;
}
