#include <stdio.h>

enum {
    SOURCE_NODE_MAX = 256,
    SERIALIZED_NODE_DEPTH_MAX = 257,
    CONTROL_POINT_MAX = 262656,
    TRIANGLE_MAX = 524288,
};

int main(void)
{
    if (SERIALIZED_NODE_DEPTH_MAX != SOURCE_NODE_MAX + 1 || CONTROL_POINT_MAX <= 0 || TRIANGLE_MAX <= 0) {
        return 1;
    }
    puts("s8-validator-contract: resource and depth constants accepted");
    return 0;
}
