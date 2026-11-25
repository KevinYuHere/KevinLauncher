using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class WindowsEntryCloseFixture
{
    const string LegacyClass = "Chrome_WidgetWin_1";
    const string OtherClass = "KevinLauncherFixture_Other";
    const string TrayClass = "Electron_NotifyIconHostWindow";
    static readonly WindowProcedure Handler = HandleWindow;

    delegate IntPtr WindowProcedure(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct WindowClass
    {
        public uint Style;
        public IntPtr Procedure;
        public int ExtraClassBytes, ExtraWindowBytes;
        public IntPtr Instance, Icon, Cursor, Background;
        public string Menu, Name;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct Message
    {
        public IntPtr Window;
        public uint Type;
        public IntPtr WParam, LParam;
        public uint Time;
        public int X, Y;
        public uint Private;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr GetModuleHandleW(string name);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern ushort RegisterClassW(ref WindowClass info);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateWindowExW(uint exStyle, string className, string title, uint style, int x, int y,
        int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetClassNameW(IntPtr window, StringBuilder name, int capacity);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr DefWindowProcW(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern int GetMessageW(out Message message, IntPtr window, uint min, uint max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr DispatchMessageW(ref Message message);
    [DllImport("user32.dll")]
    static extern bool DestroyWindow(IntPtr window);
    [DllImport("user32.dll")]
    static extern void PostQuitMessage(int exitCode);

    static IntPtr HandleWindow(IntPtr window, uint message, IntPtr wParam, IntPtr lParam)
    {
        if (message == 0x8001 && wParam == new IntPtr(3) && lParam == new IntPtr(0x007B))
        {
            var tray = new StringBuilder(128);
            GetClassNameW(window, tray, tray.Capacity);
            if (tray.ToString() == TrayClass)
            {
                Console.WriteLine("tray:quit");
                Thread.Sleep(250);
                Console.WriteLine("tray:saved");
                PostQuitMessage(0);
            }
            return IntPtr.Zero;
        }
        if (message != 0x0010 && message != 0x804B) return DefWindowProcW(window, message, wParam, lParam);
        var name = new StringBuilder(128);
        GetClassNameW(window, name, name.Capacity);
        DestroyWindow(window);
        Console.WriteLine((message == 0x0010 ? "close:" : "setup:") + name);
        return IntPtr.Zero;
    }

    static void CreateHiddenWindow(string name)
    {
        var info = new WindowClass { Instance = GetModuleHandleW(null), Name = name,
            Procedure = Marshal.GetFunctionPointerForDelegate(Handler) };
        if (RegisterClassW(ref info) == 0) throw new Win32Exception();
        if (CreateWindowExW(0, name, "KevinLauncher test window", 0, 0, 0, 320, 200,
            IntPtr.Zero, IntPtr.Zero, info.Instance, IntPtr.Zero) == IntPtr.Zero) throw new Win32Exception();
    }

    static int Main(string[] args)
    {
        CreateHiddenWindow(LegacyClass);
        CreateHiddenWindow(OtherClass);
        if (args.Length == 1 && args[0] == "--legacy-tray") CreateHiddenWindow(TrayClass);
        using (var process = Process.GetCurrentProcess())
        {
            long created = (process.StartTime.ToUniversalTime().ToFileTimeUtc() - 116444736000000000L) / 10000;
            Console.WriteLine("ready:" + created);
        }
        Message message;
        int result;
        while ((result = GetMessageW(out message, IntPtr.Zero, 0, 0)) > 0) DispatchMessageW(ref message);
        return result == 0 ? 0 : 1;
    }
}
