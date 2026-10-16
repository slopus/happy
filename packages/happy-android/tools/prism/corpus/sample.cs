using System;
namespace Demo {
    /// <summary>Doc</summary>
    public record Point(int X, int Y);
    public static class Program {
        public static async Task Main(string[] args) {
            var s = $"Value: {args.Length,5}";
            var verbatim = @"C:\path";
            Console.WriteLine(s ?? "none"); // done
        }
    }
}
