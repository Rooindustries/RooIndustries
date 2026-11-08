#include <errno.h>
#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/event.h>
#include <unistd.h>

struct member {
  int pid;
  unsigned long long seconds;
  unsigned long long micros;
};

struct watch {
  int queue;
  int root;
  const char *file;
  struct member *members;
  size_t count;
  char executable[PROC_PIDPATHINFO_MAXSIZE];
  struct member watcher;
  int changed;
};

static int identity(int pid, struct proc_bsdinfo *info) {
  return proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, info, sizeof(*info)) == sizeof(*info);
}

static int same(const struct member *member, int pid, const struct proc_bsdinfo *info) {
  return member->pid == pid && member->seconds == info->pbi_start_tvsec &&
    member->micros == info->pbi_start_tvusec;
}

static int remember(struct watch *watch, int pid, const struct proc_bsdinfo *info) {
  for (size_t index = 0; index < watch->count; index++) {
    if (same(&watch->members[index], pid, info)) return 0;
  }
  struct member *next = realloc(watch->members, (watch->count + 1) * sizeof(*next));
  if (!next) return -1;
  watch->members = next;
  watch->members[watch->count++] = (struct member){pid, info->pbi_start_tvsec, info->pbi_start_tvusec};
  watch->changed = 1;
  struct kevent change;
  EV_SET(&change, pid, EVFILT_PROC, EV_ADD | EV_ENABLE | EV_CLEAR, NOTE_FORK | NOTE_EXIT, 0, NULL);
  if (kevent(watch->queue, &change, 1, NULL, 0, NULL) < 0 && errno != ESRCH) return -1;
  return 0;
}

static int scan(struct watch *watch) {
  size_t live = 0;
  for (size_t index = 0; index < watch->count; index++) {
    struct proc_bsdinfo info;
    struct member member = watch->members[index];
    if (member.pid == watch->root || (identity(member.pid, &info) && same(&member, member.pid, &info))) {
      watch->members[live++] = member;
    }
  }
  if (live != watch->count) watch->changed = 1;
  watch->count = live;
  int capacity = proc_listallpids(NULL, 0) + 64;
  int *pids = calloc(capacity, sizeof(*pids));
  if (!pids) return -1;
  int count = proc_listallpids(pids, capacity * sizeof(*pids));
  if (count < 0) { free(pids); return -1; }
  for (int index = 0; index < count; index++) {
    struct proc_bsdinfo info, parent;
    int pid = pids[index];
    if (pid == getpid() || !identity(pid, &info) || info.pbi_ruid != getuid() ||
        !identity(info.pbi_ppid, &parent)) continue;
    for (size_t item = 0; item < watch->count; item++) {
      if (same(&watch->members[item], info.pbi_ppid, &parent)) {
        char executable[PROC_PIDPATHINFO_MAXSIZE];
        if (proc_pidpath(pid, executable, sizeof(executable)) > 0 && !strcmp(executable, watch->executable)) break;
        if (remember(watch, pid, &info) < 0) { free(pids); return -1; }
        break;
      }
    }
  }
  free(pids);
  return 0;
}

static int publish(struct watch *watch, int done) {
  if (!watch->changed && !done) return 0;
  size_t length = strlen(watch->file) + 5;
  char *temporary = malloc(length);
  if (!temporary) return -1;
  snprintf(temporary, length, "%s.tmp", watch->file);
  FILE *file = fopen(temporary, "w");
  if (!file) { free(temporary); return -1; }
  fprintf(file, "watcher %d %llu.%06llu\n", watch->watcher.pid,
    watch->watcher.seconds, watch->watcher.micros);
  for (size_t index = 0; index < watch->count; index++) {
    struct member member = watch->members[index];
    if (member.pid != watch->root) fprintf(file, "member %d %llu.%06llu\n", member.pid, member.seconds, member.micros);
  }
  if (done) fprintf(file, "done\n");
  int failed = fclose(file) || rename(temporary, watch->file);
  free(temporary);
  watch->changed = 0;
  return failed ? -1 : 0;
}

static int observe(int root, const char *file) {
  struct watch watch = {0};
  struct proc_bsdinfo owner, self;
  if (!identity(root, &owner) || !identity(getpid(), &self) ||
      proc_pidpath(getpid(), watch.executable, sizeof(watch.executable)) <= 0) return 1;
  watch.root = root;
  watch.file = file;
  watch.watcher = (struct member){getpid(), self.pbi_start_tvsec, self.pbi_start_tvusec};
  watch.queue = kqueue();
  if (watch.queue < 0 || remember(&watch, root, &owner) < 0 || publish(&watch, 0) < 0) return 1;
  struct kevent input;
  EV_SET(&input, 3, EVFILT_READ, EV_ADD | EV_ENABLE | EV_CLEAR, 0, 0, NULL);
  if (kevent(watch.queue, &input, 1, NULL, 0, NULL) < 0) return 1;
  puts("ready");
  fflush(stdout);
  for (;;) {
    if (scan(&watch) < 0 || publish(&watch, 0) < 0) return 1;
    struct kevent events[64];
    struct timespec timeout = {0, 100000000};
    int count = kevent(watch.queue, NULL, 0, events, 64, &timeout);
    if (count < 0) { if (errno == EINTR) continue; return 1; }
    int stopping = 0;
    for (int index = 0; index < count; index++) {
      if (events[index].filter == EVFILT_READ && events[index].ident == 3) {
        char buffer[16];
        if (read(3, buffer, sizeof(buffer)) <= 0) stopping = 1;
      }
    }
    if (stopping) {
      if (scan(&watch) < 0 || publish(&watch, 1) < 0) return 1;
      close(watch.queue);
      free(watch.members);
      return 0;
    }
  }
}

int main(int argc, char **argv) {
  if (argc == 4 && !strcmp(argv[1], "--watch")) return observe(atoi(argv[2]), argv[3]);
  if (argc != 1) return 1;
  int capacity = proc_listallpids(NULL, 0) + 64;
  int *pids = calloc(capacity, sizeof(int));
  if (!pids) return 1;
  int count = proc_listallpids(pids, capacity * sizeof(int));
  for (int index = 0; index < count; index++) {
    struct proc_bsdinfo info;
    int pid = pids[index];
    if (pid == getpid() || !identity(pid, &info)) continue;
    printf("%d %llu.%06llu %u %u %u %u\n", pid, info.pbi_start_tvsec, info.pbi_start_tvusec,
      info.pbi_ruid, info.pbi_ppid, info.pbi_pgid, info.pbi_status);
  }
  free(pids);
  return count < 0;
}
