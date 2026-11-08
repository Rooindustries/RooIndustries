#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>

int main(void) {
  int capacity = proc_listallpids(NULL, 0) + 64;
  int *pids = calloc(capacity, sizeof(int));
  if (!pids) return 1;
  int count = proc_listallpids(pids, capacity * sizeof(int));
  for (int index = 0; index < count; index++) {
    struct proc_bsdinfo info;
    int pid = pids[index];
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info)) continue;
    printf("%d %llu.%06llu %u\n", pid, info.pbi_start_tvsec, info.pbi_start_tvusec, info.pbi_ruid);
  }
  free(pids);
  return count < 0;
}
