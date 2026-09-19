#include <stdio.h>
#include <unistd.h>
#include <sys/wait.h>

int main(int argc, char **argv)
{
    pid_t child;
    int status;
    if (argc != 2) return 2;
    child = fork();
    if (child < 0) return 1;
    if (child == 0) {
        execl(argv[1], argv[1],
            "--address-space-bytes", "268435456",
            "--file-bytes", "1048576",
            "--timeout-ms", "1000",
            "--stdout-bytes", "1024",
            "--stderr-bytes", "1024",
            "--max-children", "0",
            "--", "/bin/printf", "runner-contract-ok", (char *)NULL);
        _exit(127);
    }
    if (waitpid(child, &status, 0) < 0 || !WIFEXITED(status) || WEXITSTATUS(status) != 0) return 1;
    puts("s8-process-runner-contract: Linux execution contract configured");
    return 0;
}
