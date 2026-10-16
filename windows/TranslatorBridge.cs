using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.Windows.Forms;

namespace ClaudeOfflineTranslator
{
    public sealed class DesktopBridge : Form
    {
        private readonly string endpoint;
        private readonly string token;
        private readonly Label status = new Label();
        private readonly CheckBox automatic = new CheckBox();
        private readonly TextBox source = new TextBox();
        private readonly TextBox english = new TextBox();
        private readonly RichTextBox chinese = new RichTextBox();
        private readonly System.Windows.Forms.Timer poll = new System.Windows.Forms.Timer();
        private volatile Snapshot snapshot;
        private volatile bool enabled = true;
        private int polling;
        private int sending;
        private int translatingAnswer;
        private Action restoreClipboard;
        private string lastAnswerKey = "";
        private void DebugStage(string stage)
        {
            if (Environment.GetEnvironmentVariable("CDT_DEBUG") == "1")
                File.AppendAllText(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".claude-desktop-translator", "bridge-debug.log"), DateTime.UtcNow.ToString("O") + " " + stage + Environment.NewLine);
        }

        private sealed class Snapshot
        {
            public AutomationElement Window;
            public AutomationElement Input;
            public int ProcessId;
            public IntPtr Handle;
            public string Context;
        }

        public static void Run(string configFile)
        {
            bool created;
            using (var mutex = new Mutex(true, "Local\\ClaudeDesktopOfflineTranslator", out created))
            {
                if (!created) return;
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                var config = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(configFile));
                Application.Run(new DesktopBridge(Convert.ToInt32(config["port"]), Convert.ToString(config["token"])));
            }
        }

        private DesktopBridge(int port, string localToken)
        {
            endpoint = "http://127.0.0.1:" + port;
            token = localToken;
            Text = "Claude 中英翻译 · 离线";
            Size = new Size(470, 790);
            MinimumSize = new Size(380, 650);
            Font = new Font("Microsoft YaHei UI", 10);
            StartPosition = FormStartPosition.Manual;
            Location = new Point(Screen.PrimaryScreen.WorkingArea.Right - Width - 20, 90);
            TopMost = true;
            var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(14), ColumnCount = 1, RowCount = 9 };
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 38));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 34));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 28));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 120));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 45));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 28));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 110));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 28));
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            status.Text = "正在连接 Claude 桌面窗口…";
            status.Dock = DockStyle.Fill;
            status.ForeColor = Color.FromArgb(70, 90, 75);
            automatic.Text = "自动读取 Claude 回答并离线翻译为中文";
            automatic.Checked = true;
            automatic.Dock = DockStyle.Fill;
            automatic.CheckedChanged += delegate { enabled = automatic.Checked; };
            source.Multiline = true;
            source.ScrollBars = ScrollBars.Vertical;
            source.Dock = DockStyle.Fill;
            source.AccessibleName = "Chinese input";
            source.KeyDown += delegate(object sender, KeyEventArgs args)
            {
                if (args.KeyCode == Keys.Enter && !args.Shift && !args.Control && !args.Alt)
                {
                    args.Handled = true; args.SuppressKeyPress = true; PrepareSend(true);
                }
            };
            english.Multiline = true;
            english.ReadOnly = true;
            english.ScrollBars = ScrollBars.Vertical;
            english.Dock = DockStyle.Fill;
            english.AccessibleName = "English submission preview";
            chinese.ReadOnly = true;
            chinese.Dock = DockStyle.Fill;
            chinese.BackColor = Color.FromArgb(250, 249, 246);
            chinese.BorderStyle = BorderStyle.FixedSingle;
            chinese.AccessibleName = "Chinese response translation";
            var translateButton = new Button { Text = "翻译并发送给 Claude", Dock = DockStyle.Fill };
            translateButton.Click += delegate { PrepareSend(true); };
            layout.Controls.Add(status, 0, 0);
            layout.Controls.Add(automatic, 0, 1);
            layout.Controls.Add(new Label { Text = "中文输入 · Enter 发送，Shift+Enter 换行", Dock = DockStyle.Fill }, 0, 2);
            layout.Controls.Add(source, 0, 3);
            layout.Controls.Add(translateButton, 0, 4);
            layout.Controls.Add(new Label { Text = "实际提交的英文", Dock = DockStyle.Fill }, 0, 5);
            layout.Controls.Add(english, 0, 6);
            layout.Controls.Add(new Label { Text = "Claude 回答的中文译文", Dock = DockStyle.Fill }, 0, 7);
            layout.Controls.Add(chinese, 0, 8);
            Controls.Add(layout);
            Shown += delegate
            {
                poll.Interval = 500;
                poll.Tick += Poll;
                poll.Start();
                Poll(null, EventArgs.Empty);
            };
            FormClosed += delegate
            {
                enabled = false;
                poll.Stop();
                RestoreClipboard();
            };
        }

        private static bool IsComposer(AutomationElement element)
        {
            try
            {
                if (element.Current.ControlType != ControlType.Edit) return false;
                var name = element.Current.Name ?? "";
                return name == "Prompt" || name.IndexOf("prompt", StringComparison.OrdinalIgnoreCase) >= 0 || name.IndexOf("Claude", StringComparison.OrdinalIgnoreCase) >= 0 || name == "提示";
            }
            catch { return false; }
        }

        private static AutomationElement FindSend(AutomationElement window)
        {
            return window.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button))
                .Cast<AutomationElement>().FirstOrDefault(e => new[] { "Send message", "Send", "发送消息", "发送" }.Contains(e.Current.Name) && e.Current.IsEnabled);
        }

        private void Poll(object sender, EventArgs args)
        {
            if (Interlocked.CompareExchange(ref polling, 1, 0) != 0) return;
            Task.Run(delegate
            {
                try
                {
                    var process = Process.GetProcessesByName("claude").FirstOrDefault(p => p.MainWindowHandle != IntPtr.Zero);
                    if (process == null) { snapshot = null; Ui(delegate { status.Text = "请打开 Claude 官方桌面应用。"; }); return; }
                    var window = AutomationElement.FromHandle(process.MainWindowHandle);
                    var input = window.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit)).Cast<AutomationElement>().FirstOrDefault(IsComposer);
                    if (input == null) { snapshot = null; Ui(delegate { status.Text = "等待 Claude 聊天输入框…"; }); return; }
                    snapshot = new Snapshot { Window = window, Input = input, ProcessId = process.Id, Handle = process.MainWindowHandle, Context = ReadContext(window) };
                    DebugStage("input_connected");
                    Ui(delegate { if (status.Text.StartsWith("正在连接") || status.Text.StartsWith("等待 Claude") || status.Text.StartsWith("请打开 Claude")) status.Text = "已连接 Claude · 使用当前官方账号"; });
                    if (!enabled || Volatile.Read(ref sending) != 0 || Volatile.Read(ref translatingAnswer) != 0) return;
                    var stop = window.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button)).Cast<AutomationElement>()
                        .Any(e => new[] { "Stop response", "Stop", "停止响应", "停止" }.Contains(e.Current.Name));
                    if (stop) return;
                    DebugStage("not_streaming");
                    var messages = window.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Group)).Cast<AutomationElement>()
                        .Where(e => Regex.IsMatch(e.Current.Name ?? "", @"^Message \d+( of \d+)?$")).ToArray();
                    DebugStage("messages_" + messages.Length);
                    for (int i = messages.Length - 1; i >= 0; i--)
                    {
                        var message = messages[i];
                        var summary = message.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Text)).Cast<AutomationElement>()
                            .FirstOrDefault(e => (e.Current.Name ?? "").StartsWith("Claude responded:", StringComparison.Ordinal));
                        if (summary == null) continue;
                        DebugStage("assistant_found");
                        var key = string.Join("-", message.GetRuntimeId()) + summary.Current.Name;
                        if (key == lastAnswerKey) return;
                        lastAnswerKey = key;
                        Interlocked.Exchange(ref translatingAnswer, 1);
                        var fallback = summary.Current.Name.Substring("Claude responded:".Length).Trim();
                        Ui(delegate { CaptureAnswer(message, fallback); });
                        break;
                    }
                }
                catch (Exception error) { DebugStage("poll_error_" + error.GetType().Name); Ui(delegate { if (Volatile.Read(ref sending) == 0) status.Text = "窗口连接：" + error.Message; }); }
                finally { Interlocked.Exchange(ref polling, 0); }
            });
        }

        private static string ReadInput(AutomationElement input)
        {
            object pattern;
            if (input.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) return ((ValuePattern)pattern).Current.Value;
            if (input.TryGetCurrentPattern(TextPattern.Pattern, out pattern)) return ((TextPattern)pattern).DocumentRange.GetText(-1).TrimEnd('\r', '\n');
            return string.Concat(input.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Text)).Cast<AutomationElement>().Select(e => e.Current.Name)).TrimEnd('\r', '\n');
        }

        private static string ReadContext(AutomationElement window)
        {
            return string.Join("|", window.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document)).Cast<AutomationElement>().Select(e => e.Current.Name));
        }

        private static bool InputMatches(AutomationElement input, string expected)
        {
            if (NormalizeLines(ReadInput(input)) == NormalizeLines(expected)) return true;
            // Claude turns typed backticks into a code span and adds a zero-width
            // caret marker. Reconstruct only code spans identified by their font;
            // code characters must still match exactly before sending.
            var result = new StringBuilder();
            var code = new StringBuilder();
            Action flushCode = delegate
            {
                if (code.Length == 0) return;
                result.Append('`').Append(code).Append('`');
                code.Clear();
            };
            foreach (AutomationElement node in input.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Text)))
            {
                object pattern;
                if (!node.TryGetCurrentPattern(TextPattern.Pattern, out pattern)) return false;
                var range = ((TextPattern)pattern).DocumentRange;
                var text = range.GetText(-1);
                var font = Convert.ToString(range.GetAttributeValue(TextPattern.FontNameAttribute));
                if (Regex.IsMatch(font, "mono|consolas|courier", RegexOptions.IgnoreCase)) code.Append(text);
                else { flushCode(); result.Append(text.Replace("\u200b", "")); }
            }
            flushCode();
            return NormalizeLines(result.ToString()) == NormalizeLines(expected);
        }

        private static string NormalizeLines(string text)
        {
            return text.Replace("\r\n", "\n").Replace('\r', '\n').TrimEnd('\n');
        }

        private string Translate(string text, string target)
        {
            var request = (HttpWebRequest)WebRequest.Create(endpoint + "/translate");
            request.Proxy = null;
            request.Method = "POST";
            request.ContentType = "application/json; charset=utf-8";
            request.Headers["x-local-token"] = token;
            request.Timeout = 180000;
            var bytes = Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(new { text = text, target = target }));
            request.ContentLength = bytes.Length;
            using (var stream = request.GetRequestStream()) stream.Write(bytes, 0, bytes.Length);
            using (var response = request.GetResponse())
            using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                return Convert.ToString(new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(reader.ReadToEnd())["text"]);
        }

        private void PrepareSend(bool explicitButton)
        {
            if (Interlocked.CompareExchange(ref sending, 1, 0) != 0) return;
            var current = snapshot;
            if (current == null) { sending = 0; status.Text = "请先打开 Claude 的聊天输入框。"; return; }
            string original = source.Text;
            bool ownInput = !string.IsNullOrWhiteSpace(original);
            string desktopDraft;
            try { desktopDraft = ReadInput(current.Input); }
            catch { sending = 0; status.Text = "输入框已变化，请重新发送。"; return; }
            if (string.IsNullOrWhiteSpace(original)) original = desktopDraft;
            else if (!string.IsNullOrWhiteSpace(desktopDraft)) { sending = 0; status.Text = "Claude 输入框中有草稿，请先保存或清空。"; return; }
            if (string.IsNullOrWhiteSpace(original)) { sending = 0; return; }
            status.Text = "正在本机翻译输入…";
            Task.Run(delegate
            {
                try
                {
                    var translated = Translate(original, "en");
                    Ui(delegate
                    {
                        try
                        {
                            if (ReadInput(current.Input) != desktopDraft) throw new InvalidOperationException("Claude 草稿已改动，请重新发送。");
                            if (ownInput && source.Text != original) throw new InvalidOperationException("中文输入已改动，请重新发送。");
                            if (ReadContext(current.Window) != current.Context) throw new InvalidOperationException("Claude 会话已切换，请重新发送。");
                            english.Text = translated.Replace("\r\n", "\n").Replace("\n", "\r\n");
                            SetForegroundWindow(current.Handle);
                            current.Input.SetFocus();
                            if (!Automation.Compare(AutomationElement.FocusedElement, current.Input)) throw new InvalidOperationException("Claude 输入框未获得焦点，未提交。请解锁屏幕并打开聊天窗口。");
                            DebugStage("input_focus_ready");
                            restoreClipboard = PasteText(translated);
                            DebugStage("english_typed");
                            var timer = new System.Windows.Forms.Timer { Interval = 100 };
                            int verificationAttempts = 0;
                            timer.Tick += delegate
                            {
                                try
                                {
                                    verificationAttempts++;
                                    if (ReadContext(current.Window) != current.Context) throw new InvalidOperationException("Claude 会话已切换，未提交。");
                                    if (!InputMatches(current.Input, translated))
                                    {
                                        if (verificationAttempts < 100) return;
                                        throw new InvalidOperationException("输入框内容校验失败，未提交。");
                                    }
                                    var send = FindSend(current.Window);
                                    if (send == null)
                                    {
                                        if (verificationAttempts < 100) return;
                                        throw new InvalidOperationException("Claude 当前不可发送；英文已填入输入框。");
                                    }
                                    timer.Stop(); timer.Dispose();
                                    RestoreClipboard();
                                    ((InvokePattern)send.GetCurrentPattern(InvokePattern.Pattern)).Invoke();
                                    source.Clear();
                                    status.Text = "英文已由 Claude 官方客户端提交。";
                                    Interlocked.Exchange(ref sending, 0);
                                }
                                catch (Exception error) { timer.Stop(); timer.Dispose(); status.Text = error.Message; Interlocked.Exchange(ref sending, 0); RestoreClipboard(); }
                            };
                            timer.Start();
                        }
                        catch (Exception error) { status.Text = error.Message; sending = 0; RestoreClipboard(); }
                    });
                }
                catch { Ui(delegate { status.Text = "离线翻译失败，原文未提交。请检查本地模型。"; sending = 0; }); }
            });
        }

        private void CaptureAnswer(AutomationElement message, string fallback)
        {
            DebugStage("capture_enter");
            string markdown = fallback;
            try
            {
                markdown = ReadResponse(message, fallback);
                status.Text = "正在本机翻译 Claude 回答…";
                DebugStage("translation_requested");
                Task.Run(delegate
                {
                    try
                    {
                        var translated = Translate(markdown, "zh");
                        Ui(delegate { chinese.Text = translated; status.Text = "中文译文已更新 · 本地离线模型"; });
                    }
                    catch { Ui(delegate { status.Text = "回答翻译失败；Claude 原文仍保留在原窗口。"; lastAnswerKey = ""; }); }
                    finally { Interlocked.Exchange(ref translatingAnswer, 0); }
                });
            }
            catch (Exception error) { DebugStage("capture_error_" + error.GetType().Name); Interlocked.Exchange(ref translatingAnswer, 0); lastAnswerKey = ""; }
        }

        private static string ReadResponse(AutomationElement body, string fallback)
        {
            AutomationElement responseBody = null;
            foreach (AutomationElement text in body.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Text)))
            {
                var ancestor = TreeWalker.RawViewWalker.GetParent(text);
                for (int depth = 0; depth < 12 && ancestor != null && !Automation.Compare(ancestor, body); depth++)
                {
                    if ((ancestor.Current.ClassName ?? "").Split(' ').Contains("font-claude-response")) { responseBody = ancestor; break; }
                    ancestor = TreeWalker.RawViewWalker.GetParent(ancestor);
                }
                if (responseBody != null) break;
            }
            // Promotion cards and action controls are siblings of the response.
            if (responseBody == null) return fallback;
            body = responseBody;
            var result = new StringBuilder();
            var code = new StringBuilder();
            Action flushCode = delegate
            {
                if (code.Length == 0) return;
                var value = code.ToString();
                result.Append(value.Contains("\n") || value.Length > 100 ? "\n```\n" + value + "\n```\n" : "`" + value + "`");
                code.Clear();
            };
            var nodes = body.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Text));
            foreach (AutomationElement node in nodes)
            {
                if ((node.Current.ClassName ?? "").Contains("sr-only")) continue;
                var ancestor = TreeWalker.RawViewWalker.GetParent(node);
                bool auxiliary = false;
                bool codeBlock = false;
                for (int depth = 0; depth < 12 && ancestor != null && !Automation.Compare(ancestor, body); depth++)
                {
                    if (ancestor.Current.ControlType == ControlType.ToolBar || ancestor.Current.ControlType == ControlType.Button) { auxiliary = true; break; }
                    if ((ancestor.Current.Name ?? "").EndsWith(" code", StringComparison.Ordinal) && (ancestor.Current.ClassName ?? "").Contains("group/copy")) codeBlock = true;
                    ancestor = TreeWalker.RawViewWalker.GetParent(ancestor);
                }
                if (auxiliary) continue;
                object pattern;
                if (!node.TryGetCurrentPattern(TextPattern.Pattern, out pattern)) continue;
                var range = ((TextPattern)pattern).DocumentRange;
                var text = range.GetText(-1);
                if (string.IsNullOrEmpty(text)) continue;
                var font = Convert.ToString(range.GetAttributeValue(TextPattern.FontNameAttribute));
                bool monospace = Regex.IsMatch(font, "mono|consolas|courier", RegexOptions.IgnoreCase);
                if (codeBlock && !monospace) continue;
                if (monospace) code.Append(text);
                else { flushCode(); result.Append(text); }
            }
            flushCode();
            return result.Length == 0 ? fallback : result.ToString();
        }

        private static Action PasteText(string text)
        {
            var original = Clipboard.GetDataObject();
            // Materialize every available format before replacing the clipboard.
            var saved = new DataObject();
            if (original != null)
                foreach (var format in original.GetFormats(false))
                {
                    var value = original.GetData(format, false);
                    if (value != null) saved.SetData(format, false, value);
                }
            Clipboard.SetText(text.Replace("\r\n", "\n").Replace('\r', '\n').Replace("\n", "\r\n"), TextDataFormat.UnicodeText);
            var sequence = GetClipboardSequenceNumber();
            Action restore = delegate
            {
                // A later user copy takes precedence over our saved contents.
                if (GetClipboardSequenceNumber() != sequence) return;
                if (saved.GetFormats(false).Length == 0) Clipboard.Clear();
                else Clipboard.SetDataObject(saved, true, 5, 100);
            };
            try
            {
                SelectAll();
                var inputs = new[] {
                    new NativeInput { Type = 1, Union = new InputUnion { Keyboard = new KeyboardInput { VirtualKey = 0x11 } } },
                    new NativeInput { Type = 1, Union = new InputUnion { Keyboard = new KeyboardInput { VirtualKey = 0x56 } } },
                    new NativeInput { Type = 1, Union = new InputUnion { Keyboard = new KeyboardInput { VirtualKey = 0x56, Flags = 2 } } },
                    new NativeInput { Type = 1, Union = new InputUnion { Keyboard = new KeyboardInput { VirtualKey = 0x11, Flags = 2 } } }
                };
                if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(NativeInput))) != inputs.Length) throw new InvalidOperationException("无法粘贴英文；请检查 Claude 窗口权限。");
                return restore;
            }
            catch { restore(); throw; }
        }

        private void RestoreClipboard()
        {
            var restore = restoreClipboard;
            restoreClipboard = null;
            if (restore == null) return;
            try { restore(); }
            catch { status.Text += " 剪贴板恢复失败。"; }
        }
        private static void SelectAll()
        {
            var inputs = new[] {
                new NativeInput { Type = 1, Union = new InputUnion { Keyboard = new KeyboardInput { VirtualKey = 0x11 } } },
                new NativeInput { Type = 1, Union = new InputUnion { Keyboard = new KeyboardInput { VirtualKey = 0x41 } } },
                new NativeInput { Type = 1, Union = new InputUnion { Keyboard = new KeyboardInput { VirtualKey = 0x41, Flags = 2 } } },
                new NativeInput { Type = 1, Union = new InputUnion { Keyboard = new KeyboardInput { VirtualKey = 0x11, Flags = 2 } } }
            };
            if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(NativeInput))) != inputs.Length) throw new InvalidOperationException("Claude 输入框选择失败，未提交。");
        }

        private void Ui(Action action)
        {
            if (IsDisposed || !IsHandleCreated) return;
            try { BeginInvoke(action); } catch (InvalidOperationException) { }
        }

        [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
        [DllImport("user32.dll")] private static extern uint GetClipboardSequenceNumber();
        [StructLayout(LayoutKind.Sequential)] private struct NativeInput { public uint Type; public InputUnion Union; }
        [StructLayout(LayoutKind.Explicit)] private struct InputUnion { [FieldOffset(0)] public MouseInput Mouse; [FieldOffset(0)] public KeyboardInput Keyboard; }
        [StructLayout(LayoutKind.Sequential)] private struct MouseInput { public int X, Y; public uint Data, Flags, Time; public IntPtr Extra; }
        [StructLayout(LayoutKind.Sequential)] private struct KeyboardInput { public ushort VirtualKey, Scan; public uint Flags, Time; public IntPtr Extra; }
        [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint count, NativeInput[] inputs, int size);
    }
}
