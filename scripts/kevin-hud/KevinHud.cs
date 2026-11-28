// Kevin HUD read-only Windows helper.
//
// It is intentionally a single, small .NET Framework console process. The main
// process starts it only while FPS/GPU/network metrics or game-window geometry
// are needed, writes one short command per line, and closes it on stop. The
// helper never opens the target process, injects code, hooks rendering, or
// reads game memory. Its inputs are verified numeric PIDs and fixed capability
// flags; commands are limited to `sample`, `rect`, `targets`, `quit`.
//
// Frame capture uses the system's ETW providers for IDXGISwapChain::Present
// and D3D9 Present. Only events emitted by the Runtime-verified PID set and
// only the Present START events are counted; the PID that actually presents is
// selected dynamically and its submitted-present rate is displayed as FPS.
// It is not a count of displayed or synthesized frames.
// This normally requires the elevated launcher (ETW real-time sessions need
// administrative rights); when unavailable the helper keeps the other metrics
// working and reports FPS as null so the HUD can show "--".

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class Program
{
    private const int MaxTargetPids = 64;

    private static int Main(string[] args)
    {
        bool wantFps = false;
        bool wantGpu = false;
        bool wantNet = false;
        bool wantWindow = false;
        bool selfTest = false;
        int rootPid = 0;
        List<int> targetPids = new List<int>();

        for (int i = 0; i < args.Length; i++)
        {
            string arg = args[i];
            if (arg == "--fps") wantFps = true;
            else if (arg == "--gpu") wantGpu = true;
            else if (arg == "--net") wantNet = true;
            else if (arg == "--window") wantWindow = true;
            else if (arg == "--selftest") selfTest = true;
            else if (arg == "--pid")
            {
                if (++i >= args.Length || !TryParsePidList(args[i], targetPids))
                {
                    WriteError("invalid_pid");
                    return 2;
                }
            }
            else if (arg == "--root")
            {
                if (++i >= args.Length || !TryParsePid(args[i], out rootPid))
                {
                    WriteError("invalid_root");
                    return 2;
                }
            }
            else
            {
                WriteError("unknown_argument");
                return 2;
            }
        }

        if (selfTest) return RunSelectionSelfTest();

        WindowsNative.EnablePhysicalDpiAwareness();

        FpsCapture fps = null;
        GpuSampler gpu = null;
        string fpsError = null;
        string gpuError = null;

        if (wantFps)
        {
            if (targetPids.Count == 0)
            {
                fpsError = "missing_pid";
            }
            else
            {
                try
                {
                    fps = new FpsCapture(targetPids, rootPid);
                    fps.Start();
                }
                catch (Exception exception)
                {
                    if (fps != null) fps.Dispose();
                    fps = null;
                    fpsError = DescribeError("etw", exception);
                }
            }
        }

        if (wantGpu)
        {
            try
            {
                gpu = new GpuSampler();
                gpuError = gpu.Error;
            }
            catch (Exception exception)
            {
                if (gpu != null) gpu.Dispose();
                gpu = null;
                gpuError = DescribeError("gpu", exception);
            }
        }

        try
        {
            WriteReady(targetPids, rootPid, wantFps, fps, fpsError, wantGpu, gpu, gpuError, wantNet, wantWindow);

            string line;
            while ((line = Console.ReadLine()) != null)
            {
                line = line.Trim();
                if (line.Length == 0) continue;
                if (line == "quit") break;
                if (line == "sample")
                {
                    WriteSample(fps, gpu, wantNet, targetPids, rootPid);
                }
                else if (line == "rect")
                {
                    WriteRect(wantWindow && targetPids.Count > 0
                        ? WindowsNative.FindTargetWindow(
                            targetPids, fps != null ? fps.SelectedPid : 0, rootPid)
                        : null);
                }
                else if (line == "targets" || line.StartsWith("targets ", StringComparison.Ordinal))
                {
                    List<int> nextPids = new List<int>();
                    int nextRoot = 0;
                    string command = line.Length > 7 ? line.Substring(7).Trim() : string.Empty;
                    string[] parts = command.Length == 0
                        ? new string[0]
                        : command.Split(new char[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                    if (parts.Length > 2 ||
                        (parts.Length >= 1 && !TryParsePidList(parts[0], nextPids)) ||
                        (parts.Length == 2 && !TryParsePid(parts[1], out nextRoot)))
                    {
                        WriteError("invalid_targets");
                    }
                    else
                    {
                        targetPids = nextPids;
                        rootPid = nextRoot;
                        if (fps != null) fps.SetTargets(targetPids.ToArray(), rootPid);
                        WriteTargets(targetPids.Count);
                    }
                }
                else
                {
                    WriteError("unsupported_command");
                }
                Console.Out.Flush();
            }
        }
        finally
        {
            if (fps != null) fps.Dispose();
            if (gpu != null) gpu.Dispose();
        }
        return 0;
    }

    private static bool TryParsePid(string text, out int pid)
    {
        pid = 0;
        if (!int.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out pid)) return false;
        return pid > 0 && pid <= 0x7FFFFFFF;
    }

    private static bool TryParsePidList(string text, List<int> into)
    {
        if (text == null || text.Length == 0) return false;
        string[] parts = text.Split(',');
        if (parts.Length == 0) return false;
        for (int i = 0; i < parts.Length; i++)
        {
            int pid;
            if (!TryParsePid(parts[i], out pid)) return false;
            if (!into.Contains(pid))
            {
                if (into.Count >= MaxTargetPids) return false;
                into.Add(pid);
            }
        }
        return true;
    }

    private static void WriteReady(List<int> targetPids, int rootPid, bool wantFps,
        FpsCapture fps, string fpsError, bool wantGpu, GpuSampler gpu, string gpuError,
        bool wantNet, bool wantWindow)
    {
        StringBuilder json = new StringBuilder(320);
        json.Append("{\"ok\":true,\"ready\":true,\"pid\":");
        json.Append((targetPids.Count > 0 ? targetPids[0] : 0).ToString(CultureInfo.InvariantCulture));
        json.Append(",\"pids\":[");
        for (int i = 0; i < targetPids.Count; i++)
        {
            if (i > 0) json.Append(',');
            json.Append(targetPids[i].ToString(CultureInfo.InvariantCulture));
        }
        json.Append("],\"rootPid\":");
        json.Append(rootPid.ToString(CultureInfo.InvariantCulture));
        json.Append(",\"fps\":");
        json.Append(fps != null && fps.Ready ? "true" : "false");
        json.Append(",\"fpsError\":");
        AppendNullableString(json, fpsError ?? (fps != null ? fps.Error : null));
        json.Append(",\"gpu\":");
        json.Append(gpu != null && gpu.Ready ? "true" : "false");
        json.Append(",\"gpuError\":");
        AppendNullableString(json, gpuError ?? (gpu != null ? gpu.Error : null));
        json.Append(",\"net\":");
        json.Append(wantNet ? "true" : "false");
        json.Append(",\"window\":");
        json.Append(wantWindow ? "true" : "false");
        json.Append('}');
        WriteLine(json.ToString());
    }

    private static void WriteTargets(int count)
    {
        StringBuilder json = new StringBuilder(64);
        json.Append("{\"ok\":true,\"targets\":true,\"pids\":");
        json.Append(count.ToString(CultureInfo.InvariantCulture));
        json.Append('}');
        WriteLine(json.ToString());
    }

    private static void WriteSample(FpsCapture fps, GpuSampler gpu, bool wantNet,
        List<int> targetPids, int rootPid)
    {
        double? frameRate = null;
        int? presentPid = null;
        double? gpuPercent = null;
        long received = 0;
        long sent = 0;

        if (fps != null)
        {
            try
            {
                PresentReading reading = fps.Sample();
                if (reading != null)
                {
                    frameRate = reading.Fps;
                    presentPid = reading.Pid;
                }
            }
            catch
            {
                frameRate = null;
                presentPid = null;
            }
        }
        if (gpu != null)
        {
            int gpuPid = presentPid.HasValue ? presentPid.Value : 0;
            if (gpuPid <= 0 && targetPids.Count > 0)
            {
                WindowsNative.WindowTarget? fallback =
                    WindowsNative.FindTargetWindow(targetPids, 0, rootPid);
                if (fallback.HasValue) gpuPid = fallback.Value.Pid;
            }
            if (gpuPid > 0)
            {
                try { gpuPercent = gpu.Sample(gpuPid); }
                catch { gpuPercent = null; }
            }
        }
        bool hasNetwork = wantNet && NetworkSampler.TrySample(out received, out sent);
        if (!hasNetwork)
        {
            received = 0;
            sent = 0;
        }

        StringBuilder json = new StringBuilder(180);
        json.Append("{\"ok\":true,\"fps\":");
        AppendNullableNumber(json, frameRate);
        json.Append(",\"fpsPid\":");
        if (presentPid.HasValue) json.Append(presentPid.Value.ToString(CultureInfo.InvariantCulture));
        else json.Append("null");
        json.Append(",\"gpu\":");
        AppendNullableNumber(json, gpuPercent);
        json.Append(",\"rx\":");
        if (hasNetwork) json.Append(received.ToString(CultureInfo.InvariantCulture));
        else json.Append("null");
        json.Append(",\"tx\":");
        if (hasNetwork) json.Append(sent.ToString(CultureInfo.InvariantCulture));
        else json.Append("null");
        json.Append('}');
        WriteLine(json.ToString());
    }

    private static void WriteRect(WindowsNative.WindowTarget? target)
    {
        StringBuilder json = new StringBuilder(110);
        json.Append("{\"ok\":true,\"rect\":");
        if (!target.HasValue)
        {
            json.Append("null");
        }
        else
        {
            WindowsNative.ScreenRect value = target.Value.Rect;
            json.Append("{\"x\":").Append(value.X.ToString(CultureInfo.InvariantCulture));
            json.Append(",\"y\":").Append(value.Y.ToString(CultureInfo.InvariantCulture));
            json.Append(",\"width\":").Append(value.Width.ToString(CultureInfo.InvariantCulture));
            json.Append(",\"height\":").Append(value.Height.ToString(CultureInfo.InvariantCulture));
            json.Append('}');
        }
        json.Append('}');
        WriteLine(json.ToString());
    }

    private static void WriteError(string error)
    {
        WriteLine("{\"ok\":false,\"error\":\"" + error + "\"}");
    }

    private static void WriteLine(string json)
    {
        Console.Out.WriteLine(json);
        Console.Out.Flush();
    }

    private static void AppendNullableNumber(StringBuilder json, double? value)
    {
        if (!value.HasValue || double.IsNaN(value.Value) || double.IsInfinity(value.Value))
        {
            json.Append("null");
            return;
        }
        json.Append(value.Value.ToString("0.#", CultureInfo.InvariantCulture));
    }

    private static void AppendNullableString(StringBuilder json, string value)
    {
        if (value == null)
        {
            json.Append("null");
            return;
        }
        string safe = value.Length > 160 ? value.Substring(0, 160) : value;
        json.Append('"');
        foreach (char character in safe)
        {
            if (character == '\\' || character == '"') json.Append('\\').Append(character);
            else if (character < 0x20 || character > 0x7E) json.Append('?');
            else json.Append(character);
        }
        json.Append('"');
    }

    /// <summary>
    /// Deterministic checks for the submitted-Present target selection. This
    /// never starts ETW or opens a process, so it can run in an unelevated
    /// session and in CI. It complements, but does not replace, a real ETW
    /// trace under the elevated launcher.
    /// </summary>
    private static int RunSelectionSelfTest()
    {
        int checks = 0;
        int failures = 0;
        long tick = System.Diagnostics.Stopwatch.Frequency;
        long now = 10 * tick;
        PresentTracker tracker = new PresentTracker();
        List<int> pids = new List<int>();
        pids.Add(4101);
        pids.Add(4102);
        tracker.SetTargets(pids.ToArray(), 4101);

        PresentReading reading = tracker.SampleAt(now);
        Check(reading == null, "first sample unavailable", ref checks, ref failures);

        tracker.Observe(4101, PresentSource.DxgiPresent);
        tracker.Observe(4101, PresentSource.DxgiPresent);
        now += tick;
        reading = tracker.SampleAt(now);
        CheckReading(reading, 4101, 2, "root-only fallback", ref checks, ref failures);

        // DXGI 42 and 178 are two views of the same submission. The per-PID
        // value must be the maximum source delta, not their sum.
        for (int i = 0; i < 30; i++)
        {
            tracker.Observe(4102, PresentSource.DxgiPresent);
            tracker.Observe(4102, PresentSource.DxgiSwapChainPresent);
        }
        now += tick;
        reading = tracker.SampleAt(now);
        CheckReading(reading, 4102, 30, "child handoff without double count", ref checks, ref failures);

        // A presenting root must not displace a presenting non-root child.
        for (int i = 0; i < 60; i++) tracker.Observe(4101, PresentSource.DxgiPresent);
        for (int i = 0; i < 30; i++) tracker.Observe(4102, PresentSource.DxgiPresent);
        now += tick;
        reading = tracker.SampleAt(now);
        CheckReading(reading, 4102, 30, "non-root preferred over shell root", ref checks, ref failures);

        // D3D9 Present is a separate source and still selects the child.
        for (int i = 0; i < 144; i++) tracker.Observe(4102, PresentSource.D3d9Present);
        now += tick;
        reading = tracker.SampleAt(now);
        CheckReading(reading, 4102, 144, "D3D9 Present source", ref checks, ref failures);

        // A known presenter that stops rendering reports a real zero rate.
        now += tick;
        reading = tracker.SampleAt(now);
        CheckReading(reading, 4102, 0, "real zero while not presenting", ref checks, ref failures);

        // A changed target set needs a fresh interval; the next real sample is
        // then attributed to the new verified PID.
        tracker.SetTargets(new int[] { 4102 }, 4102);
        reading = tracker.SampleAt(now);
        Check(reading == null, "target change starts a fresh interval", ref checks, ref failures);
        for (int i = 0; i < 20; i++) tracker.Observe(4102, PresentSource.DxgiPresent);
        now += tick;
        reading = tracker.SampleAt(now);
        CheckReading(reading, 4102, 20, "updated target set", ref checks, ref failures);

        // No Present events at all must stay unavailable rather than become 0.
        tracker.SetTargets(new int[] { 4103 }, 0);
        reading = tracker.SampleAt(now);
        Check(reading == null, "new target baseline", ref checks, ref failures);
        now += tick;
        reading = tracker.SampleAt(now);
        Check(reading == null, "no Present events remains unavailable", ref checks, ref failures);

        StringBuilder json = new StringBuilder(140);
        json.Append("{\"ok\":");
        json.Append(failures == 0 ? "true" : "false");
        json.Append(",\"selftest\":\"present-selection\",\"checks\":");
        json.Append(checks.ToString(CultureInfo.InvariantCulture));
        json.Append(",\"failures\":");
        json.Append(failures.ToString(CultureInfo.InvariantCulture));
        json.Append('}');
        WriteLine(json.ToString());
        return failures == 0 ? 0 : 1;
    }

    private static void CheckReading(PresentReading reading, int pid, double fps,
        string label, ref int checks, ref int failures)
    {
        bool ok = reading != null && reading.Pid.HasValue && reading.Pid.Value == pid &&
            reading.Fps.HasValue && Math.Abs(reading.Fps.Value - fps) <= 0.05;
        Check(ok, label, ref checks, ref failures);
    }

    private static void Check(bool ok, string label, ref int checks, ref int failures)
    {
        checks++;
        if (ok) return;
        failures++;
        // Keep diagnostics ASCII and bounded; stdout is the line protocol.
        Console.Error.WriteLine("selftest failed: " + label);
    }

    private static string DescribeError(string prefix, Exception exception)
    {
        if (exception is FpsCaptureException && ((FpsCaptureException)exception).Code != 0)
            return prefix + "_" + ((FpsCaptureException)exception).Code.ToString(CultureInfo.InvariantCulture);
        return prefix + "_exception";
    }

    private static string ErrorName(int code)
    {
        if (code == 5) return "access_denied";
        if (code == 87) return "invalid_parameter";
        if (code == 183) return "already_exists";
        return "native_" + code.ToString(CultureInfo.InvariantCulture);
    }

    internal sealed class FpsCaptureException : Exception
    {
        internal readonly int Code;

        internal FpsCaptureException(string message, int code) : base(message)
        {
            Code = code;
        }
    }

    /// <summary>
    /// The submitted-present sources this helper accepts. Keep these exact
    /// provider/event/opcode triples:
    /// - Microsoft-Windows-DXGI Present: id 42, Start (1)
    /// - Microsoft-Windows-DXGI IDXGISwapChain_Present: id 178, Start (1)
    /// - Microsoft-Windows-D3D9 Present: id 1, Start (1)
    /// These are the IDs/opcodes reported by this Windows installation's
    /// Microsoft-Windows-DXGI and Microsoft-Windows-D3D9 provider manifests.
    /// Stop events are never counted.
    /// </summary>
    internal enum PresentSource
    {
        DxgiPresent,
        DxgiSwapChainPresent,
        D3d9Present
    }

    internal sealed class PresentReading
    {
        internal double? Fps;
        internal int? Pid;

        internal PresentReading(double value, int pid)
        {
            Fps = value;
            Pid = pid;
        }
    }

    internal sealed class PresentCounters
    {
        internal long DxgiPresent;
        internal long DxgiSwapChainPresent;
        internal long D3d9Present;
        internal long LastDxgiPresent;
        internal long LastDxgiSwapChainPresent;
        internal long LastD3d9Present;
        internal bool HasPresent;
    }

    /// <summary>
    /// Counts submitted Present starts per verified candidate PID and selects
    /// the PID that actually presents. The Runtime-verified root is used only
    /// as a fallback: when any non-root candidate presents, a root shell (for
    /// example a launcher that wraps a game) must not win just because it also
    /// paints its own window. If no candidate has presented yet the reading is
    /// null, which lets the HUD show an unavailable value instead of a
    /// fabricated zero.
    ///
    /// DXGI can emit both the public Present event (42) and the internal
    /// IDXGISwapChain_Present event (178) for one submission, so the per-PID
    /// value is the maximum of the three source deltas rather than their sum.
    /// </summary>
    internal sealed class PresentTracker
    {
        private const double MinimumIntervalSeconds = 0.2;
        private const double MaximumFps = 10000;

        private readonly object gate = new object();
        private readonly Dictionary<int, PresentCounters> counters =
            new Dictionary<int, PresentCounters>();

        private int rootPid;
        private int selectedPid;
        private long lastSampleTimestamp;

        internal int SelectedPid
        {
            get
            {
                lock (gate) { return selectedPid; }
            }
        }

        internal void SetTargets(int[] pids, int rootPid)
        {
            lock (gate)
            {
                Dictionary<int, PresentCounters> next = new Dictionary<int, PresentCounters>();
                if (pids != null)
                {
                    for (int i = 0; i < pids.Length; i++)
                    {
                        int pid = pids[i];
                        if (pid <= 0 || next.ContainsKey(pid)) continue;
                        PresentCounters value;
                        if (!counters.TryGetValue(pid, out value)) value = new PresentCounters();
                        next[pid] = value;
                    }
                }
                counters.Clear();
                foreach (KeyValuePair<int, PresentCounters> pair in next) counters[pair.Key] = pair.Value;
                this.rootPid = counters.ContainsKey(rootPid) ? rootPid : 0;
                if (selectedPid != 0 && !counters.ContainsKey(selectedPid)) selectedPid = 0;
                // A changed verified set needs a fresh interval. Returning null
                // for one sample is honest and prevents a stale PID's rate from
                // being attributed to the newly discovered game process.
                lastSampleTimestamp = 0;
                SetBaselineLocked();
            }
        }

        internal void Observe(int pid, PresentSource source)
        {
            lock (gate)
            {
                PresentCounters value;
                if (!counters.TryGetValue(pid, out value)) return;
                value.HasPresent = true;
                if (source == PresentSource.DxgiPresent) value.DxgiPresent++;
                else if (source == PresentSource.DxgiSwapChainPresent) value.DxgiSwapChainPresent++;
                else if (source == PresentSource.D3d9Present) value.D3d9Present++;
            }
        }

        internal PresentReading Sample()
        {
            return SampleAt(System.Diagnostics.Stopwatch.GetTimestamp());
        }

        internal PresentReading SampleAt(long now)
        {
            lock (gate)
            {
                if (counters.Count == 0) return null;
                if (lastSampleTimestamp == 0)
                {
                    lastSampleTimestamp = now;
                    SetBaselineLocked();
                    return null;
                }
                double elapsed = (now - lastSampleTimestamp) /
                    (double)System.Diagnostics.Stopwatch.Frequency;
                if (!(elapsed >= MinimumIntervalSeconds)) return null;

                int bestPid = 0;
                long bestFrames = 0;
                bool bestIsNonRoot = false;
                foreach (KeyValuePair<int, PresentCounters> pair in counters)
                {
                    PresentCounters value = pair.Value;
                    long dxgi = Delta(value.DxgiPresent, value.LastDxgiPresent);
                    long dxgiSwapChain = Delta(
                        value.DxgiSwapChainPresent, value.LastDxgiSwapChainPresent);
                    long d3d9 = Delta(value.D3d9Present, value.LastD3d9Present);
                    long frames = Math.Max(dxgi, Math.Max(dxgiSwapChain, d3d9));
                    value.LastDxgiPresent = value.DxgiPresent;
                    value.LastDxgiSwapChainPresent = value.DxgiSwapChainPresent;
                    value.LastD3d9Present = value.D3d9Present;

                    if (frames <= 0) continue;
                    bool nonRoot = this.rootPid <= 0 || pair.Key != this.rootPid;
                    bool better = false;
                    if (bestPid == 0) better = true;
                    else if (nonRoot != bestIsNonRoot) better = nonRoot;
                    else if (frames > bestFrames) better = true;
                    else if (frames == bestFrames && pair.Key == selectedPid) better = true;
                    if (!better) continue;
                    bestPid = pair.Key;
                    bestFrames = frames;
                    bestIsNonRoot = nonRoot;
                }

                if (bestPid == 0)
                {
                    if (selectedPid != 0 &&
                        counters.ContainsKey(selectedPid) &&
                        counters[selectedPid].HasPresent)
                    {
                        bestPid = selectedPid;
                    }
                    else
                    {
                        bestPid = FirstPresentPidLocked();
                    }
                }

                lastSampleTimestamp = now;
                if (bestPid == 0) return null;
                selectedPid = bestPid;

                double rate = bestFrames / elapsed;
                if (!(rate >= 0) || double.IsInfinity(rate)) return null;
                if (rate > MaximumFps) rate = MaximumFps;
                return new PresentReading(Math.Round(rate, 1, MidpointRounding.AwayFromZero), bestPid);
            }
        }

        private static long Delta(long current, long previous)
        {
            return current >= previous ? current - previous : 0;
        }

        private void SetBaselineLocked()
        {
            foreach (PresentCounters value in counters.Values)
            {
                value.LastDxgiPresent = value.DxgiPresent;
                value.LastDxgiSwapChainPresent = value.DxgiSwapChainPresent;
                value.LastD3d9Present = value.D3d9Present;
            }
        }

        private int FirstPresentPidLocked()
        {
            int rootFallback = 0;
            foreach (KeyValuePair<int, PresentCounters> pair in counters)
            {
                if (!pair.Value.HasPresent) continue;
                if (this.rootPid > 0 && pair.Key == this.rootPid)
                {
                    if (rootFallback == 0) rootFallback = pair.Key;
                    continue;
                }
                return pair.Key;
            }
            return rootFallback;
        }
    }

    /// <summary>
    /// Real-time ETW consumer for submitted-present events of the verified PID
    /// set. It never opens the game process; the target list is supplied by the
    /// launcher's Runtime observation and can be updated while the session
    /// stays alive.
    /// </summary>
    internal sealed class FpsCapture : IDisposable
    {
        private static readonly Guid DxgiProvider = new Guid("CA11C036-0102-4A2D-A6AD-F03CFED5D3C9");
        private static readonly Guid D3D9Provider = new Guid("783ACA0A-790E-4D7F-8451-AA850511C6B9");

        private const uint EventTraceRealTimeMode = 0x00000100;
        private const uint ProcessTraceModeEventRecord = 0x10000000;
        private const uint ProcessTraceModeRealTime = 0x00000100;
        private const uint WnodeFlagTracedGuid = 0x00020000;
        private const uint EventControlCodeEnableProvider = 1;
        private const int EventTraceControlStop = 1;
        private const ushort EventTraceTypeStart = 1;

        private readonly string sessionName;
        private readonly EventRecordCallback eventRecordCallback;
        private readonly PresentTracker tracker = new PresentTracker();

        private IntPtr properties = IntPtr.Zero;
        private ulong sessionHandle;
        private ulong consumerHandle = ulong.MaxValue;
        private EVENT_TRACE_LOGFILEW logFile;
        private Thread processingThread;
        private volatile bool stopping;
        private volatile bool fatal;
        private bool ready;

        private string error;

        internal FpsCapture(List<int> targetPids, int rootPid)
        {
            tracker.SetTargets(targetPids != null ? targetPids.ToArray() : new int[0], rootPid);
            // Keep a stable session name across target-set updates. A restarted
            // helper with the same launch anchor can stop a session orphaned by
            // an abrupt helper exit.
            int anchor = targetPids != null && targetPids.Count > 0 ? targetPids[0] : 0;
            sessionName = "KevinLauncher-HUD-" + anchor.ToString(CultureInfo.InvariantCulture);
            eventRecordCallback = OnEventRecord;
        }

        internal bool Ready { get { return ready; } }
        internal string Error { get { return error; } }
        internal int SelectedPid { get { return tracker.SelectedPid; } }

        internal void SetTargets(int[] pids, int rootPid)
        {
            tracker.SetTargets(pids, rootPid);
        }

        internal void Start()
        {
            try
            {
                StartSession();
                EnableProviders();
                OpenConsumer();
                processingThread = new Thread(ProcessLoop);
                processingThread.IsBackground = true;
                processingThread.Name = "KevinHudEtw";
                processingThread.Start();
                ready = true;
            }
            catch
            {
                ready = false;
                Dispose();
                throw;
            }
        }

        private void StartSession()
        {
            int size = Marshal.SizeOf(typeof(EVENT_TRACE_PROPERTIES));
            int nameBytes = (sessionName.Length + 1) * 2;
            int total = size + nameBytes;

            for (int attempt = 0; attempt < 2; attempt++)
            {
                properties = Marshal.AllocHGlobal(total);
                byte[] zero = new byte[total];
                Marshal.Copy(zero, 0, properties, total);

                EVENT_TRACE_PROPERTIES value = new EVENT_TRACE_PROPERTIES();
                value.Wnode.BufferSize = (uint)total;
                value.Wnode.Flags = WnodeFlagTracedGuid;
                value.Wnode.ClientContext = 1;
                value.BufferSize = 64;
                value.MinimumBuffers = 4;
                value.MaximumBuffers = 16;
                value.LogFileMode = EventTraceRealTimeMode;
                value.FlushTimer = 1;
                value.LoggerNameOffset = (uint)size;
                Marshal.StructureToPtr(value, properties, false);

                ulong handle;
                int startStatus = WindowsApi.StartTraceW(out handle, sessionName, properties);
                if (startStatus == 0)
                {
                    sessionHandle = handle;
                    return;
                }

                Marshal.FreeHGlobal(properties);
                properties = IntPtr.Zero;

                // A previous helper with a reused PID may have left a session
                // behind. Stop only our exact session name, then retry once.
                if (startStatus == 183 && attempt == 0)
                {
                    StopOrphanSession(size, nameBytes);
                    continue;
                }
                error = "etw_" + ErrorName(startStatus);
                throw new FpsCaptureException("ETW StartTrace failed", startStatus);
            }
            error = "etw_start_failed";
            throw new FpsCaptureException("ETW StartTrace failed", 0);
        }

        private void StopOrphanSession(int size, int nameBytes)
        {
            IntPtr orphan = Marshal.AllocHGlobal(size + nameBytes);
            byte[] zero = new byte[size + nameBytes];
            Marshal.Copy(zero, 0, orphan, size + nameBytes);
            EVENT_TRACE_PROPERTIES value = new EVENT_TRACE_PROPERTIES();
            value.Wnode.BufferSize = (uint)(size + nameBytes);
            value.Wnode.Flags = WnodeFlagTracedGuid;
            value.Wnode.ClientContext = 1;
            value.LoggerNameOffset = (uint)size;
            Marshal.StructureToPtr(value, orphan, false);
            WindowsApi.ControlTraceW(0, sessionName, orphan, EventTraceControlStop);
            Marshal.FreeHGlobal(orphan);
        }

        private void EnableProviders()
        {
            int enabled = 0;
            int lastStatus = 0;

            Guid dxgi = DxgiProvider;
            if (EnableProvider(ref dxgi, ref lastStatus)) enabled++;
            Guid d3d9 = D3D9Provider;
            if (EnableProvider(ref d3d9, ref lastStatus)) enabled++;

            if (enabled == 0)
            {
                error = "etw_provider_" + ErrorName(lastStatus);
                throw new FpsCaptureException("ETW providers unavailable", lastStatus);
            }
        }

        private bool EnableProvider(ref Guid provider, ref int lastStatus)
        {
            // Enable every keyword. Microsoft documents MatchAnyKeyword=0 as
            // "all keywords" only for modern providers; 0xFFFFFFFFFFFFFFFF is
            // valid for both modern and legacy providers and also covers
            // Present events whose keyword is 0. The fallback keeps the
            // version-0 parameter shape for older Windows builds.
            ENABLE_TRACE_PARAMETERS parameters = new ENABLE_TRACE_PARAMETERS();
            parameters.Version = 2;
            int status = WindowsApi.EnableTraceEx2(
                sessionHandle, ref provider, EventControlCodeEnableProvider, 5,
                ulong.MaxValue, 0, 0, ref parameters);
            if (status == 0) return true;

            parameters = new ENABLE_TRACE_PARAMETERS();
            parameters.Version = 0;
            status = WindowsApi.EnableTraceEx2(
                sessionHandle, ref provider, EventControlCodeEnableProvider, 5,
                ulong.MaxValue, 0, 0, ref parameters);
            lastStatus = status;
            return status == 0;
        }

        private void OpenConsumer()
        {
            logFile = new EVENT_TRACE_LOGFILEW();
            logFile.LoggerName = sessionName;
            logFile.LogFileMode = ProcessTraceModeEventRecord | ProcessTraceModeRealTime;
            logFile.EventCallback = eventRecordCallback;
            logFile.LogfileHeader = new TRACE_LOGFILE_HEADER();
            logFile.LogfileHeader.TimeZone.StandardName = string.Empty;
            logFile.LogfileHeader.TimeZone.DaylightName = string.Empty;
            logFile.LogfileHeader.TimeZone.StandardDate = new ushort[8];
            logFile.LogfileHeader.TimeZone.DaylightDate = new ushort[8];

            consumerHandle = WindowsApi.OpenTraceW(ref logFile);
            if (consumerHandle == ulong.MaxValue)
            {
                int code = Marshal.GetLastWin32Error();
                error = "etw_open_" + ErrorName(code);
                throw new FpsCaptureException("ETW OpenTrace failed", code);
            }
        }

        private void ProcessLoop()
        {
            try
            {
                int status = WindowsApi.ProcessTrace(
                    new ulong[] { consumerHandle }, 1, IntPtr.Zero, IntPtr.Zero);
                if (!stopping && status != 0 && status != 1223)
                {
                    fatal = true;
                    error = "etw_process_" + ErrorName(status);
                }
            }
            catch
            {
                if (!stopping) fatal = true;
            }
        }

        private void OnEventRecord(IntPtr raw)
        {
            try
            {
                if (stopping || raw == IntPtr.Zero) return;
                EVENT_HEADER header = (EVENT_HEADER)Marshal.PtrToStructure(raw, typeof(EVENT_HEADER));
                if (header.Opcode != EventTraceTypeStart) return;
                if (header.ProviderId == DxgiProvider)
                {
                    if (header.Id == 42) tracker.Observe(header.ProcessId, PresentSource.DxgiPresent);
                    else if (header.Id == 178) tracker.Observe(
                        header.ProcessId, PresentSource.DxgiSwapChainPresent);
                }
                else if (header.ProviderId == D3D9Provider && header.Id == 1)
                {
                    tracker.Observe(header.ProcessId, PresentSource.D3d9Present);
                }
            }
            catch
            {
                // A malformed/foreign event must never take down the consumer.
            }
        }

        internal PresentReading Sample()
        {
            if (!ready || fatal) return null;
            return tracker.Sample();
        }

        public void Dispose()
        {
            if (stopping) return;
            stopping = true;
            ready = false;
            try
            {
                if (sessionHandle != 0)
                {
                    WindowsApi.ControlTraceW(sessionHandle, sessionName, properties, EventTraceControlStop);
                }
            }
            catch { }
            try
            {
                if (consumerHandle != ulong.MaxValue) WindowsApi.CloseTrace(consumerHandle);
            }
            catch { }
            consumerHandle = ulong.MaxValue;
            if (processingThread != null && processingThread.IsAlive)
            {
                try { processingThread.Join(2500); }
                catch { }
            }
            processingThread = null;
            if (properties != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(properties);
                properties = IntPtr.Zero;
            }
            sessionHandle = 0;
        }
    }

    /// <summary>
    /// Reads the system "GPU Engine" PDH counter (English path, so the OS locale
    /// does not matter) and reports the busiest engine for the target process.
    /// The value is capped at 100%.
    /// </summary>
    internal sealed class GpuSampler : IDisposable
    {
        private const uint PdhFormatDouble = 0x00000200;
        private const uint PdhMoreData = 0x800007D2;
        private const uint PdhValidData = 0;
        private const uint PdhNewData = 1;
        private const int MaxBufferBytes = 1024 * 1024;

        private IntPtr query;
        private IntPtr counter;
        private bool ready;
        private string error;

        internal GpuSampler()
        {
            int status = WindowsApi.PdhOpenQueryW(null, IntPtr.Zero, out query);
            if (status != 0)
            {
                error = "pdh_open_" + status.ToString(CultureInfo.InvariantCulture);
                return;
            }
            status = WindowsApi.PdhAddEnglishCounterW(
                query, @"\GPU Engine(*)\Utilization Percentage", IntPtr.Zero, out counter);
            if (status != 0)
            {
                error = "pdh_counter_" + status.ToString(CultureInfo.InvariantCulture);
                WindowsApi.PdhCloseQuery(query);
                query = IntPtr.Zero;
                return;
            }
            status = WindowsApi.PdhCollectQueryData(query);
            if (status != 0)
            {
                error = "pdh_collect_" + status.ToString(CultureInfo.InvariantCulture);
                Dispose();
                return;
            }
            ready = true;
        }

        internal bool Ready { get { return ready; } }
        internal string Error { get { return error; } }

        internal double? Sample(int targetPid)
        {
            if (!ready || query == IntPtr.Zero || targetPid <= 0) return null;
            int collectStatus = WindowsApi.PdhCollectQueryData(query);
            if (collectStatus != 0) return null;

            uint size = 0;
            uint count = 0;
            uint status = WindowsApi.PdhGetFormattedCounterArrayW(
                counter, PdhFormatDouble, out size, out count, IntPtr.Zero);
            if (status != PdhMoreData || size == 0 || size > MaxBufferBytes) return null;

            IntPtr buffer = Marshal.AllocHGlobal((int)size);
            try
            {
                status = WindowsApi.PdhGetFormattedCounterArrayW(
                    counter, PdhFormatDouble, out size, out count, buffer);
                if (status != 0 || count == 0) return null;

                int itemSize = Marshal.SizeOf(typeof(PDH_FMT_COUNTERVALUE_ITEM));
                bool sawTarget = false;
                double best = -1;
                for (uint index = 0; index < count; index++)
                {
                    IntPtr itemPointer = new IntPtr(buffer.ToInt64() + index * (long)itemSize);
                    PDH_FMT_COUNTERVALUE_ITEM item =
                        (PDH_FMT_COUNTERVALUE_ITEM)Marshal.PtrToStructure(
                            itemPointer, typeof(PDH_FMT_COUNTERVALUE_ITEM));
                    if (item.FmtValue.CStatus != PdhValidData && item.FmtValue.CStatus != PdhNewData) continue;
                    if (!IsTargetInstance(item.Name, targetPid)) continue;
                    double value = item.FmtValue.DoubleValue;
                    if (double.IsNaN(value) || double.IsInfinity(value)) continue;
                    sawTarget = true;
                    if (value < 0) value = 0;
                    if (value > 100) value = 100;
                    if (value > best) best = value;
                }
                if (!sawTarget || best < 0) return null;
                return Math.Round(best, 1, MidpointRounding.AwayFromZero);
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }

        private static bool IsTargetInstance(string instance, int targetPid)
        {
            if (string.IsNullOrEmpty(instance)) return false;
            string prefix = "pid_" + targetPid.ToString(CultureInfo.InvariantCulture) + "_";
            return instance.StartsWith(prefix, StringComparison.OrdinalIgnoreCase);
        }

        public void Dispose()
        {
            ready = false;
            if (query != IntPtr.Zero)
            {
                WindowsApi.PdhCloseQuery(query);
                query = IntPtr.Zero;
                counter = IntPtr.Zero;
            }
        }
    }

    /// <summary>
    /// Aggregates the OS interface byte counters. Loopback adapters are
    /// excluded, so the HUD's rate is real network traffic, not local traffic.
    /// The caller computes the rate from the deltas in bytes over elapsed time.
    /// </summary>
    internal static class NetworkSampler
    {
        private const uint IfTypeSoftwareLoopback = 24;
        private const uint IfOperStatusUp = 1;
        private const int IfMaxStringSize = 256;
        private const int IfMaxPhysicalAddressLength = 32;

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct MIB_IF_ROW2
        {
            internal ulong InterfaceLuid;
            internal uint InterfaceIndex;
            internal Guid InterfaceGuid;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = IfMaxStringSize + 1)]
            internal string Alias;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = IfMaxStringSize + 1)]
            internal string Description;
            internal uint PhysicalAddressLength;
            [MarshalAs(UnmanagedType.ByValArray, SizeConst = IfMaxPhysicalAddressLength)]
            internal byte[] PhysicalAddress;
            [MarshalAs(UnmanagedType.ByValArray, SizeConst = IfMaxPhysicalAddressLength)]
            internal byte[] PermanentPhysicalAddress;
            internal uint Mtu;
            internal uint Type;
            internal uint TunnelType;
            internal uint MediaType;
            internal uint PhysicalMediumType;
            internal uint AccessType;
            internal uint DirectionType;
            internal byte InterfaceAndOperStatusFlags;
            internal uint OperStatus;
            internal uint AdminStatus;
            internal uint MediaConnectState;
            internal Guid NetworkGuid;
            internal uint ConnectionType;
            internal ulong TransmitLinkSpeed;
            internal ulong ReceiveLinkSpeed;
            internal ulong InOctets;
            internal ulong InUcastPkts;
            internal ulong InNUcastPkts;
            internal ulong InDiscards;
            internal ulong InErrors;
            internal ulong InUnknownProtos;
            internal ulong InUcastOctets;
            internal ulong InMulticastOctets;
            internal ulong InBroadcastOctets;
            internal ulong OutOctets;
            internal ulong OutUcastPkts;
            internal ulong OutNUcastPkts;
            internal ulong OutDiscards;
            internal ulong OutErrors;
            internal ulong OutUcastOctets;
            internal ulong OutMulticastOctets;
            internal ulong OutBroadcastOctets;
            internal ulong OutQLen;
        }

        [DllImport("iphlpapi.dll")]
        private static extern uint GetIfTable2(out IntPtr table);

        [DllImport("iphlpapi.dll")]
        private static extern void FreeMibTable(IntPtr table);

        internal static bool TrySample(out long received, out long sent)
        {
            received = 0;
            sent = 0;
            IntPtr table;
            if (GetIfTable2(out table) != 0 || table == IntPtr.Zero) return false;
            try
            {
                int count = Marshal.ReadInt32(table);
                int rowSize = Marshal.SizeOf(typeof(MIB_IF_ROW2));
                // MIB_IF_TABLE2 has a 4-byte count followed by 8-byte-aligned rows.
                int rowOffset = 8;
                bool found = false;
                for (int index = 0; index < count; index++)
                {
                    IntPtr rowPointer = new IntPtr(table.ToInt64() + rowOffset + (long)index * rowSize);
                    MIB_IF_ROW2 row = (MIB_IF_ROW2)Marshal.PtrToStructure(rowPointer, typeof(MIB_IF_ROW2));
                    if (row.OperStatus != IfOperStatusUp) continue;
                    if (row.Type == IfTypeSoftwareLoopback) continue;
                    received = AddBytes(received, ToSafeBytes(row.InOctets));
                    sent = AddBytes(sent, ToSafeBytes(row.OutOctets));
                    found = true;
                }
                return found;
            }
            finally
            {
                FreeMibTable(table);
            }
        }

        private static long ToSafeBytes(ulong value)
        {
            return value > (ulong)long.MaxValue ? long.MaxValue : (long)value;
        }

        private static long AddBytes(long total, long value)
        {
            if (value <= 0) return total;
            if (total > long.MaxValue - value) return long.MaxValue;
            return total + value;
        }
    }

    /// <summary>
    /// Read-only Win32 window geometry. EnumWindows only exposes public window
    /// metadata; the target process is never opened or inspected.
    /// </summary>
    internal static class WindowsNative
    {
        internal const int GwlExStyle = -20;
        internal const long WsExToolWindow = 0x00000080L;
        private const uint DwmwaExtendedFrameBounds = 9;

        internal struct ScreenRect
        {
            internal int X;
            internal int Y;
            internal int Width;
            internal int Height;
        }

        internal struct WindowTarget
        {
            internal int Pid;
            internal ScreenRect Rect;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct RECT
        {
            internal int Left;
            internal int Top;
            internal int Right;
            internal int Bottom;
        }

        [UnmanagedFunctionPointer(CallingConvention.Winapi)]
        private delegate bool EnumWindowsProc(IntPtr window, IntPtr lParam);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool IsWindowVisible(IntPtr window);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool IsIconic(IntPtr window);

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetWindowRect(IntPtr window, out RECT rect);

        [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
        private static extern IntPtr GetWindowLongPtr(IntPtr window, int index);

        [DllImport("dwmapi.dll")]
        private static extern int DwmGetWindowAttribute(
            IntPtr window, uint attribute, out RECT rect, int size);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetProcessDPIAware();

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetProcessDpiAwarenessContext(IntPtr context);

        internal static void EnablePhysicalDpiAwareness()
        {
            try
            {
                // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4.
                if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return;
            }
            catch (EntryPointNotFoundException) { }
            catch (DllNotFoundException) { }
            try { SetProcessDPIAware(); }
            catch { }
        }

        /// <summary>
        /// Largest visible, non-tool top-level window owned by one of the
        /// verified candidate PIDs. The currently presenting PID is preferred
        /// when it has a window; otherwise a non-root candidate wins over the
        /// Runtime root so a visible launcher shell is not mistaken for the
        /// game screen. Only public Win32/DWM metadata is read.
        /// </summary>
        internal static WindowTarget? FindTargetWindow(
            IList<int> targetPids, int preferredPid, int rootPid)
        {
            if (targetPids == null || targetPids.Count == 0) return null;
            WindowTarget? preferred = null;
            long preferredArea = -1;
            WindowTarget? nonRoot = null;
            long nonRootArea = -1;
            WindowTarget? root = null;
            long rootArea = -1;

            EnumWindowsProc callback = delegate(IntPtr window, IntPtr lParam)
            {
                try
                {
                    uint rawPid;
                    GetWindowThreadProcessId(window, out rawPid);
                    int pid = unchecked((int)rawPid);
                    if (!ContainsPid(targetPids, pid)) return true;
                    if (!IsWindowVisible(window) || IsIconic(window)) return true;

                    long style = GetWindowLongPtr(window, GwlExStyle).ToInt64();
                    if ((style & WsExToolWindow) != 0) return true;

                    RECT rect;
                    if (!TryVisibleBounds(window, out rect)) return true;
                    long width = (long)rect.Right - rect.Left;
                    long height = (long)rect.Bottom - rect.Top;
                    if (width < 32 || height < 32) return true;
                    if (width > 100000 || height > 100000) return true;

                    WindowTarget candidate = new WindowTarget();
                    candidate.Pid = pid;
                    candidate.Rect = new ScreenRect
                    {
                        X = rect.Left,
                        Y = rect.Top,
                        Width = (int)width,
                        Height = (int)height
                    };
                    long area = width * height;
                    if (preferredPid > 0 && pid == preferredPid)
                    {
                        if (area > preferredArea)
                        {
                            preferredArea = area;
                            preferred = candidate;
                        }
                    }
                    else if (rootPid > 0 && pid == rootPid)
                    {
                        if (area > rootArea)
                        {
                            rootArea = area;
                            root = candidate;
                        }
                    }
                    else if (area > nonRootArea)
                    {
                        nonRootArea = area;
                        nonRoot = candidate;
                    }
                }
                catch
                {
                    // Ignore a window that disappears during enumeration.
                }
                return true;
            };
            try { EnumWindows(callback, IntPtr.Zero); }
            catch { return null; }
            GC.KeepAlive(callback);
            if (preferred.HasValue) return preferred;
            if (nonRoot.HasValue) return nonRoot;
            return root;
        }

        private static bool ContainsPid(IList<int> pids, int pid)
        {
            for (int i = 0; i < pids.Count; i++)
            {
                if (pids[i] == pid) return true;
            }
            return false;
        }

        private static bool TryVisibleBounds(IntPtr window, out RECT rect)
        {
            try
            {
                if (DwmGetWindowAttribute(
                        window, DwmwaExtendedFrameBounds, out rect, Marshal.SizeOf(typeof(RECT))) == 0 &&
                    rect.Right > rect.Left && rect.Bottom > rect.Top)
                {
                    return true;
                }
            }
            catch { }
            if (!GetWindowRect(window, out rect)) return false;
            return rect.Right > rect.Left && rect.Bottom > rect.Top;
        }
    }

    // --- ETW / PDH interop -------------------------------------------------
    // Layouts mirror the public Windows SDK structures. All APIs are read-only
    // from this helper's perspective: no process handles are opened.

    [StructLayout(LayoutKind.Sequential)]
    private struct WNODE_HEADER
    {
        internal uint BufferSize;
        internal uint ProviderId;
        internal ulong HistoricalContext;
        internal ulong TimeStamp;
        internal Guid Guid;
        internal uint ClientContext;
        internal uint Flags;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct EVENT_TRACE_PROPERTIES
    {
        internal WNODE_HEADER Wnode;
        internal uint BufferSize;
        internal uint MinimumBuffers;
        internal uint MaximumBuffers;
        internal uint MaximumFileSize;
        internal uint LogFileMode;
        internal uint FlushTimer;
        internal uint EnableFlags;
        internal int AgeLimit;
        internal uint NumberOfBuffers;
        internal uint FreeBuffers;
        internal uint EventsLost;
        internal uint BuffersWritten;
        internal uint LogBuffersLost;
        internal uint RealTimeBuffersLost;
        internal IntPtr LoggerThreadId;
        internal uint LogFileNameOffset;
        internal uint LoggerNameOffset;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode, Size = 0xac)]
    private struct TIME_ZONE_INFORMATION
    {
        internal int Bias;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        internal string StandardName;
        [MarshalAs(UnmanagedType.ByValArray, ArraySubType = UnmanagedType.U2, SizeConst = 8)]
        internal ushort[] StandardDate;
        internal int StandardBias;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        internal string DaylightName;
        [MarshalAs(UnmanagedType.ByValArray, ArraySubType = UnmanagedType.U2, SizeConst = 8)]
        internal ushort[] DaylightDate;
        internal int DaylightBias;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct EVENT_TRACE_HEADER
    {
        internal ushort Size;
        internal ushort FieldTypeFlags;
        internal byte Type;
        internal byte Level;
        internal ushort Version;
        internal int ThreadId;
        internal int ProcessId;
        internal long TimeStamp;
        internal Guid Guid;
        internal uint KernelTime;
        internal uint UserTime;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ETW_BUFFER_CONTEXT
    {
        internal byte ProcessorNumber;
        internal byte Alignment;
        internal ushort LoggerId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct EVENT_TRACE
    {
        internal EVENT_TRACE_HEADER Header;
        internal uint InstanceId;
        internal uint ParentInstanceId;
        internal Guid ParentGuid;
        internal IntPtr MofData;
        internal int MofLength;
        internal ETW_BUFFER_CONTEXT BufferContext;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct TRACE_LOGFILE_HEADER
    {
        internal uint BufferSize;
        internal uint Version;
        internal uint ProviderVersion;
        internal uint NumberOfProcessors;
        internal long EndTime;
        internal uint TimerResolution;
        internal uint MaximumFileSize;
        internal uint LogFileMode;
        internal uint BuffersWritten;
        internal uint StartBuffers;
        internal uint PointerSize;
        internal uint EventsLost;
        internal uint CpuSpeedInMHz;
        internal IntPtr LoggerName;
        internal IntPtr LogFileName;
        internal TIME_ZONE_INFORMATION TimeZone;
        internal long BootTime;
        internal long PerfFreq;
        internal long StartTime;
        internal uint ReservedFlags;
        internal uint BuffersLost;
    }

    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate bool EventTraceBufferCallback(IntPtr logfile);

    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate void EventRecordCallback(IntPtr eventRecord);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct EVENT_TRACE_LOGFILEW
    {
        [MarshalAs(UnmanagedType.LPWStr)]
        internal string LogFileName;
        [MarshalAs(UnmanagedType.LPWStr)]
        internal string LoggerName;
        internal long CurrentTime;
        internal uint BuffersRead;
        internal uint LogFileMode;
        internal EVENT_TRACE CurrentEvent;
        internal TRACE_LOGFILE_HEADER LogfileHeader;
        internal EventTraceBufferCallback BufferCallback;
        internal int BufferSize;
        internal int Filled;
        internal int EventsLost;
        internal EventRecordCallback EventCallback;
        internal int IsKernelTrace;
        internal IntPtr Context;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct EVENT_HEADER
    {
        internal ushort Size;
        internal ushort HeaderType;
        internal ushort Flags;
        internal ushort EventProperty;
        internal int ThreadId;
        internal int ProcessId;
        internal long TimeStamp;
        internal Guid ProviderId;
        internal ushort Id;
        internal byte Version;
        internal byte Channel;
        internal byte Level;
        internal byte Opcode;
        internal ushort Task;
        internal ulong Keyword;
        internal uint KernelTime;
        internal uint UserTime;
        internal Guid ActivityId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ENABLE_TRACE_PARAMETERS
    {
        internal uint Version;
        internal uint EnableProperty;
        internal uint ControlFlags;
        internal Guid SourceId;
        internal IntPtr EnableFilterDesc;
        internal int FilterDescCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PDH_FMT_COUNTERVALUE
    {
        internal uint CStatus;
        internal double DoubleValue;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PDH_FMT_COUNTERVALUE_ITEM
    {
        internal IntPtr NamePointer;
        internal PDH_FMT_COUNTERVALUE FmtValue;

        internal string Name
        {
            get
            {
                if (NamePointer == IntPtr.Zero) return string.Empty;
                try { return Marshal.PtrToStringUni(NamePointer) ?? string.Empty; }
                catch { return string.Empty; }
            }
        }
    }

    private static class WindowsApi
    {
        [DllImport("advapi32.dll", EntryPoint = "StartTraceW", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern int StartTraceW(out ulong sessionHandle, string sessionName, IntPtr properties);

        [DllImport("advapi32.dll", EntryPoint = "ControlTraceW", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern int ControlTraceW(
            ulong sessionHandle, string sessionName, IntPtr properties, int controlCode);

        [DllImport("advapi32.dll", EntryPoint = "EnableTraceEx2", SetLastError = true)]
        internal static extern int EnableTraceEx2(
            ulong traceHandle,
            ref Guid providerId,
            uint controlCode,
            byte level,
            ulong matchAnyKeyword,
            ulong matchAllKeyword,
            int timeout,
            ref ENABLE_TRACE_PARAMETERS enableParameters);

        [DllImport("advapi32.dll", EntryPoint = "OpenTraceW", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern ulong OpenTraceW(ref EVENT_TRACE_LOGFILEW logfile);

        [DllImport("advapi32.dll", EntryPoint = "ProcessTrace", SetLastError = true)]
        internal static extern int ProcessTrace(
            [In] ulong[] handles, uint handleCount, IntPtr startTime, IntPtr endTime);

        [DllImport("advapi32.dll", EntryPoint = "CloseTrace", SetLastError = true)]
        internal static extern int CloseTrace(ulong traceHandle);

        [DllImport("pdh.dll", EntryPoint = "PdhOpenQueryW", CharSet = CharSet.Unicode)]
        internal static extern int PdhOpenQueryW(string dataSource, IntPtr userData, out IntPtr query);

        [DllImport("pdh.dll", EntryPoint = "PdhAddEnglishCounterW", CharSet = CharSet.Unicode)]
        internal static extern int PdhAddEnglishCounterW(
            IntPtr query, string fullCounterPath, IntPtr userData, out IntPtr counter);

        [DllImport("pdh.dll")]
        internal static extern int PdhCollectQueryData(IntPtr query);

        [DllImport("pdh.dll", EntryPoint = "PdhGetFormattedCounterArrayW", CharSet = CharSet.Unicode)]
        internal static extern uint PdhGetFormattedCounterArrayW(
            IntPtr counter, uint format, out uint bufferSize, out uint itemCount, IntPtr buffer);

        [DllImport("pdh.dll")]
        internal static extern int PdhCloseQuery(IntPtr query);
    }
}
