#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stdio.h>

int main(int argc, char *argv[]) {
  if (argc != 3) {
    fprintf(stderr, "usage: vigil-atomic-swap LEFT RIGHT\n");
    return 64;
  }
  if (renameatx_np(AT_FDCWD, argv[1], AT_FDCWD, argv[2], RENAME_SWAP) != 0) {
    fprintf(stderr, "renameatx_np(RENAME_SWAP) failed: %s\n", strerror(errno));
    return 1;
  }
  return 0;
}
