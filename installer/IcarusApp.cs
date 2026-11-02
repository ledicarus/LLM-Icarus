// LLM Icarus - native window for the app.
//
// A small Windows program (no console window) that:
//   1. starts the LLM Icarus server in the background if it isn't running,
//   2. shows the app in its own window using Microsoft's WebView2 (the same engine as Edge, already
//      part of Windows 10/11), with its own taskbar identity and icon so it can be pinned,
//   3. when the window is closed, asks whether to keep running in the background (the window hides to an icon in the
//      notification area next to the clock; the server stays up so other programs, such as Claude Code, can still send
//      prompts) or to quit (which stops the server again, but only if this program started it).
//
// Written for the C# 5 compiler that ships with Windows (.NET Framework 4.x), so no newer syntax.
//
// Command line:  "LLM Icarus.exe" [--root <folder>]     (--root = the folder containing server\, runtime\ ...;
//                                                         defaults to the folder this .exe is in)
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Win32;

namespace LLMIcarus
{
    static class Program
    {
        [DllImport("shell32.dll")]
        static extern void SetCurrentProcessExplicitAppUserModelID([MarshalAs(UnmanagedType.LPWStr)] string appId);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern IntPtr FindWindow(string className, string title);
        [DllImport("user32.dll")]
        static extern bool ShowWindow(IntPtr hWnd, int cmd);
        [DllImport("user32.dll")]
        static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")]
        static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern uint RegisterWindowMessage(string name);
        [DllImport("user32.dll")]
        static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

        // A second copy of the program sends this message to the first one, which then shows its window again
        // (it may be hidden in the notification area).
        internal static readonly uint WM_ShowApp = RegisterWindowMessage("LLMIcarus.ShowApp");

        // The server port: PORT in the environment, else 3210. A copy on another port (for testing) is its own instance.
        internal static int PortFromEnvironment()
        {
            string p = Environment.GetEnvironmentVariable("PORT");
            int parsed;
            return (p != null && int.TryParse(p, out parsed)) ? parsed : 3210;
        }

        internal static string TitleFor(int port)
        {
            return port == 3210 ? "LLM Icarus" : "LLM Icarus (port " + port + ")";
        }

        // The folder that holds server\index.js. Normally that is the folder this .exe is in (installed copy).
        // When run from a source checkout the .exe sits in installer\out, so look up through the parent folders too.
        // This keeps a taskbar pin or double-click working without any command-line arguments.
        static string FindRoot(string start)
        {
            string dir = start;
            for (int i = 0; i < 4 && dir != null; i++)
            {
                if (File.Exists(Path.Combine(dir, "server", "index.js"))) return dir;
                DirectoryInfo parent = Directory.GetParent(dir);
                dir = parent != null ? parent.FullName : null;
            }
            return start;
        }

        [STAThread]
        static void Main(string[] args)
        {
            // Taskbar identity: pinning this window pins THIS program (not a browser).
            SetCurrentProcessExplicitAppUserModelID("LLMIcarus.App");

            int port = PortFromEnvironment();
            bool first;
            using (var mutex = new Mutex(true, port == 3210 ? "LLMIcarus.SingleInstance" : "LLMIcarus.SingleInstance." + port, out first))
            {
                if (!first)
                {
                    // already open (maybe hidden in the notification area): ask that copy to show its window
                    IntPtr h = FindWindow(null, TitleFor(port));
                    if (h != IntPtr.Zero)
                    {
                        PostMessage(h, WM_ShowApp, IntPtr.Zero, IntPtr.Zero);
                        if (IsWindowVisible(h)) { ShowWindow(h, 9); SetForegroundWindow(h); }
                    }
                    return;
                }
                string root = FindRoot(AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\'));
                for (int i = 0; i < args.Length - 1; i++)
                    if (args[i] == "--root") root = Path.GetFullPath(args[i + 1]).TrimEnd('\\');

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new MainForm(root));
            }
        }
    }

    // The small panel that appears above the icon in the notification area while the mouse is over it: the same LED bars as
    // the performance sidebar, with the part used by LLM Icarus itself glowing on top. It never takes the keyboard focus.
    class PerfPopup : Form
    {
        class BarInfo
        {
            public string Label;
            public Color Color;
            public bool Rainbow;      // CPU: green at the bottom, red at the top
            public bool Warm;         // temperature: amber to red
            public double? Total;     // 0..100, null = not available
            public double Mine;       // the part LLM Icarus uses
            public string Text = "–";
            public string MineText = "";
        }

        readonly BarInfo[] bars = new BarInfo[]
        {
            new BarInfo { Label = "CPU", Color = Color.FromArgb(47, 224, 90), Rainbow = true },
            new BarInfo { Label = "Clock", Color = Color.FromArgb(255, 59, 48) },
            new BarInfo { Label = "Temp", Color = Color.FromArgb(255, 165, 31), Warm = true },
            new BarInfo { Label = "RAM", Color = Color.FromArgb(37, 211, 196) },
            new BarInfo { Label = "GPU", Color = Color.FromArgb(58, 141, 255) },
            new BarInfo { Label = "VRAM", Color = Color.FromArgb(160, 112, 255) },
        };
        bool haveMe;
        readonly System.Windows.Forms.Timer pulse = new System.Windows.Forms.Timer();

        public PerfPopup()
        {
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            StartPosition = FormStartPosition.Manual;
            BackColor = Color.FromArgb(23, 23, 27);
            ClientSize = new Size(286, 262);
            DoubleBuffered = true;
            pulse.Interval = 140;
            pulse.Tick += delegate { if (Visible) Invalidate(); };
            VisibleChanged += delegate { pulse.Enabled = Visible; };
        }

        protected override bool ShowWithoutActivation { get { return true; } }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= 0x08000000 | 0x00000080 | 0x00000008; // no activate, tool window (no taskbar button), topmost
                return cp;
            }
        }

        static object Get(System.Collections.Generic.Dictionary<string, object> d, string key)
        {
            object v;
            return d != null && d.TryGetValue(key, out v) ? v : null;
        }

        static double? Num(object o)
        {
            if (o == null) return null;
            try { return Convert.ToDouble(o, System.Globalization.CultureInfo.InvariantCulture); }
            catch { return null; }
        }

        // d = the parsed answer of /api/sysmon
        public void SetData(System.Collections.Generic.Dictionary<string, object> d)
        {
            var g = Get(d, "gpu") as System.Collections.Generic.Dictionary<string, object>;
            var me = Get(d, "me") as System.Collections.Generic.Dictionary<string, object>;
            haveMe = me != null;
            double? cpu = Num(Get(d, "cpu")), clock = Num(Get(d, "clockGHz")), baseGhz = Num(Get(d, "baseGHz")), temp = Num(Get(d, "tempC"));
            double? ramUsed = Num(Get(d, "ramUsedGB")), ramTotal = Num(Get(d, "ramTotalGB"));
            double? gpu = Num(Get(g, "util")), vUsed = Num(Get(g, "memUsedMB")), vTotal = Num(Get(g, "memTotalMB"));
            double meCpu = Num(Get(me, "cpu")) ?? 0, meRam = Num(Get(me, "ramGB")) ?? 0, meGpu = Num(Get(me, "gpu")) ?? 0, meVram = Num(Get(me, "vramMB")) ?? 0;

            Set(0, cpu, cpu.HasValue ? cpu.Value.ToString("0.0") + "%" : "", meCpu);
            Set(1, clock.HasValue && baseGhz.HasValue && baseGhz.Value > 0 ? clock.Value / (baseGhz.Value * 1.5) * 100 : (double?)null, clock.HasValue ? clock.Value.ToString("0.0") + "G" : "", 0);
            Set(2, temp, temp.HasValue ? Math.Round(temp.Value) + "°" : "", 0);
            double? ramPct = ramUsed.HasValue && ramTotal.HasValue && ramTotal.Value > 0 ? ramUsed.Value / ramTotal.Value * 100 : (double?)null;
            Set(3, ramPct, ramPct.HasValue ? Math.Round(ramPct.Value) + "%" : "", ramTotal.HasValue && ramTotal.Value > 0 ? meRam / ramTotal.Value * 100 : 0);
            Set(4, gpu, gpu.HasValue ? Math.Round(gpu.Value) + "%" : "", meGpu);
            double? vPct = vUsed.HasValue && vTotal.HasValue && vTotal.Value > 0 ? vUsed.Value / vTotal.Value * 100 : (double?)null;
            Set(5, vPct, vPct.HasValue ? Math.Round(vPct.Value) + "%" : "", vTotal.HasValue && vTotal.Value > 0 ? meVram / vTotal.Value * 100 : 0);
            Invalidate();
        }

        void Set(int i, double? total, string text, double mine)
        {
            BarInfo b = bars[i];
            b.Total = total.HasValue ? (double?)Math.Max(0, Math.Min(100, total.Value)) : null;
            b.Mine = b.Total.HasValue && haveMe ? Math.Min(b.Total.Value, Math.Max(0, mine)) : 0;
            b.Text = b.Total.HasValue ? text : "–";
            b.MineText = b.Mine > 0.4 ? "▲" + Math.Round(b.Mine) + "%" : "";
        }

        static Color Blend(Color a, Color b, double t)
        {
            return Color.FromArgb((int)(a.R + (b.R - a.R) * t), (int)(a.G + (b.G - a.G) * t), (int)(a.B + (b.B - a.B) * t));
        }

        static Color Stops(double[] at, Color[] colors, double x)
        {
            for (int i = 1; i < at.Length; i++)
                if (x <= at[i]) return Blend(colors[i - 1], colors[i], (x - at[i - 1]) / (at[i] - at[i - 1]));
            return colors[colors.Length - 1];
        }

        Color SegmentColor(BarInfo b, double x)
        {
            if (b.Rainbow)
                return Stops(new double[] { 0, .38, .62, .82, 1 },
                    new Color[] { Color.FromArgb(34, 224, 74), Color.FromArgb(127, 220, 43), Color.FromArgb(230, 213, 42), Color.FromArgb(255, 138, 31), Color.FromArgb(255, 59, 48) }, x);
            if (b.Warm)
                return Stops(new double[] { 0, .6, 1 }, new Color[] { Color.FromArgb(255, 178, 31), Color.FromArgb(255, 165, 31), Color.FromArgb(255, 90, 31) }, x);
            return b.Color;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
            using (var border = new Pen(Color.FromArgb(60, 62, 70))) g.DrawRectangle(border, 0, 0, Width - 1, Height - 1);
            using (var f = new Font("Segoe UI", 8f))
            using (var gray = new SolidBrush(Color.FromArgb(138, 143, 153)))
                g.DrawString("PERFORMANCE", f, gray, 14, 8);

            const int colW = 38, gap = 6, top = 50, barH = 128, step = 8, segH = 5;
            int n = barH / step;
            double glow = 0.55 + 0.45 * Math.Sin(Environment.TickCount / 330.0);
            using (var labelFont = new Font("Segoe UI Semibold", 8.5f))
            using (var valFont = new Font("Segoe UI", 8.5f))
            using (var meFont = new Font("Segoe UI", 7.5f))
            using (var white = new SolidBrush(Color.FromArgb(230, 232, 236)))
            using (var fmt = new StringFormat { Alignment = StringAlignment.Center })
            {
                for (int k = 0; k < bars.Length; k++)
                {
                    BarInfo b = bars[k];
                    int x = 14 + k * (colW + gap);
                    using (var lb = new SolidBrush(b.Color)) g.DrawString(b.Label, labelFont, lb, new RectangleF(x - 4, 28, colW + 8, 16), fmt);
                    double total = b.Total.HasValue ? b.Total.Value : 0;
                    double others = total - b.Mine;
                    for (int i = 0; i < n; i++)
                    {
                        double centre = (i + 0.5) / n * 100;
                        int y = top + barH - (i + 1) * step + (step - segH);
                        var rect = new Rectangle(x + 2, y, colW - 4, segH);
                        Color c = SegmentColor(b, (i + 0.5) / n);
                        if (centre > total) { using (var br = new SolidBrush(Color.FromArgb(34, c))) g.FillRectangle(br, rect); continue; }
                        if (centre <= others || b.Mine <= 0)
                        {
                            using (var br = new SolidBrush(Color.FromArgb(205, c))) g.FillRectangle(br, rect);
                        }
                        else
                        {
                            // the part used by LLM Icarus: brighter, with a pulsing glow around it
                            using (var gl2 = new SolidBrush(Color.FromArgb((int)(34 * glow), c))) g.FillRectangle(gl2, Rectangle.Inflate(rect, 5, 3));
                            using (var gl1 = new SolidBrush(Color.FromArgb((int)(70 * glow), c))) g.FillRectangle(gl1, Rectangle.Inflate(rect, 2, 1));
                            using (var br = new SolidBrush(Blend(c, Color.White, 0.30 + 0.12 * glow))) g.FillRectangle(br, rect);
                        }
                    }
                    g.DrawString(b.Text, valFont, white, new RectangleF(x - 4, top + barH + 5, colW + 8, 16), fmt);
                    if (b.MineText.Length > 0)
                        using (var mb = new SolidBrush(b.Color)) g.DrawString(b.MineText, meFont, mb, new RectangleF(x - 4, top + barH + 21, colW + 8, 14), fmt);
                }
            }
            using (var f = new Font("Segoe UI", 8f))
            using (var gray = new SolidBrush(Color.FromArgb(138, 143, 153)))
            {
                using (var gl = new SolidBrush(Color.FromArgb((int)(90 * (0.55 + 0.45 * Math.Sin(Environment.TickCount / 330.0))), 207, 210, 216))) g.FillRectangle(gl, 12, Height - 25, 20, 10);
                using (var br = new SolidBrush(Color.FromArgb(207, 210, 216))) g.FillRectangle(br, 15, Height - 23, 14, 6);
                g.DrawString(haveMe ? "Glowing = LLM Icarus" : "Totals for this PC", f, gray, 38, Height - 28);
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) pulse.Dispose();
            base.Dispose(disposing);
        }
    }

    // The small About window opened from the menu of the icon in the notification area.
    class AboutForm : Form
    {
        const string Repo = "https://github.com/ledicarus/LLM-Icarus";

        public AboutForm(string version, string logoPath, Icon icon)
        {
            Color dark = Color.FromArgb(31, 30, 27);
            Color light = Color.FromArgb(236, 233, 223);
            Color muted = Color.FromArgb(160, 156, 144);
            Text = "About LLM Icarus";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            StartPosition = FormStartPosition.CenterScreen;
            MaximizeBox = false;
            MinimizeBox = false;
            BackColor = dark;
            ForeColor = light;
            Font = new Font("Segoe UI", 9.5f);
            ClientSize = new Size(460, 286);
            if (icon != null) Icon = icon;

            var pic = new PictureBox();
            pic.SetBounds(24, 22, 72, 72);
            pic.SizeMode = PictureBoxSizeMode.Zoom;
            try { if (File.Exists(logoPath)) pic.Image = Image.FromFile(logoPath); else if (icon != null) pic.Image = icon.ToBitmap(); } catch { }
            Controls.Add(pic);

            var title = new Label();
            title.Text = "LLM Icarus";
            title.Font = new Font("Segoe UI Semibold", 17f);
            title.SetBounds(112, 26, 330, 34);
            Controls.Add(title);

            var ver = new Label();
            ver.Text = version.Length > 0 ? "Version " + version : "";
            ver.ForeColor = muted;
            ver.SetBounds(114, 62, 330, 22);
            Controls.Add(ver);

            var about = new Label();
            about.Text = "Run AI models on your own computer: chat, code, transcribe speech, and make images, drawings and 3D parts. " +
                         "Everything stays on this PC.";
            about.SetBounds(24, 112, 412, 56);
            Controls.Add(about);

            Controls.Add(MakeLink("github.com/ledicarus/LLM-Icarus", Repo, 24, 176));
            Controls.Add(MakeLink("Released under the MIT License", Repo + "/blob/main/LICENSE", 24, 204));
            Controls.Add(MakeLink("Third-party components and licenses", Repo + "/blob/main/THIRD_PARTY_NOTICES.txt", 24, 232));

            var ok = new Button();
            ok.Text = "OK";
            ok.Click += delegate { Close(); }; // this window is shown with Show(), not ShowDialog(), so a DialogResult would do nothing
            ok.FlatStyle = FlatStyle.Flat;
            ok.FlatAppearance.BorderSize = 0;
            ok.BackColor = Color.FromArgb(31, 111, 196);
            ok.ForeColor = light;
            ok.SetBounds(356, 238, 80, 32);
            Controls.Add(ok);
            AcceptButton = ok;
            CancelButton = ok;
        }

        static LinkLabel MakeLink(string text, string address, int left, int top)
        {
            var l = new LinkLabel();
            l.Text = text;
            l.AutoSize = true;
            l.Location = new Point(left, top);
            l.LinkColor = Color.FromArgb(120, 170, 235);
            l.ActiveLinkColor = Color.FromArgb(170, 205, 250);
            l.LinkBehavior = LinkBehavior.HoverUnderline;
            l.LinkClicked += delegate { try { Process.Start(address); } catch { } };
            return l;
        }
    }

    // "Run in background / Quit / Cancel" shown when the window is closed. Yes = run in background, No = quit.
    class CloseChoiceForm : Form
    {
        public CloseChoiceForm()
        {
            Color dark = Color.FromArgb(31, 30, 27);
            Color light = Color.FromArgb(236, 233, 223);
            Color accent = Color.FromArgb(31, 111, 196);
            Text = "LLM Icarus";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            StartPosition = FormStartPosition.CenterParent;
            MaximizeBox = false;
            MinimizeBox = false;
            ShowInTaskbar = false;
            BackColor = dark;
            ForeColor = light;
            Font = new Font("Segoe UI", 9.5f);
            ClientSize = new Size(470, 248);
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            var head = new Label();
            head.Text = "Keep LLM Icarus running in the background?";
            head.Font = new Font("Segoe UI Semibold", 12f);
            head.SetBounds(20, 18, 430, 28);
            Controls.Add(head);

            var body = new Label();
            body.Text = "The window will close to an icon next to the clock (it may be under the ^ arrow). The server keeps running, so " +
                        "Claude Code and other programs can still send it prompts. Click the icon to open the window again, or right-click it to quit.";
            body.SetBounds(20, 54, 430, 84);
            Controls.Add(body);

            remember.Text = "Remember my choice (you can change it in Settings > About)";
            remember.AutoSize = true;
            remember.ForeColor = light;
            remember.Location = new Point(22, 146);
            Controls.Add(remember);

            Button run = MakeButton("Run in background", DialogResult.Yes, 20, accent, light);
            Button quit = MakeButton("Quit", DialogResult.No, 214, Color.FromArgb(58, 56, 50), light);
            Button cancel = MakeButton("Cancel", DialogResult.Cancel, 316, Color.FromArgb(58, 56, 50), light);
            run.Width = 184;
            quit.Width = 92;
            cancel.Width = 92;
            Controls.Add(run);
            Controls.Add(quit);
            Controls.Add(cancel);
            AcceptButton = run;
            CancelButton = cancel;
        }

        static Button MakeButton(string text, DialogResult result, int left, Color back, Color fore)
        {
            var b = new Button();
            b.Text = text;
            b.DialogResult = result;
            b.FlatStyle = FlatStyle.Flat;
            b.FlatAppearance.BorderSize = 0;
            b.BackColor = back;
            b.ForeColor = fore;
            b.SetBounds(left, 190, 100, 36);
            return b;
        }

        readonly CheckBox remember = new CheckBox();

        // Shows the question. remember is true when the box was ticked (the caller ignores it for Cancel).
        public static DialogResult Ask(IWin32Window owner, out bool remember)
        {
            using (var f = new CloseChoiceForm())
            {
                DialogResult r = f.ShowDialog(owner);
                remember = f.remember.Checked;
                return r;
            }
        }
    }

    class MainForm : Form
    {
        static readonly Color Dark = Color.FromArgb(31, 30, 27);
        static readonly Color Light = Color.FromArgb(236, 233, 223);

        [DllImport("dwmapi.dll")]
        static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

        readonly string root;
        readonly int port;
        readonly string url;
        bool startedServer;
        bool closing;
        bool quitting;          // the user chose Quit (or the window is closing for a reason that needs no question)
        bool updating;          // an update is being installed: the app is about to close itself
        string dataDir;         // where models, chats and downloaded updates live
        readonly NotifyIcon tray = new NotifyIcon();
        PerfPopup perfPopup;                 // the bars shown while the mouse is over the icon in the notification area
        Rectangle trayRect = Rectangle.Empty; // where that icon is on the screen
        DateTime lastOverTray = DateTime.MinValue;
        readonly System.Windows.Forms.Timer perfHide = new System.Windows.Forms.Timer();   // watches whether the mouse has left
        readonly System.Windows.Forms.Timer perfFetch = new System.Windows.Forms.Timer();  // asks the server for new readings
        readonly ToolStripMenuItem updateItem = new ToolStripMenuItem();
        AboutForm aboutForm;
        string startError;      // why the server could not be started, shown to the user
        bool pageOk;            // the app page has loaded successfully at least once since the last reload
        bool watching;          // a watchdog check is running
        DateTime lastNavigate = DateTime.UtcNow;
        readonly object serverLock = new object();
        readonly System.Windows.Forms.Timer watchdog = new System.Windows.Forms.Timer();
        readonly WebView2 web = new WebView2();
        readonly Label status = new Label();

        public MainForm(string root)
        {
            this.root = root;
            port = Program.PortFromEnvironment();
            url = "http://127.0.0.1:" + port;

            Text = Program.TitleFor(port);
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            // the icon in the notification area while the window is hidden: click to open, right-click for Open / Quit
            tray.Icon = Icon != null ? Icon : SystemIcons.Application;
            tray.Text = ""; // hovering shows the performance bars instead of the plain name
            tray.MouseMove += delegate { OnTrayHover(); };
            perfHide.Interval = 150;
            perfHide.Tick += delegate { CheckTrayHover(); };
            perfFetch.Interval = 1000;
            perfFetch.Tick += delegate { FetchPerf(); };
            var menu = new ContextMenuStrip();
            var about = new ToolStripMenuItem("About");
            about.Click += delegate { ShowAbout(); };
            var open = new ToolStripMenuItem("Open LLM Icarus");
            open.Font = new Font(open.Font, FontStyle.Bold);
            open.Click += delegate { ShowFromBackground(); };
            updateItem.Text = "Update";
            updateItem.Enabled = false; // only usable while a newer version is known
            updateItem.Click += delegate { StartUpdateFromMenu(); };
            var quit = new ToolStripMenuItem("Quit");
            quit.Click += delegate { QuitApp(); };
            menu.Items.Add(about);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(open);
            menu.Items.Add(updateItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(quit);
            menu.Opening += delegate { RefreshUpdateItem(); };
            tray.ContextMenuStrip = menu;
            tray.MouseClick += delegate (object s, MouseEventArgs a) { if (a.Button == MouseButtons.Left) ShowFromBackground(); };
            BackColor = Dark;
            Rectangle area = Screen.PrimaryScreen.WorkingArea;
            Size = new Size(Math.Min(1320, area.Width - 80), Math.Min(880, area.Height - 60));
            StartPosition = FormStartPosition.CenterScreen;

            status.Dock = DockStyle.Fill;
            status.TextAlign = ContentAlignment.MiddleCenter;
            status.Font = new Font("Segoe UI", 12f);
            status.ForeColor = Light;
            status.BackColor = Dark;
            status.Text = "Starting LLM Icarus...";
            Controls.Add(status);

            web.Dock = DockStyle.Fill;
            web.Visible = false;
            web.DefaultBackgroundColor = Dark;
            string envData = Environment.GetEnvironmentVariable("CLUI_DATA_DIR");
            dataDir = string.IsNullOrEmpty(envData) ? Path.Combine(root, "data") : envData;
            web.CreationProperties = new CoreWebView2CreationProperties
            {
                UserDataFolder = Path.Combine(dataDir, "webview2")
            };
            Controls.Add(web);

            Load += OnLoad;
            FormClosing += OnClosing;
            FormClosed += delegate { HidePerfPopup(); if (perfPopup != null) perfPopup.Dispose(); tray.Visible = false; tray.Dispose(); };
        }

        // Another copy of the program was started: show this window again, whether it was hidden or just behind others.
        protected override void WndProc(ref Message m)
        {
            if (m.Msg == (int)Program.WM_ShowApp) { ShowFromBackground(); return; }
            base.WndProc(ref m);
        }

        // Hide the window (and with it its taskbar button) and leave an icon in the notification area. The program and the
        // server it started keep running.
        void RunInBackground()
        {
            tray.Visible = true;
            Hide();
            try { tray.ShowBalloonTip(4000, "LLM Icarus is still running", "Click its icon to open the window, or right-click it to quit.", ToolTipIcon.Info); } catch { }
        }

        [StructLayout(LayoutKind.Sequential)]
        struct NOTIFYICONIDENTIFIER { public uint cbSize; public IntPtr hWnd; public uint uID; public Guid guidItem; }
        [StructLayout(LayoutKind.Sequential)]
        struct RECT { public int left, top, right, bottom; }
        [DllImport("shell32.dll")]
        static extern int Shell_NotifyIconGetRect(ref NOTIFYICONIDENTIFIER id, out RECT rect);

        // Where the notification-area icon is on the screen (Windows does not say directly; the NotifyIcon keeps its window and id).
        Rectangle GetTrayRect()
        {
            try
            {
                var flags = System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance;
                var win = typeof(NotifyIcon).GetField("window", flags).GetValue(tray) as NativeWindow;
                var id = new NOTIFYICONIDENTIFIER();
                id.hWnd = win.Handle;
                id.uID = (uint)(int)typeof(NotifyIcon).GetField("id", flags).GetValue(tray);
                id.cbSize = (uint)Marshal.SizeOf(typeof(NOTIFYICONIDENTIFIER));
                RECT r;
                if (Shell_NotifyIconGetRect(ref id, out r) == 0 && r.right > r.left) return Rectangle.FromLTRB(r.left, r.top, r.right, r.bottom);
            }
            catch { }
            return Rectangle.Empty;
        }

        // The mouse is over the icon: show the bars above it (or below it when the taskbar is at the top of the screen).
        void OnTrayHover()
        {
            lastOverTray = DateTime.UtcNow;
            if (perfPopup != null && perfPopup.Visible) return;
            if (perfPopup == null || perfPopup.IsDisposed) perfPopup = new PerfPopup();
            Point cursor = Cursor.Position;
            trayRect = GetTrayRect();
            if (trayRect.IsEmpty) trayRect = new Rectangle(cursor.X - 14, cursor.Y - 14, 28, 28);
            Rectangle area = Screen.FromRectangle(trayRect).WorkingArea;
            Size size = perfPopup.Size;
            int x = Math.Max(area.Left + 4, Math.Min(area.Right - size.Width - 4, trayRect.Left + trayRect.Width / 2 - size.Width / 2));
            bool above = trayRect.Top > area.Top + area.Height / 2;
            int y = above ? trayRect.Top - size.Height - 8 : trayRect.Bottom + 8;
            y = Math.Max(area.Top + 4, Math.Min(area.Bottom - size.Height - 4, y));
            perfPopup.Location = new Point(x, y);
            perfPopup.Show();
            perfHide.Start();
            perfFetch.Start();
            FetchPerf();
        }

        // Every moment: keep the bars while the mouse is over the icon or over the bars; hide them shortly after it leaves.
        void CheckTrayHover()
        {
            if (perfPopup == null || !perfPopup.Visible) { HidePerfPopup(); return; }
            Point c = Cursor.Position;
            Rectangle near = Rectangle.Inflate(trayRect, 6, 6);
            if (near.Contains(c) || perfPopup.Bounds.Contains(c)) lastOverTray = DateTime.UtcNow;
            else if ((DateTime.UtcNow - lastOverTray).TotalMilliseconds > 400) HidePerfPopup();
        }

        void HidePerfPopup()
        {
            perfHide.Stop();
            perfFetch.Stop();
            if (perfPopup != null && !perfPopup.IsDisposed && perfPopup.Visible) perfPopup.Hide();
        }

        // New readings from the server (it only measures while somebody asks, so this starts and stops it too).
        void FetchPerf()
        {
            Task.Run(() =>
            {
                try
                {
                    var js = new System.Web.Script.Serialization.JavaScriptSerializer();
                    var d = js.DeserializeObject(ReadText(url + "/api/sysmon")) as System.Collections.Generic.Dictionary<string, object>;
                    if (d == null) return;
                    BeginInvoke((Action)(() => { if (perfPopup != null && !perfPopup.IsDisposed && perfPopup.Visible) perfPopup.SetData(d); }));
                }
                catch { }
            });
        }

        void ShowFromBackground()
        {
            HidePerfPopup();
            if (!Visible) Show();
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            tray.Visible = false;
            Activate();
            BringToFront();
        }

        void QuitApp()
        {
            quitting = true;
            Close();
        }

        // The version in package.json next to the program.
        string ReadVersion()
        {
            try
            {
                string text = File.ReadAllText(Path.Combine(root, "package.json"));
                System.Text.RegularExpressions.Match m = System.Text.RegularExpressions.Regex.Match(text, "\"version\"\\s*:\\s*\"([^\"]+)\"");
                if (m.Success) return m.Groups[1].Value;
            }
            catch { }
            return "";
        }

        // The small About window from the icon's menu (the same facts as Settings > About inside the app).
        void ShowAbout()
        {
            if (aboutForm == null || aboutForm.IsDisposed)
                aboutForm = new AboutForm(ReadVersion(), Path.Combine(root, "web", "logo.png"), Icon);
            if (!aboutForm.Visible) aboutForm.Show();
            if (aboutForm.WindowState == FormWindowState.Minimized) aboutForm.WindowState = FormWindowState.Normal;
            aboutForm.Activate();
        }

        // "Update" is only clickable when the server knows a newer version exists (it checks GitHub in the background).
        void RefreshUpdateItem()
        {
            bool newer = false;
            string latest = "";
            try
            {
                string text = ReadText(url + "/api/app-update/available");
                newer = text.Contains("\"newer\":true");
                System.Text.RegularExpressions.Match m = System.Text.RegularExpressions.Regex.Match(text, "\"latest\":\"([^\"]+)\"");
                if (m.Success) latest = m.Groups[1].Value;
            }
            catch { }
            updateItem.Enabled = newer && !updating;
            updateItem.ToolTipText = newer ? "Version " + latest + " is available" : "LLM Icarus is up to date";
        }

        // Update clicked in the icon's menu: show the window and let the page download the new version (it shows the progress).
        void StartUpdateFromMenu()
        {
            ShowFromBackground();
            try { if (web.CoreWebView2 != null) web.CoreWebView2.PostWebMessageAsString("start-update"); } catch { }
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            try
            {
                // dark title bar when Windows is in dark mode
                object v = Registry.GetValue(@"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "AppsUseLightTheme", 1);
                if (v is int && (int)v == 0)
                {
                    int on = 1;
                    DwmSetWindowAttribute(Handle, 20, ref on, 4);
                }
            }
            catch { }
        }

        async void OnLoad(object sender, EventArgs e)
        {
            try
            {
                bool ok = await Task.Run(() => EnsureServer());
                if (!ok)
                {
                    string why = startError != null
                        ? startError
                        : "LLM Icarus could not start its server.\n\nLook for details in:\n" + Path.Combine(root, "data", "crash.log");
                    MessageBox.Show(this, why, "LLM Icarus", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    QuitApp();
                    return;
                }
                await web.EnsureCoreWebView2Async(null);
                CoreWebView2 core = web.CoreWebView2;
                core.Settings.AreDevToolsEnabled = false;
                core.Settings.IsStatusBarEnabled = false;
                core.NewWindowRequested += delegate (object s, CoreWebView2NewWindowRequestedEventArgs a)
                {
                    a.Handled = true;
                    OpenExternal(a.Uri);
                };
                core.NavigationStarting += delegate (object s, CoreWebView2NavigationStartingEventArgs a)
                {
                    // links to other websites open in your normal browser, not in this window
                    if (a.Uri.StartsWith("http") && !a.Uri.StartsWith(url)) { a.Cancel = true; OpenExternal(a.Uri); }
                };
                // the page asks us to install a downloaded update (only our own page may ask)
                core.WebMessageReceived += delegate (object s, CoreWebView2WebMessageReceivedEventArgs a)
                {
                    string msg = null;
                    try { msg = a.TryGetWebMessageAsString(); } catch { }
                    if (msg == "install-update" && a.Source != null && a.Source.StartsWith(url)) InstallUpdate();
                };
                core.NavigationCompleted += delegate (object s, CoreWebView2NavigationCompletedEventArgs a)
                {
                    pageOk = a.IsSuccess;
                    if (a.IsSuccess) { web.Visible = true; status.Visible = false; }
                };
                lastNavigate = DateTime.UtcNow;
                web.Source = new Uri(url);
                watchdog.Interval = 3000;
                watchdog.Tick += delegate { Watchdog(); };
                watchdog.Start();
            }
            catch (WebView2RuntimeNotFoundException)
            {
                MessageBox.Show(this,
                    "LLM Icarus needs the Microsoft Edge WebView2 Runtime, which was not found on this PC.\n\n" +
                    "It will open in your web browser for now. To get the app window, install the runtime from:\n" +
                    "https://go.microsoft.com/fwlink/p/?LinkId=2124703",
                    "LLM Icarus", MessageBoxButtons.OK, MessageBoxIcon.Information);
                status.Text = "LLM Icarus is open in your web browser.\n\nClose this window to stop it.";
                OpenExternal(url);
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "Could not show the app window:\n" + ex.Message, "LLM Icarus", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                QuitApp();
            }
        }

        void OnClosing(object sender, FormClosingEventArgs e)
        {
            // The user closed the window of a working app: ask whether to keep the server running in the background.
            // (Not asked when Windows is shutting down, when the app never started properly, or after choosing Quit.)
            if (!quitting && e.CloseReason == CloseReason.UserClosing && web.CoreWebView2 != null)
            {
                // a remembered choice (Settings > About, or the box on the question) skips the question
                string saved = ReadCloseAction();
                DialogResult choice;
                if (saved == "background") choice = DialogResult.Yes;
                else if (saved == "quit") choice = DialogResult.No;
                else
                {
                    bool remember;
                    choice = CloseChoiceForm.Ask(this, out remember);
                    if (remember && (choice == DialogResult.Yes || choice == DialogResult.No))
                        SaveCloseAction(choice == DialogResult.Yes ? "background" : "quit");
                }
                if (choice == DialogResult.Yes) { e.Cancel = true; RunInBackground(); return; }
                if (choice != DialogResult.No) { e.Cancel = true; return; }
                quitting = true;
            }
            closing = true;
            tray.Visible = false;
            watchdog.Stop();
            if (!startedServer) return; // it was already running (for example started from a terminal): leave it
            RequestServerShutdown();
        }

        // What to do when the window is closed: "ask" (default), "background" or "quit". It lives in the app's settings.
        string ReadCloseAction()
        {
            try
            {
                System.Text.RegularExpressions.Match m = System.Text.RegularExpressions.Regex.Match(ReadText(url + "/api/settings"), "\"closeAction\"\\s*:\\s*\"(\\w+)\"");
                if (m.Success) return m.Groups[1].Value;
            }
            catch { }
            return "ask";
        }

        void SaveCloseAction(string action)
        {
            try
            {
                byte[] body = System.Text.Encoding.UTF8.GetBytes("{\"closeAction\":\"" + action + "\"}");
                var req = (HttpWebRequest)WebRequest.Create(url + "/api/settings");
                req.Method = "POST";
                req.ContentType = "application/json";
                req.ContentLength = body.Length;
                req.Timeout = 3000;
                req.Proxy = null;
                using (Stream s = req.GetRequestStream()) s.Write(body, 0, body.Length);
                req.GetResponse().Close();
            }
            catch { }
        }

        void RequestServerShutdown()
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(url + "/api/shutdown");
                req.Method = "POST";
                req.ContentLength = 0;
                req.Timeout = 4000;
                req.Proxy = null;
                req.GetResponse().Close();
            }
            catch { }
        }

        string ReadText(string address)
        {
            var req = (HttpWebRequest)WebRequest.Create(address);
            req.Timeout = 4000;
            req.Proxy = null;
            using (var resp = req.GetResponse())
            using (var rd = new StreamReader(resp.GetResponseStream()))
                return rd.ReadToEnd();
        }

        // The page has downloaded a new version and the user pressed OK: close the app and its server, run the installer
        // quietly (it starts the new version when it is done), and exit so the installer can replace our files.
        void InstallUpdate()
        {
            if (updating || closing) return;
            string installer = null;
            try { installer = ReadText(url + "/api/app-update/installer-path").Trim(); } catch { }
            // only run what the server says it downloaded, and only from our own updates folder
            string folder = Path.GetFullPath(Path.Combine(dataDir, "updates")).TrimEnd('\\');
            bool ok = !string.IsNullOrEmpty(installer) && File.Exists(installer)
                && string.Equals(Path.GetDirectoryName(Path.GetFullPath(installer)), folder, StringComparison.OrdinalIgnoreCase)
                && Path.GetFileName(installer).StartsWith("LLM-Icarus-Setup-") && installer.EndsWith(".exe", StringComparison.OrdinalIgnoreCase);
            if (!ok)
            {
                MessageBox.Show(this, "The downloaded update could not be found. Please try the update again.", "LLM Icarus", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            updating = true;
            quitting = true;
            closing = true;
            watchdog.Stop();
            tray.Visible = false;
            Hide();
            Task.Run(() =>
            {
                RequestServerShutdown();
                for (int i = 0; i < 60; i++)
                {
                    if (GetServerState() == ServerState.Down) break; // gone: its files are free to replace
                    Thread.Sleep(500);
                }
                string error = null;
                try
                {
                    var psi = new ProcessStartInfo(installer, "/SILENT /SUPPRESSMSGBOXES /NORESTART /CLOSEAPPLICATIONS /UPDATE=1");
                    psi.WorkingDirectory = folder;
                    psi.UseShellExecute = true;
                    Process.Start(psi);
                }
                catch (Exception ex) { error = ex.Message; }
                BeginInvoke((Action)(() =>
                {
                    if (error != null) MessageBox.Show("The update could not be started:\n" + error + "\n\nLLM Icarus will close. Open it again to keep using it.", "LLM Icarus", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    startedServer = false; // the server is already stopped
                    Close();
                }));
            });
        }

        enum ServerState { Down, Up, ShuttingDown }

        // Make sure a server is answering. Safe to call from a background thread.
        bool EnsureServer()
        {
            lock (serverLock)
            {
                ServerState st = GetServerState();
                if (st == ServerState.Up) return true;

                if (!File.Exists(Path.Combine(root, "server", "index.js")))
                {
                    startError = "The LLM Icarus program files were not found.\n\nLooked for server\\index.js in:\n" + root +
                                 "\n\nIf you installed LLM Icarus, reinstall it. If you are running from the source folder, start it from there.";
                    return false;
                }

                // A previous copy is still closing (it unloads the model first, which can take several seconds).
                // Connecting to it now would leave this window talking to a server that is about to disappear,
                // and starting a new one would collide with it on the port, so wait for it to finish.
                for (int i = 0; i < 40 && st == ServerState.ShuttingDown; i++)
                {
                    Thread.Sleep(500);
                    st = GetServerState();
                }
                if (st == ServerState.Up) return true;

                string node = Path.Combine(root, "runtime", "node.exe");
                if (!File.Exists(node)) node = FindOnPath("node.exe");
                if (node == null) return false;

                // up to three attempts: if the port was still busy, the new server exits at once, so try again
                for (int attempt = 0; attempt < 3; attempt++)
                {
                    var psi = new ProcessStartInfo(node, "server/index.js");
                    psi.WorkingDirectory = root;
                    psi.UseShellExecute = false;
                    psi.CreateNoWindow = true;
                    psi.EnvironmentVariables["PORT"] = port.ToString();
                    Process proc = Process.Start(psi);
                    startedServer = true;
                    for (int i = 0; i < 40; i++)
                    {
                        if (GetServerState() == ServerState.Up) return true;
                        if (proc.HasExited) break;
                        Thread.Sleep(500);
                    }
                    Thread.Sleep(1000);
                }
                return GetServerState() == ServerState.Up;
            }
        }

        ServerState GetServerState()
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(url + "/api/settings");
                req.Timeout = 1500;
                req.Proxy = null;
                using (var resp = (HttpWebResponse)req.GetResponse())
                    return resp.StatusCode == HttpStatusCode.OK ? ServerState.Up : ServerState.Down;
            }
            catch (WebException ex)
            {
                HttpWebResponse r = ex.Response as HttpWebResponse;
                if (r != null && r.StatusCode == HttpStatusCode.ServiceUnavailable) return ServerState.ShuttingDown;
                return ServerState.Down;
            }
            catch { return ServerState.Down; }
        }

        bool ServerUp() { return GetServerState() == ServerState.Up; }

        // Every few seconds: if the page has not loaded, or the server has died, bring the server back and reload.
        void Watchdog()
        {
            if (watching || closing) return;
            watching = true;
            // result: 0 = server was fine, 1 = server was missing and has been restarted, 2 = it could not be restarted
            Task.Run(() =>
            {
                if (ServerUp()) return 0;
                return EnsureServer() ? 1 : 2;
            }).ContinueWith(t =>
            {
                try
                {
                    BeginInvoke((Action)(() =>
                    {
                        watching = false;
                        if (closing || web.CoreWebView2 == null || t.IsFaulted) return;
                        double idle = (DateTime.UtcNow - lastNavigate).TotalSeconds;
                        // reload after a server restart, or when the page never loaded and has had a fair chance to
                        if (t.Result == 1 || (t.Result == 0 && !pageOk && idle > 8))
                        {
                            lastNavigate = DateTime.UtcNow;
                            web.CoreWebView2.Navigate(url);
                        }
                    }));
                }
                catch { }
            });
        }

        static string FindOnPath(string file)
        {
            string path = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (string dir in path.Split(';'))
            {
                try
                {
                    string candidate = Path.Combine(dir.Trim().Trim('"'), file);
                    if (File.Exists(candidate)) return candidate;
                }
                catch { }
            }
            return null;
        }

        static void OpenExternal(string uri)
        {
            try { Process.Start(uri); } catch { }
        }
    }
}
