#define _GNU_SOURCE
#include <errno.h>
#include <sched.h>
#include <signal.h>
#include <stdio.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

/*
 * A tracing parent can consume SIGSTOP at a signal-delivery stop instead of
 * letting it become a sustained group stop. Only suspension fixtures use this
 * launcher; the child's environment, local socket and fake transports are
 * still selected by the TypeScript harness.
 *
 * Fork semantics (no shared address space or alternate stack), but do not
 * inherit the caller's ptrace tracer. Keep IPC fd 3 for the Node worker.
 */
int main(int argc, char **argv) {
  if (argc < 3) {
    fprintf(stderr, "Usage: suspension-launcher node worker.cjs\n");
    return 2;
  }
  pid_t parent = getpid();
  pid_t child = syscall(SYS_clone, CLONE_UNTRACED | SIGCHLD, 0, 0, 0, 0);
  if (child < 0) {
    perror("clone suspension worker");
    return 2;
  }
  if (child == 0) {
    // A killed launcher must never orphan a stopped synthetic worker. Also
    // close the parent-death race between clone and installing this signal.
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) < 0 || getppid() != parent) {
      return 2;
    }
    execv(argv[1], &argv[1]);
    perror("exec suspension worker");
    return 2;
  }
  close(3);
  int status;
  while (waitpid(child, &status, 0) < 0) {
    if (errno == EINTR) continue;
    perror("wait suspension worker");
    return 2;
  }
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  return 128 + WTERMSIG(status);
}
