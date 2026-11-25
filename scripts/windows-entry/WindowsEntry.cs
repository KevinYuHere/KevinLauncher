using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

static class WindowsEntry
{
    const string RuntimeName = "KevinLauncherRuntime.exe";
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
        ProcessInformation process;
        using (var startup = new ChildStartup())
        {
            uint flags = startup.InheritHandles ? ExtendedStartupInfoPresent : 0;
            if (!CreateProcessW(runtime, commandLine, IntPtr.Zero, IntPtr.Zero, startup.InheritHandles, flags,
                IntPtr.Zero, null, ref startup.Info, out process)) throw new Win32Exception();
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

    static int Main()
    {
        try { return StartRuntime(); }
        catch (Exception error)
        {
            var nativeError = error as Win32Exception;
            int code = nativeError == null ? 1 : nativeError.NativeErrorCode;
            string message = "KevinLauncher could not start " + RuntimeName + " (" + code + "): " + error.Message;
            OutputDebugStringW(message);
            try { Console.Error.WriteLine(message); }
            catch (System.IO.IOException) { }
            return code == 0 ? 1 : code;
        }
    }
}
