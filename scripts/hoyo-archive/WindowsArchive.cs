// Reads ZIP and 7z with the Windows archive API. The launcher supplies the
// ordered volume paths on stdin. No vendor game launcher or codecs are shipped.
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

[assembly: DefaultDllImportSearchPaths(DllImportSearchPath.System32)]

internal static class WindowsArchive
{
    private const string Library = "archiveint.dll";
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate IntPtr ReadBlock(IntPtr archive, IntPtr user, out IntPtr data);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate long SeekBlock(IntPtr archive, IntPtr user, long offset, int origin);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)] private static extern IntPtr archive_read_new();
    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)] private static extern int archive_read_support_format_zip(IntPtr a);
    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)] private static extern int archive_read_support_format_7zip(IntPtr a);
    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)] private static extern int archive_read_set_callback_data(IntPtr a, IntPtr data);
    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)] private static extern int archive_read_set_read_callback(IntPtr a, ReadBlock read);
    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)] private static extern int archive_read_set_seek_callback(IntPtr a, SeekBlock seek);
    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)] private static extern int archive_read_open1(IntPtr a);
    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)] private static extern int archive_read_next_header(IntPtr a, out IntPtr entry);
    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)] private static extern int archive_read_extract(IntPtr a, IntPtr entry, int options);
    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)] private static extern IntPtr archive_entry_pathname_w(IntPtr entry);
    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)] private static extern IntPtr archive_entry_hardlink_w(IntPtr entry);
    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)] private static extern IntPtr archive_entry_symlink_w(IntPtr entry);
    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)] private static extern IntPtr archive_error_string(IntPtr a);
    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)] private static extern int archive_read_free(IntPtr a);

    private sealed class Volumes : IDisposable
    {
        private readonly List<FileStream> files = new List<FileStream>();
        private readonly List<long> ends = new List<long>();
        private readonly byte[] buffer = new byte[128 * 1024];
        private GCHandle pinned;
        private long position;
        internal Exception Error;

        internal Volumes(IEnumerable<string> paths)
        {
            try
            {
                pinned = GCHandle.Alloc(buffer, GCHandleType.Pinned);
                long end = 0;
                foreach (string path in paths)
                {
                    FileStream file = File.OpenRead(path);
                    files.Add(file);
                    end = checked(end + file.Length);
                    ends.Add(end);
                }
                if (end == 0) throw new InvalidDataException("Empty archive");
            }
            catch { Dispose(); throw; }
        }

        internal IntPtr Read(IntPtr archive, IntPtr user, out IntPtr data)
        {
            data = pinned.AddrOfPinnedObject();
            try
            {
                int index = 0;
                while (index < ends.Count && position >= ends[index]) index++;
                if (index == ends.Count) return IntPtr.Zero;
                FileStream file = files[index];
                file.Position = position - (index == 0 ? 0 : ends[index - 1]);
                int count = file.Read(buffer, 0, buffer.Length);
                if (count == 0) throw new EndOfStreamException("Archive volume changed");
                position += count;
                return new IntPtr(count);
            }
            catch (Exception error) { Error = error; return new IntPtr(-1); }
        }

        internal long Seek(IntPtr archive, IntPtr user, long offset, int origin)
        {
            try
            {
                long basis = origin == 0 ? 0 : origin == 1 ? position : ends[ends.Count - 1];
                long next = checked(basis + offset);
                if (origin < 0 || origin > 2 || next < 0) throw new IOException("Invalid archive offset");
                return position = next;
            }
            catch (Exception error) { Error = error; return -1; }
        }

        public void Dispose()
        {
            foreach (FileStream file in files) file.Dispose();
            if (pinned.IsAllocated) pinned.Free();
        }
    }

    private static void Check(IntPtr archive, int result, Volumes input)
    {
        if (input.Error != null) throw input.Error;
        if (result < 0) throw new InvalidDataException(Marshal.PtrToStringAnsi(archive_error_string(archive)) ?? "Archive error");
    }

    private static void Extract(string[] paths, string destination, bool zipOnly)
    {
        Directory.CreateDirectory(destination);
        Directory.SetCurrentDirectory(destination);
        using (var volumes = new Volumes(paths))
        {
            IntPtr a = archive_read_new();
            if (a == IntPtr.Zero) throw new OutOfMemoryException();
            ReadBlock read = volumes.Read;
            SeekBlock seek = volumes.Seek;
            try
            {
                Check(a, archive_read_support_format_zip(a), volumes);
                if (!zipOnly) Check(a, archive_read_support_format_7zip(a), volumes);
                Check(a, archive_read_set_callback_data(a, new IntPtr(1)), volumes);
                Check(a, archive_read_set_read_callback(a, read), volumes);
                Check(a, archive_read_set_seek_callback(a, seek), volumes);
                Check(a, archive_read_open1(a), volumes);
                IntPtr entry;
                int result;
                while ((result = archive_read_next_header(a, out entry)) != 1)
                {
                    Check(a, result, volumes);
                    string name = Marshal.PtrToStringUni(archive_entry_pathname_w(entry));
                    if (String.IsNullOrEmpty(name) || name.Contains(":") || Path.IsPathRooted(name) ||
                        archive_entry_hardlink_w(entry) != IntPtr.Zero || archive_entry_symlink_w(entry) != IntPtr.Zero)
                        throw new InvalidDataException("Invalid game archive entry: " + name);
                    // Preserve modification times. Reject paths through symlinks, parent
                    // segments and absolute paths. Replace an old hardlink before writing.
                    const int options = 0x0004 | 0x0010 | 0x0100 | 0x0200 | 0x10000;
                    Check(a, archive_read_extract(a, entry, options), volumes);
                }
            }
            finally
            {
                archive_read_free(a);
                GC.KeepAlive(read);
                GC.KeepAlive(seek);
            }
        }
    }

    private static int Main(string[] args)
    {
        try
        {
            Console.InputEncoding = new UTF8Encoding(false);
            Console.OutputEncoding = new UTF8Encoding(false);
            if (args.Length != 2) throw new ArgumentException("Expected mode and destination");
            var files = new List<string>();
            string line;
            while ((line = Console.ReadLine()) != null) files.Add(Path.GetFullPath(line));
            Extract(files.ToArray(), Path.GetFullPath(args[1]), args[0] == "plugin");
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error.GetBaseException().Message); return 1; }
    }
}
