// zlib and Brotli's decoder, for decompressing responses where Apple's
// Compression framework isn't there (Linux tests).
#include <zlib.h>
#include <brotli/decode.h>
