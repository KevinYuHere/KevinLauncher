using System;
using System.Text;

static class WindowsEntryRuntimeFixture
{
    static void Write(string value)
    {
        Console.WriteLine(Convert.ToBase64String(Encoding.UTF8.GetBytes(value ?? "")));
    }

    static int Main(string[] arguments)
    {
        foreach (string argument in arguments) Write(argument);
        Write(Environment.CurrentDirectory);
        Write(Environment.GetEnvironmentVariable("PORTABLE_EXECUTABLE_FILE"));
        Write(Environment.GetEnvironmentVariable("ELECTRON_RUN_AS_NODE"));
        Write(Console.ReadLine());
        Write(Environment.GetEnvironmentVariable("SystemRoot"));
        Write(Environment.GetEnvironmentVariable("windir"));
        Console.Error.WriteLine("fixture stderr");
        return unchecked((int)0x80000003u);
    }
}
