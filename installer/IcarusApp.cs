// LLM Icarus - native window for the app.
//
// A small Windows program (no console window) that:
//   1. starts the LLM Icarus server in the background if it isn't running,
//   2. shows the app in its own window using Microsoft's WebView2 (the same engine as Edge, already
//      part of Windows 10/11), with its own taskbar identity and icon so it can be pinned,
//   3. stops the server again when the window is closed (only if this program started it).
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

            bool first;
            using (var mutex = new Mutex(true, "LLMIcarus.SingleInstance", out first))
            {
                if (!first)
                {
                    // already open: bring that window to the front instead of starting a second copy
                    IntPtr h = FindWindow(null, "LLM Icarus");
                    if (h != IntPtr.Zero) { ShowWindow(h, 9); SetForegroundWindow(h); }
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
            string p = Environment.GetEnvironmentVariable("PORT");
            int parsed;
            port = (p != null && int.TryParse(p, out parsed)) ? parsed : 3210;
            url = "http://127.0.0.1:" + port;

            Text = "LLM Icarus";
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
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
            web.CreationProperties = new CoreWebView2CreationProperties
            {
                UserDataFolder = Path.Combine(root, "data", "webview2")
            };
            Controls.Add(web);

            Load += OnLoad;
            FormClosing += OnClosing;
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
                    Close();
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
                Close();
            }
        }

        void OnClosing(object sender, FormClosingEventArgs e)
        {
            closing = true;
            watchdog.Stop();
            if (!startedServer) return; // it was already running (for example started from a terminal): leave it
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
