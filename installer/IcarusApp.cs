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
            ClientSize = new Size(470, 212);
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
            b.SetBounds(left, 154, 100, 36);
            return b;
        }

        public static DialogResult Ask(IWin32Window owner)
        {
            using (var f = new CloseChoiceForm())
                return f.ShowDialog(owner);
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
            tray.Text = "LLM Icarus (running in the background)";
            var menu = new ContextMenuStrip();
            var open = new ToolStripMenuItem("Open LLM Icarus");
            open.Font = new Font(open.Font, FontStyle.Bold);
            open.Click += delegate { ShowFromBackground(); };
            var quit = new ToolStripMenuItem("Quit");
            quit.Click += delegate { QuitApp(); };
            menu.Items.Add(open);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(quit);
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
            FormClosed += delegate { tray.Visible = false; tray.Dispose(); };
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

        void ShowFromBackground()
        {
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
                DialogResult choice = CloseChoiceForm.Ask(this);
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
