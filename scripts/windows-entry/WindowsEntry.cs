using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;

static class WindowsEntry
{
#if TRIAL
    const string LauncherName = "KevinLauncherTrial.exe";
    const string RuntimeName = "KevinLauncherTrialRuntime.exe";
#else
    const string LauncherName = "KevinLauncher.exe";
    const string RuntimeName = "KevinLauncherRuntime.exe";
#endif
    const string CloseWindowArgument = "--kevin-close-launcher-window";
    const uint UseShowWindow = 0x00000001;
    const uint UseStdHandles = 0x00000100;
    const uint ExtendedStartupInfoPresent = 0x00080000;
    const uint DuplicateSameAccess = 0x00000002;
    static readonly IntPtr InvalidHandle = new IntPtr(-1);
    static readonly IntPtr HandleListAttribute = new IntPtr(0x00020002);

    [StructLayout(LayoutKind.Sequential)]
    struct StartupInfo
    {
        public uint Size;
        public IntPtr Reserved, Desktop, Title;
        public uint X, Y, Width, Height, Columns, Rows, Fill, Flags;
        public ushort ShowWindow, ReservedLength;
        public IntPtr ReservedBytes, Input, Output, Error;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct StartupInfoEx
    {
        public StartupInfo Startup;
        public IntPtr AttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInformation
    {
        public IntPtr Process, Thread;
        public uint ProcessId, ThreadId;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern uint GetModuleFileNameW(IntPtr module, StringBuilder file, int size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern uint GetSystemWindowsDirectoryW(StringBuilder directory, int size);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetCommandLineW();
    [DllImport("kernel32.dll")]
    static extern void GetStartupInfoW(out StartupInfo startup);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool DuplicateHandle(IntPtr source, IntPtr handle, IntPtr target, out IntPtr duplicate,
        uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value,
        IntPtr size, IntPtr previousValue, IntPtr returnSize);
    [DllImport("kernel32.dll")]
    static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessW(string application, StringBuilder arguments, IntPtr processAttributes,
        IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory,
        ref StartupInfoEx startup, out ProcessInformation process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern void OutputDebugStringW(string message);

    static class LauncherWindowClose
    {
        const uint QueryLimitedInformation = 0x1000;
        const uint Synchronize = 0x100000;
        const uint WaitTimeout = 258;
        const uint CloseMessage = 0x0010;
        // WM_APP + 75, shared with the installed Electron main window.
        const uint SetupCloseMessage = 0x804B;
        // The first Tray in legacy Electron reports clicks to this message window.
        const string TrayHostClass = "Electron_NotifyIconHostWindow";
        const uint TrayCallback = 0x8001;
        const int FirstTrayIcon = 3;
        const int ContextMenuMessage = 0x007B;
        const int InvalidWindowHandle = 1400;
        const long UnixEpochFileTime = 116444736000000000L;

        [StructLayout(LayoutKind.Sequential)]
        struct FileTime { public uint Low, High; }

        delegate bool WindowCallback(IntPtr window, IntPtr context);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern IntPtr OpenProcess(uint access, bool inherit, uint id);
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder path, ref int capacity);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool GetProcessTimes(IntPtr process, out FileTime creation, out FileTime exit,
            out FileTime kernel, out FileTime user);
        [DllImport("user32.dll", SetLastError = true)]
        static extern bool EnumWindows(WindowCallback callback, IntPtr context);
        [DllImport("user32.dll")]
        static extern uint GetWindowThreadProcessId(IntPtr window, out uint id);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern int GetClassNameW(IntPtr window, StringBuilder name, int capacity);
        [DllImport("user32.dll")]
        static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")]
        static extern bool AllowSetForegroundWindow(uint id);
        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        static extern bool PostMessageW(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

        static string ImagePath(string path)
        {
            // Use the image name itself, never PATH, the caller's cwd or a search for matching names.
            if (path.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) path = @"\\" + path.Substring(8);
            else if (path.StartsWith(@"\\?\", StringComparison.Ordinal)) path = path.Substring(4);
            bool drive = path.Length >= 3 && char.IsLetter(path[0]) && path[1] == ':' && path[2] == '\\';
            bool unc = path.StartsWith(@"\\", StringComparison.Ordinal) && !path.StartsWith(@"\\.\", StringComparison.Ordinal);
            var name = path.Substring(path.LastIndexOf('\\') + 1);
            if ((!drive && !unc) || (!string.Equals(name, LauncherName, StringComparison.OrdinalIgnoreCase) &&
                !string.Equals(name, RuntimeName, StringComparison.OrdinalIgnoreCase)))
                throw new ArgumentException("Expected an absolute KevinLauncher executable path");
            return path;
        }

        static void AssertIdentity(IntPtr process, string expected, long expectedCreated)
        {
            var image = new StringBuilder(32768);
            int capacity = image.Capacity;
            if (!QueryFullProcessImageNameW(process, 0, image, ref capacity)) throw new Win32Exception();
            FileTime created, exited, kernel, user;
            if (!GetProcessTimes(process, out created, out exited, out kernel, out user)) throw new Win32Exception();
            long time = (((long)created.High << 32) | created.Low) - UnixEpochFileTime;
            if (time / 10000 != expectedCreated || !string.Equals(ImagePath(image.ToString()), expected, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("The launcher process identity changed");
        }

        static int PostClose(IntPtr process, uint pid, uint message)
        {
            var name = new StringBuilder(128);
            int delivered = 0;
            int failure = 0;
            bool ended = false;
            bool enumerated = EnumWindows((window, context) => {
                uint owner;
                uint thread = GetWindowThreadProcessId(window, out owner);
                if (thread == 0 || owner != pid || GetClassNameW(window, name, name.Capacity) == 0 ||
                    !name.ToString().StartsWith("Chrome_WidgetWin_", StringComparison.Ordinal)) return true;

                uint state = WaitForSingleObject(process, 0);
                if (state != WaitTimeout)
                {
                    ended = state == 0;
                    if (!ended) failure = Marshal.GetLastWin32Error();
                    return false;
                }
                if (GetWindowThreadProcessId(window, out owner) != thread || owner != pid) return true;
                if (PostMessageW(window, message, IntPtr.Zero, IntPtr.Zero)) delivered++;
                else
                {
                    int error = Marshal.GetLastWin32Error();
                    if (error == InvalidWindowHandle) return true;
                    failure = error;
                    return false;
                }
                return true;
            }, IntPtr.Zero);
            if (!enumerated && !ended) throw failure == 0 ? new Win32Exception() : new Win32Exception(failure);
            return delivered;
        }

        static bool StillOwnsWindow(IntPtr process, uint pid, uint thread, IntPtr window)
        {
            uint owner;
            return WaitForSingleObject(process, 0) == WaitTimeout &&
                GetWindowThreadProcessId(window, out owner) == thread && owner == pid;
        }

        static bool InvokeTrayQuit(IntPtr process, uint pid)
        {
            var name = new StringBuilder(128);
            var openedBeforeRequest = new HashSet<IntPtr>();
            IntPtr tray = IntPtr.Zero;
            uint trayThread = 0;
            EnumWindows((window, context) => {
                uint owner;
                uint thread = GetWindowThreadProcessId(window, out owner);
                if (thread == 0 || owner != pid || GetClassNameW(window, name, name.Capacity) == 0) return true;
                if (name.ToString() == TrayHostClass)
                {
                    tray = window;
                    trayThread = thread;
                }
                if (IsWindowVisible(window)) openedBeforeRequest.Add(window);
                return true;
            }, IntPtr.Zero);
            if (tray == IntPtr.Zero || !StillOwnsWindow(process, pid, trayThread, tray)) return false;

            // Grant permission from the foreground installer. The old launcher may already be
            // eligible when the grant fails, so still attempt the addressed tray callback.
            bool canActivate = AllowSetForegroundWindow(pid);
            if (!PostMessageW(tray, TrayCallback, new IntPtr(FirstTrayIcon), new IntPtr(ContextMenuMessage))) return false;
            var quitItem = new AndCondition(
                new PropertyCondition(AutomationElement.ProcessIdProperty, (int)pid),
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.MenuItem),
                new PropertyCondition(AutomationElement.NameProperty, "\u9000\u51fa"));
            var wait = Stopwatch.StartNew();
            do
            {
                uint state = WaitForSingleObject(process, 0);
                if (state == 0) return true;
                if (state != WaitTimeout) throw new Win32Exception();
                var popups = new List<IntPtr>();
                EnumWindows((window, context) => {
                    if (!openedBeforeRequest.Contains(window) && IsWindowVisible(window) &&
                        StillOwnsWindow(process, pid, trayThread, window) &&
                        GetClassNameW(window, name, name.Capacity) > 0 &&
                        name.ToString().StartsWith("Chrome_WidgetWin_", StringComparison.Ordinal)) popups.Add(window);
                    return true;
                }, IntPtr.Zero);
                foreach (var popup in popups)
                {
                    try
                    {
                        if (!StillOwnsWindow(process, pid, trayThread, popup)) continue;
                        var root = AutomationElement.FromHandle(popup);
                        var items = root.FindAll(TreeScope.Descendants, quitItem);
                        object pattern;
                        if (items.Count != 1 || !items[0].Current.IsEnabled ||
                            !items[0].TryGetCurrentPattern(InvokePattern.Pattern, out pattern) ||
                            !StillOwnsWindow(process, pid, trayThread, popup)) continue;
                        ((InvokePattern)pattern).Invoke();
                        return true;
                    }
                    catch (ElementNotAvailableException)
                    {
                        // The menu can disappear as the user switches windows or the launcher closes.
                    }
                }
                Thread.Sleep(50);
            } while (wait.ElapsedMilliseconds < 1500);
            Console.Error.WriteLine(canActivate ? "Launcher tray quit action unavailable" : "Launcher tray could not obtain foreground permission");
            return false;
        }

        public static int Run(string[] args)
        {
            uint id;
            long created;
            if (args.Length != 4 || !uint.TryParse(args[1], NumberStyles.None, CultureInfo.InvariantCulture, out id) || id == 0 ||
                !long.TryParse(args[2], NumberStyles.None, CultureInfo.InvariantCulture, out created) || created <= 0)
                throw new ArgumentException("Expected a launcher PID, creation time and executable path");
            string expected = ImagePath(args[3]);
            uint message = expected.EndsWith("\\" + RuntimeName, StringComparison.OrdinalIgnoreCase)
                ? SetupCloseMessage : CloseMessage;
            IntPtr process = OpenProcess(QueryLimitedInformation | Synchronize, false, id);
            if (process == IntPtr.Zero) throw new Win32Exception();
            try
            {
                AssertIdentity(process, expected, created);
                int sent = message == CloseMessage && InvokeTrayQuit(process, id)
                    ? 1 : PostClose(process, id, message);
                Console.WriteLine(sent.ToString(CultureInfo.InvariantCulture));
                return 0;
            }
            finally { CloseHandle(process); }
        }
    }

    // Let Windows inherit only duplicates of the caller's standard streams.
    sealed class ChildStartup : IDisposable
    {
        readonly List<IntPtr> handles = new List<IntPtr>(3);
        IntPtr handleArray;
        bool attributesInitialized;
        public StartupInfoEx Info;

        public ChildStartup()
        {
            try
            {
                StartupInfo current;
                GetStartupInfoW(out current);
                Info.Startup.Flags = current.Flags & UseShowWindow;
                Info.Startup.ShowWindow = current.ShowWindow;
                Info.Startup.Input = DuplicateStream(-10);
                Info.Startup.Output = DuplicateStream(-11);
                Info.Startup.Error = DuplicateStream(-12);
                Info.Startup.Size = (uint)Marshal.SizeOf(typeof(StartupInfo));
                if (handles.Count == 0) return;

                Info.Startup.Size = (uint)Marshal.SizeOf(typeof(StartupInfoEx));
                Info.Startup.Flags |= UseStdHandles;
                IntPtr size = IntPtr.Zero;
                InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
                if (size == IntPtr.Zero) throw new Win32Exception();
                Info.AttributeList = Marshal.AllocHGlobal(size);
                if (!InitializeProcThreadAttributeList(Info.AttributeList, 1, 0, ref size)) throw new Win32Exception();
                attributesInitialized = true;
                int bytes = handles.Count * IntPtr.Size;
                handleArray = Marshal.AllocHGlobal(bytes);
                for (int index = 0; index < handles.Count; index++)
                    Marshal.WriteIntPtr(handleArray, index * IntPtr.Size, handles[index]);
                if (!UpdateProcThreadAttribute(Info.AttributeList, 0, HandleListAttribute, handleArray,
                    new IntPtr(bytes), IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();
            }
            catch
            {
                Dispose();
                throw;
            }
        }

        public bool InheritHandles { get { return handles.Count != 0; } }

        IntPtr DuplicateStream(int kind)
        {
            IntPtr source = GetStdHandle(kind);
            if (source == IntPtr.Zero || source == InvalidHandle) return IntPtr.Zero;
            IntPtr current = GetCurrentProcess();
            IntPtr duplicate;
            if (!DuplicateHandle(current, source, current, out duplicate, 0, true, DuplicateSameAccess))
                throw new Win32Exception();
            handles.Add(duplicate);
            return duplicate;
        }

        public void Dispose()
        {
            if (attributesInitialized) DeleteProcThreadAttributeList(Info.AttributeList);
            Marshal.FreeHGlobal(Info.AttributeList);
            Marshal.FreeHGlobal(handleArray);
            foreach (IntPtr handle in handles) CloseHandle(handle);
        }
    }

    static string RuntimePath()
    {
        var module = new StringBuilder(32768);
        uint length = GetModuleFileNameW(IntPtr.Zero, module, module.Capacity);
        if (length == 0 || length >= module.Capacity) throw new Win32Exception();
        string path = module.ToString();
        return path.Substring(0, path.LastIndexOf('\\') + 1) + RuntimeName;
    }

    static string ArgumentTail()
    {
        string original = Marshal.PtrToStringUni(GetCommandLineW());
        bool quoted = false;
        int index = 0;
        for (; index < original.Length; index++)
        {
            char next = original[index];
            if (next == '"') quoted = !quoted;
            else if (!quoted && (next == ' ' || next == '\t')) break;
        }
        return original.Substring(index);
    }

    static int StartRuntime()
    {
        string runtime = RuntimePath();
        var commandLine = new StringBuilder("\"" + runtime + "\"" + ArgumentTail());
        // The elevated user entry always starts the Electron GUI.
        Environment.SetEnvironmentVariable("ELECTRON_RUN_AS_NODE", null);
        // Privileged system helpers must resolve against the actual Windows directory.
        var windows = new StringBuilder(32768);
        uint length = GetSystemWindowsDirectoryW(windows, windows.Capacity);
        if (length == 0 || length >= windows.Capacity) throw new Win32Exception();
        Environment.SetEnvironmentVariable("SystemRoot", windows.ToString());
        Environment.SetEnvironmentVariable("windir", windows.ToString());
#if TRIAL
        // An elevated installed trial must not search the caller's writable directory.
        string workingDirectory = runtime.Substring(0, runtime.LastIndexOf('\\') + 1);
#else
        string workingDirectory = null;
#endif
        ProcessInformation process;
        using (var startup = new ChildStartup())
        {
            uint flags = startup.InheritHandles ? ExtendedStartupInfoPresent : 0;
            if (!CreateProcessW(runtime, commandLine, IntPtr.Zero, IntPtr.Zero, startup.InheritHandles, flags,
                IntPtr.Zero, workingDirectory, ref startup.Info, out process)) throw new Win32Exception();
        }

        CloseHandle(process.Thread);
        try
        {
            if (WaitForSingleObject(process.Process, uint.MaxValue) != 0) throw new Win32Exception();
            uint code;
            if (!GetExitCodeProcess(process.Process, out code)) throw new Win32Exception();
            return unchecked((int)code);
        }
        finally { CloseHandle(process.Process); }
    }

    [MTAThread]
    static int Main(string[] args)
    {
        bool closeWindow = args.Length > 0 && args[0] == CloseWindowArgument;
        try { return closeWindow ? LauncherWindowClose.Run(args) : StartRuntime(); }
        catch (Exception error)
        {
            var nativeError = error as Win32Exception;
            int code = nativeError == null ? 1 : nativeError.NativeErrorCode;
            string action = closeWindow ? "close the launcher window" : "start " + RuntimeName;
            string message = "KevinLauncher could not " + action + " (" + code + "): " + error.Message;
            OutputDebugStringW(message);
            try { Console.Error.WriteLine(message); }
            catch (System.IO.IOException) { }
            return code == 0 ? 1 : code;
        }
    }
}
