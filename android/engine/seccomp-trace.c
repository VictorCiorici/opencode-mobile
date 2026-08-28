// shim-trace.c — ptrace tracer in place of ld-linux-aarch64.so.1.
// Forks the real loader (ld-real.so.1), traces it, and on a seccomp SIGSYS
// stop prints the offending syscall number to stderr (which the daemon
// surfaces in /api/health "error").

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <signal.h>
#include <errno.h>
#include <limits.h>
#include <libgen.h>
#include <sys/ptrace.h>
#include <sys/wait.h>
#include <sys/user.h>

int main(int argc, char **argv) {
    char self[PATH_MAX];
    strncpy(self, argv[0], sizeof(self) - 1);
    self[sizeof(self) - 1] = '\0';
    char real[PATH_MAX];
    snprintf(real, sizeof(real), "%s/ld-real.so.1", dirname(self));

    pid_t pid = fork();
    if (pid < 0) { perror("fork"); return 126; }
    if (pid == 0) {
        if (ptrace(PTRACE_TRACEME, 0, 0, 0) != 0) { perror("TRACEME"); _exit(126); }
        raise(SIGSTOP);
        char *newargv[argc + 1];
        newargv[0] = real;
        for (int i = 1; i < argc; i++) newargv[i] = argv[i];
        newargv[argc] = NULL;
        execve(real, newargv, environ);
        perror("execve ld-real");
        _exit(127);
    }

    int status;
    if (waitpid(pid, &status, 0) < 0) { perror("waitpid"); return 126; }
    ptrace(PTRACE_CONT, pid, 0, 0);
    for (;;) {
        if (waitpid(pid, &status, 0) < 0) break;
        if (WIFEXITED(status)) { _exit(WEXITSTATUS(status)); }
        if (WIFSIGNALED(status)) { _exit(128 + WTERMSIG(status)); }
        if (!WIFSTOPPED(status)) break;
        int sig = WSTOPSIG(status);
        if (sig == SIGSYS) {
            siginfo_t si; memset(&si, 0, sizeof(si));
            if (ptrace(PTRACE_GETSIGINFO, pid, 0, &si) == 0) {
                fprintf(stderr, "SIGSYS-SYSCALL=%d arch=0x%lx code=%d\n",
                        (int)si.si_syscall, (unsigned long)si.si_arch, si.si_code);
            } else {
                fprintf(stderr, "SIGSYS (siginfo unavailable)\n");
            }
            fflush(stderr);
            kill(pid, SIGKILL);
            waitpid(pid, &status, 0);
            _exit(99);
        }
        ptrace(PTRACE_CONT, pid, 0, sig == SIGTRAP ? 0 : sig);
    }
    _exit(0);
}
