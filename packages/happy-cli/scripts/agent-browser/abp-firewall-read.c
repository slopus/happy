/* Root-owned 4750 root:abp-session. Read-only, no arguments, no caller environment. */
#include <unistd.h>
#include <sys/wait.h>
#include <stdio.h>
#include <stdlib.h>
int main(int argc, char **argv) {
    (void)argv;
    if (argc != 1 || geteuid() != 0) return 125;
    const char *programs[] = {"/usr/sbin/iptables-save", "/usr/sbin/ip6tables-save"};
    if (chdir("/") || setgid(0) || setuid(0)) return 125;
    for (int i = 0; i < 2; i++) {
        pid_t pid = fork();
        if (pid < 0) return 125;
        if (pid == 0) {
            char *const args[] = {(char *)programs[i], "-t", "filter", NULL};
            char *const env[] = {"PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL=C", NULL};
            for (int fd = 3; fd < 65536; fd++) close(fd);
            execve(programs[i], args, env);
            _exit(125);
        }
        int status;
        if (waitpid(pid, &status, 0) < 0 || !WIFEXITED(status) || WEXITSTATUS(status)) return 125;
    }
    return 0;
}
