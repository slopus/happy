// zlib and Brotli's decoder, for decompressing responses on Linux, where
// the SDK's zlib module and Apple's Compression framework aren't.
#include <zlib.h>
#include <brotli/decode.h>
