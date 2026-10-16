const std = @import("std");
// comment
pub fn main() !void {
    const stdout = std.io.getStdOut().writer();
    var i: u32 = 0;
    while (i < 10) : (i += 1) {
        try stdout.print("{d}\n", .{i * 0x2});
    }
}
