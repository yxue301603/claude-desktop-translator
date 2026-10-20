using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
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
        private readonly string configFile;
        private readonly string version;
        private readonly int ownerPid;
        private readonly string ownerLease;
        private readonly string draftFile;
        private volatile bool accountMode;
        private string translationMode;
        private readonly Label status = new Label();
        private readonly CheckBox automatic = new CheckBox();
        private readonly TextBox source = new TextBox();
        private readonly TextBox english = new TextBox();
        private readonly RichTextBox chinese = new RichTextBox();
        private readonly Label submissionLabel = new Label();
        private readonly System.Windows.Forms.Timer poll = new System.Windows.Forms.Timer();
        private volatile Snapshot snapshot;
        private volatile bool enabled = true;
        private int polling;
        private int sending;
        private int translatingAnswer;
        private Action restoreClipboard;
        private readonly OutputLedger outputs = new OutputLedger();
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

        public static void Run(string configFile, string version, int ownerPid, string ownerLease)
        {
            bool created;
            using (var mutex = new Mutex(true, "Local\\ClaudeDesktopOfflineTranslator", out created))
            {
                if (!created) return;
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                var config = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(configFile));
                var form = new DesktopBridge(Convert.ToInt32(config["port"]), Convert.ToString(config["token"]), version, configFile, ownerPid, ownerLease);
                // A launcher may hide its PowerShell host via STARTUPINFO. Show
                // the companion explicitly after that initial show is consumed.
                EventHandler show = null;
                show = delegate
                {
                    Application.Idle -= show;
                    ShowWindow(form.Handle, 4); // show without taking focus
                };
                Application.Idle += show;
                Application.Run(form);
            }
        }

        private DesktopBridge(int port, string localToken, string appVersion, string configPath, int parentPid, string lease)
        {
            endpoint = "http://127.0.0.1:" + port;
            token = localToken;
            configFile = configPath; version = appVersion; ownerPid = parentPid; ownerLease = lease;
            draftFile = Path.Combine(Path.GetDirectoryName(configFile), "companion-draft.bin");
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
            chinese.AccessibleName = "Chinese output timeline";
            var translateButton = new Button { Text = "翻译并发送给 Claude", Dock = DockStyle.Fill };
            translateButton.Click += delegate { PrepareSend(true); };
            layout.Controls.Add(status, 0, 0);
            layout.Controls.Add(automatic, 0, 1);
            layout.Controls.Add(new Label { Text = "中文输入 · Enter 发送，Shift+Enter 换行", Dock = DockStyle.Fill }, 0, 2);
            layout.Controls.Add(source, 0, 3);
            layout.Controls.Add(translateButton, 0, 4);
            submissionLabel.Dock = DockStyle.Fill;
            layout.Controls.Add(submissionLabel, 0, 5);
            layout.Controls.Add(english, 0, 6);
            var outputHeader = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false };
            outputHeader.Controls.Add(new Label { Text = "各条输出的中文译文（含可读取思考）", AutoSize = true });
            var refresh = new Button { Text = "刷新", AutoSize = true, Height = 24 };
            refresh.Click += delegate { outputs.Retry(); Poll(null, EventArgs.Empty); };
            outputHeader.Controls.Add(refresh);
            layout.Controls.Add(outputHeader, 0, 7);
            layout.Controls.Add(chinese, 0, 8);
            Controls.Add(layout);
            RefreshMode();
            try
            {
                if (File.Exists(draftFile))
                {
                    source.Text = Encoding.UTF8.GetString(ProtectedData.Unprotect(File.ReadAllBytes(draftFile), null, DataProtectionScope.CurrentUser));
                    status.Text = "已恢复未发送草稿 · Enter 发送，Shift+Enter 换行";
                }
            }
            catch { status.Text = "无法恢复加密草稿；原草稿文件仍保留。"; }
            source.TextChanged += delegate
            {
                try
                {
                    if (source.TextLength == 0) { File.Delete(draftFile); return; }
                    var encrypted = ProtectedData.Protect(Encoding.UTF8.GetBytes(source.Text), null, DataProtectionScope.CurrentUser);
                    var pending = draftFile + ".tmp";
                    File.WriteAllBytes(pending, encrypted);
                    if (File.Exists(draftFile)) File.Replace(pending, draftFile, null);
                    else File.Move(pending, draftFile);
                }
                catch { status.Text = "草稿保存失败，请保留原文后再关闭窗口。"; }
            };
            Shown += delegate
            {
                poll.Interval = 1000;
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

        private void RefreshMode()
        {
            var config = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(configFile));
            var selected = config.ContainsKey("mode") ? Convert.ToString(config["mode"]) : "api";
            if (selected == translationMode) return;
            translationMode = selected; accountMode = selected == "account";
            Text = "Claude 中英翻译 · " + (accountMode ? "旧双语·会发送中文" : selected == "api" ? "API 英文提交" : "离线英文提交") + " · v" + version;
            submissionLabel.Text = accountMode ? "旧模式：提交含中文原文" : "实际提交英文（含中文字符时停止发送）";
            automatic.Text = accountMode ? "提取旧双语回答（不支持独立思考回译）" : "自动翻译各条输出和已展开的思考";
            outputs.Reset(); chinese.Clear();
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
            if (Volatile.Read(ref sending) == 0 && Volatile.Read(ref translatingAnswer) == 0)
            {
                try { RefreshMode(); } catch { status.Text = "翻译设置暂不可用，等待恢复…"; return; }
            }
            if (ownerPid > 0)
            {
                bool ownerAlive = true;
                try { ownerAlive = !Process.GetProcessById(ownerPid).HasExited; } catch { ownerAlive = false; }
                if (!string.IsNullOrEmpty(ownerLease) && !File.Exists(ownerLease)) ownerAlive = false;
                if (!ownerAlive)
                {
                    enabled = false; automatic.Checked = false;
                    if (source.TextLength == 0 && Volatile.Read(ref sending) == 0) { Close(); return; }
                    status.Text = "扩展已停用；未发送草稿已加密保存，下次打开恢复。";
                    return;
                }
            }
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
                    var context = ReadContext(window);
                    snapshot = new Snapshot { Window = window, Input = input, ProcessId = process.Id, Handle = process.MainWindowHandle, Context = context };
                    DebugStage("input_connected");
                    Ui(delegate { if (status.Text.StartsWith("正在连接") || status.Text.StartsWith("等待 Claude") || status.Text.StartsWith("请打开 Claude")) status.Text = "已连接 Claude · 使用当前官方账号"; });
                    if (!enabled || Volatile.Read(ref sending) != 0) return;
                    var stop = window.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button)).Cast<AutomationElement>()
                        .Any(e => new[] { "Stop response", "Stop", "停止响应", "停止" }.Contains(e.Current.Name));
                    var messages = window.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Group)).Cast<AutomationElement>()
                        .Where(e => Regex.IsMatch(e.Current.Name ?? "", @"^Message \d+( of \d+)?$")).ToArray();
                    DebugStage("messages_" + messages.Length);
                    var blocks = new List<OutputBlock>();
                    for (int i = 0; i < messages.Length; i++)
                    {
                        var message = messages[i];
                        DebugStage("assistant_found");
                        var key = process.Id + "|" + context + "|" + string.Join("-", message.GetRuntimeId());
                        var captured = ReadOutputBlocks(message, key, i + 1, stop && i == messages.Length - 1);
                        if (captured.Count == 0) continue;
                        if (accountMode) captured = captured.Where(block => block.Kind == "answer" && Regex.IsMatch(block.Text, @"CDT_[a-f0-9]{16}_END\b")).ToList();
                        blocks.AddRange(captured);
                    }
                    Ui(delegate
                    {
                        if (!enabled || Volatile.Read(ref sending) != 0) return;
                        var now = Stopwatch.GetTimestamp() * 1000 / Stopwatch.Frequency;
                        outputs.Observe(blocks, now);
                        ShowOutputs();
                        var next = Volatile.Read(ref translatingAnswer) == 0 ? outputs.Next(now) : null;
                        if (next != null) { Interlocked.Exchange(ref translatingAnswer, 1); CaptureOutput(next); }
                    });
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
            var result = new ComposerText();
            foreach (AutomationElement node in input.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Text)))
            {
                object pattern;
                if (!node.TryGetCurrentPattern(TextPattern.Pattern, out pattern)) return false;
                var range = ((TextPattern)pattern).DocumentRange;
                var text = range.GetText(-1);
                var font = Convert.ToString(range.GetAttributeValue(TextPattern.FontNameAttribute));
                var block = node;
                var parent = TreeWalker.RawViewWalker.GetParent(block);
                while (parent != null && !Automation.Compare(parent, input))
                {
                    block = parent;
                    parent = TreeWalker.RawViewWalker.GetParent(block);
                }
                if (parent == null) return false;
                result.Add(string.Join("-", block.GetRuntimeId()), text, Regex.IsMatch(font, "mono|consolas|courier", RegexOptions.IgnoreCase));
            }
            return NormalizeLines(result.ToString()) == NormalizeLines(expected);
        }

        private static string NormalizeLines(string text)
        {
            return text.Replace("\r\n", "\n").Replace('\r', '\n').TrimEnd('\n');
        }

        private string ProcessText(string text, string target)
        {
            var route = target == "en" ? "/prepare" : accountMode ? "/extract" : "/translate";
            var request = (HttpWebRequest)WebRequest.Create(endpoint + route);
            request.Proxy = null;
            request.Method = "POST";
            request.ContentType = "application/json; charset=utf-8";
            request.Headers["x-local-token"] = token;
            request.Timeout = 180000;
            var bytes = Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(new { text = text, target = target }));
            request.ContentLength = bytes.Length;
            using (var stream = request.GetRequestStream()) stream.Write(bytes, 0, bytes.Length);
            WebResponse received;
            try { received = request.GetResponse(); }
            catch (WebException error)
            {
                if (error.Response == null) throw new InvalidOperationException("翻译服务未连接，原文未提交。");
                using (var response = error.Response)
                using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                {
                    var body = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
                    throw new InvalidOperationException(body.ContainsKey("error") ? Convert.ToString(body["error"]) : "翻译服务失败，原文未提交。");
                }
            }
            using (var response = received)
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
            status.Text = accountMode ? "旧模式：正在准备含中文原文的请求…" : "正在翻译并校验英文，尚未提交…";
            Task.Run(delegate
            {
                try
                {
                    var translated = ProcessText(original, "en");
                    if (!accountMode) SubmissionGuard.EnglishOnly(translated);
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
                            if (GetForegroundWindow() != current.Handle || !Automation.Compare(AutomationElement.FocusedElement, current.Input)) throw new InvalidOperationException("Claude 输入框未获得焦点，未提交。请解锁屏幕并打开聊天窗口。");
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
                                    if (!accountMode) SubmissionGuard.EnglishOnly(translated);
                                    ((InvokePattern)send.GetCurrentPattern(InvokePattern.Pattern)).Invoke();
                                    source.Clear();
                                    status.Text = accountMode ? "双语请求已由 Claude 官方客户端提交。" : "英文已由 Claude 官方客户端提交。";
                                    Interlocked.Exchange(ref sending, 0);
                                }
                                catch (Exception error) { timer.Stop(); timer.Dispose(); status.Text = error.Message; Interlocked.Exchange(ref sending, 0); RestoreClipboard(); }
                            };
                            timer.Start();
                        }
                        catch (Exception error) { status.Text = error.Message; sending = 0; RestoreClipboard(); }
                    });
                }
                catch (Exception error) { Ui(delegate { status.Text = error.Message; sending = 0; }); }
            });
        }

        private void ShowOutputs()
        {
            var rendered = outputs.Render();
            if (chinese.Text == rendered) return;
            bool atEnd = chinese.SelectionStart >= chinese.TextLength - 1;
            int position = chinese.SelectionStart;
            chinese.Text = rendered;
            chinese.SelectionStart = atEnd ? chinese.TextLength : Math.Min(position, chinese.TextLength);
            if (atEnd) chinese.ScrollToCaret();
        }

        private void CaptureOutput(OutputWork work)
        {
            DebugStage("capture_enter");
            try
            {
                status.Text = "正在翻译消息 " + work.Block.Number + " · " + OutputLedger.Label(work.Block.Kind) + "…";
                DebugStage("translation_requested");
                Task.Run(delegate
                {
                    try
                    {
                        var translated = ProcessText(work.Block.Text, "zh");
                        Ui(delegate { if (outputs.Complete(work, translated)) { ShowOutputs(); status.Text = "中文输出已更新 · " + (accountMode ? "旧双语模式" : translationMode == "api" ? "翻译 API" : "本地模型"); } });
                    }
                    catch (Exception error) { Ui(delegate { outputs.Fail(work, Stopwatch.GetTimestamp() * 1000 / Stopwatch.Frequency, error.Message); ShowOutputs(); status.Text = "输出翻译失败，可点刷新重试。"; }); }
                    finally { Ui(delegate { Interlocked.Exchange(ref translatingAnswer, 0); }); }
                });
            }
            catch (Exception error) { DebugStage("capture_error_" + error.GetType().Name); Interlocked.Exchange(ref translatingAnswer, 0); }
        }

        private static string ReadResponse(AutomationElement message)
        {
            return string.Concat(ReadOutputBlocks(message, "fixture", 1, false).Where(block => block.Kind == "answer").Select(block => block.Text));
        }

        private static List<OutputBlock> ReadOutputBlocks(AutomationElement message, string messageKey, int number, bool streaming)
        {
            var result = new List<OutputBlock>();
            var builders = new Dictionary<string, ResponseText>();
            var all = message.FindAll(TreeScope.Descendants, Condition.TrueCondition).Cast<AutomationElement>().ToArray();
            var regions = ThinkingRegions(message, all);
            // Chromium exposes raw-only containers whose FindAll(Descendants)
            // returns no children. Enumerate from the message, then classify each
            // text node by its raw ancestry instead of querying that container.
            var nodes = all.Where(node => node.Current.ControlType == ControlType.Text);
            foreach (AutomationElement node in nodes)
            {
                if ((node.Current.ClassName ?? "").Contains("sr-only")) continue;
                var ancestor = TreeWalker.RawViewWalker.GetParent(node);
                bool auxiliary = false;
                bool codeBlock = false;
                string kind = null, region = null;
                for (int depth = 0; depth < 64 && ancestor != null && !Automation.Compare(ancestor, message); depth++)
                {
                    var className = ancestor.Current.ClassName ?? "";
                    if (ancestor.Current.ControlType == ControlType.ToolBar || ancestor.Current.ControlType == ControlType.Button || Regex.IsMatch(className, @"\bsr-only\b|promotion|upsell", RegexOptions.IgnoreCase)) { auxiliary = true; break; }
                    object expansion;
                    if (ancestor.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out expansion) && ((ExpandCollapsePattern)expansion).Current.ExpandCollapseState == ExpandCollapseState.Collapsed) { auxiliary = true; break; }
                    var identity = string.Join("-", ancestor.GetRuntimeId());
                    var semantic = className + " " + ancestor.Current.AutomationId;
                    if (regions.Contains(identity) || Regex.IsMatch(semantic, @"(?:^|[-_ /])(?:thinking|reasoning|thoughts?)(?:$|[-_ /])", RegexOptions.IgnoreCase)) { kind = "thinking"; region = identity; }
                    else if (kind != "thinking" && Regex.IsMatch(semantic, @"tool[-_/](?:result|output|use)|intermediate|progress-message", RegexOptions.IgnoreCase)) { kind = "intermediate"; region = identity; }
                    else if (kind == null && className.Split(' ').Contains("font-claude-response")) { kind = "answer"; region = identity; }
                    if ((ancestor.Current.Name ?? "").EndsWith(" code", StringComparison.Ordinal) && (ancestor.Current.ClassName ?? "").Contains("group/copy")) codeBlock = true;
                    ancestor = TreeWalker.RawViewWalker.GetParent(ancestor);
                }
                if (auxiliary || kind == null) continue;
                object pattern;
                var text = node.Current.Name;
                var font = "";
                if (node.TryGetCurrentPattern(TextPattern.Pattern, out pattern))
                {
                    var range = ((TextPattern)pattern).DocumentRange;
                    text = range.GetText(-1);
                    font = Convert.ToString(range.GetAttributeValue(TextPattern.FontNameAttribute));
                }
                if (string.IsNullOrEmpty(text)) continue;
                bool monospace = Regex.IsMatch(font, "mono|consolas|courier", RegexOptions.IgnoreCase);
                if (codeBlock && !monospace) continue;
                var key = messageKey + "|" + kind + "|" + region;
                ResponseText builder;
                if (!builders.TryGetValue(key, out builder))
                {
                    builder = new ResponseText(); builders.Add(key, builder);
                    result.Add(new OutputBlock { Key = key, Message = messageKey, Number = number, Kind = kind, Streaming = streaming && kind != "thinking" });
                }
                builder.Add(text, monospace);
            }
            foreach (var block in result) block.Text = builders[block.Key].ToString();
            if (!result.Any(block => block.Kind == "thinking") && all.Any(node => (node.Current.ControlType == ControlType.Button || node.Current.ControlType == ControlType.Group) && Regex.IsMatch(node.Current.Name ?? "", @"^(?:Thought\b|Thinking\b|Reasoning\b|Show thinking\b|思考|已思考)", RegexOptions.IgnoreCase)))
                result.Insert(0, new OutputBlock { Key = messageKey + "|thinking-unavailable", Message = messageKey, Number = number, Kind = "notice", Text = "此消息的思考内容未暴露。请在 Claude 中手动展开后点刷新；插件不会还原未公开的内部思考。" });
            return result;
        }

        private static bool Inside(AutomationElement node, AutomationElement container)
        {
            for (int depth = 0; depth < 64 && node != null; depth++, node = TreeWalker.RawViewWalker.GetParent(node)) if (Automation.Compare(node, container)) return true;
            return false;
        }

        private static HashSet<string> ThinkingRegions(AutomationElement message, AutomationElement[] nodes)
        {
            var result = new HashSet<string>();
            foreach (var toggle in nodes.Where(node => (node.Current.ControlType == ControlType.Button || node.Current.ControlType == ControlType.Group) && Regex.IsMatch(node.Current.Name ?? "", @"^(?:Thought(?: for)?\b|Thinking\b|Reasoning\b|Show thinking\b|Hide thinking\b|思考|已思考)", RegexOptions.IgnoreCase)))
            {
                object pattern;
                if (!toggle.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern) || ((ExpandCollapsePattern)pattern).Current.ExpandCollapseState != ExpandCollapseState.Expanded) continue;
                var parent = toggle.Current.ControlType == ControlType.Group ? toggle : TreeWalker.RawViewWalker.GetParent(toggle);
                for (int depth = 0; depth < 5 && parent != null && !Automation.Compare(parent, message); depth++, parent = TreeWalker.RawViewWalker.GetParent(parent))
                {
                    if (!nodes.Any(node => node.Current.ControlType == ControlType.Text && !Regex.IsMatch(node.Current.Name ?? "", @"^(?:Thought\b|Thinking\b|Reasoning\b|思考|已思考)", RegexOptions.IgnoreCase) && Inside(node, parent) && (toggle.Current.ControlType != ControlType.Button || !Inside(node, toggle)))) continue;
                    result.Add(string.Join("-", parent.GetRuntimeId())); break;
                }
            }
            return result;
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
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr window, int command);
        [DllImport("user32.dll")] private static extern uint GetClipboardSequenceNumber();
        [StructLayout(LayoutKind.Sequential)] private struct NativeInput { public uint Type; public InputUnion Union; }
        [StructLayout(LayoutKind.Explicit)] private struct InputUnion { [FieldOffset(0)] public MouseInput Mouse; [FieldOffset(0)] public KeyboardInput Keyboard; }
        [StructLayout(LayoutKind.Sequential)] private struct MouseInput { public int X, Y; public uint Data, Flags, Time; public IntPtr Extra; }
        [StructLayout(LayoutKind.Sequential)] private struct KeyboardInput { public ushort VirtualKey, Scan; public uint Flags, Time; public IntPtr Extra; }
        [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint count, NativeInput[] inputs, int size);
    }

    public sealed class OutputBlock
    {
        public string Key, Message, Kind, Text;
        public int Number;
        public bool Streaming;
    }

    public sealed class OutputWork
    {
        public OutputBlock Block;
        public long Epoch;
    }

    internal sealed class OutputLedger
    {
        private sealed class Entry
        {
            public OutputBlock Block;
            public string Translation, Error;
            public long StableSince;
            public bool Pending;
        }
        private readonly Dictionary<string, Entry> entries = new Dictionary<string, Entry>();
        private List<string> order = new List<string>();
        private HashSet<string> messages = new HashSet<string>();
        private long epoch, retryAfter;
        public static string Label(string kind) { return kind == "notice" ? "思考状态" : kind == "thinking" ? "思考（界面公开内容）" : kind == "intermediate" ? "中间输出" : "回答"; }
        public void Reset() { epoch++; entries.Clear(); order.Clear(); messages.Clear(); retryAfter = 0; }
        public void Retry() { retryAfter = 0; foreach (var entry in entries.Values) entry.Error = null; }
        public void Observe(List<OutputBlock> blocks, long now)
        {
            var currentMessages = new HashSet<string>(blocks.Select(block => block.Message));
            if (messages.Count > 0 && !messages.Overlaps(currentMessages)) Reset();
            messages = currentMessages;
            order = blocks.Select(block => block.Key).Distinct().ToList();
            foreach (var block in blocks)
            {
                Entry entry;
                if (!entries.TryGetValue(block.Key, out entry)) { entry = new Entry { StableSince = now }; entries.Add(block.Key, entry); }
                if (entry.Block == null || entry.Block.Text != block.Text) { entry.StableSince = now; entry.Translation = null; entry.Error = null; }
                if (block.Streaming) entry.StableSince = now;
                entry.Block = block;
            }
        }
        public OutputWork Next(long now)
        {
            if (now < retryAfter) return null;
            foreach (var key in order)
            {
                var entry = entries[key];
                if (entry.Block.Kind == "notice" || entry.Pending || entry.Translation != null || string.IsNullOrWhiteSpace(entry.Block.Text) || entry.Block.Streaming || now - entry.StableSince < 1500) continue;
                entry.Pending = true; return new OutputWork { Block = entry.Block, Epoch = epoch };
            }
            return null;
        }
        public bool Complete(OutputWork work, string translated)
        {
            Entry entry;
            if (epoch != work.Epoch || !entries.TryGetValue(work.Block.Key, out entry)) return false;
            entry.Pending = false;
            if (entry.Block.Text != work.Block.Text || !order.Contains(work.Block.Key)) return false;
            entry.Translation = translated; entry.Error = null; return true;
        }
        public void Fail(OutputWork work, long now, string error)
        {
            Entry entry;
            if (epoch != work.Epoch || !entries.TryGetValue(work.Block.Key, out entry)) return;
            entry.Pending = false; entry.Error = error; retryAfter = now + 30000;
        }
        public string Render()
        {
            if (order.Count == 0) return "暂无可读取输出。请在 Claude 中展开思考后点刷新；未公开的内部思考无法读取。";
            var text = new StringBuilder();
            foreach (var key in order)
            {
                var entry = entries[key];
                text.Append("消息 ").Append(entry.Block.Number).Append(" · ").Append(Label(entry.Block.Kind)).AppendLine();
                text.AppendLine(entry.Block.Kind == "notice" ? entry.Block.Text : entry.Translation ?? (entry.Error == null ? "等待内容稳定并翻译…" : "翻译失败：" + entry.Error));
                text.AppendLine();
            }
            return text.ToString();
        }
    }

    internal sealed class ResponseText
    {
        private readonly StringBuilder text = new StringBuilder(), code = new StringBuilder();
        private void FlushCode()
        {
            if (code.Length == 0) return;
            var value = code.ToString();
            text.Append(value.Contains("\n") || value.Length > 100 ? "\n```\n" + value + "\n```\n" : "`" + value + "`"); code.Clear();
        }
        public void Add(string value, bool monospace) { if (monospace) code.Append(value); else { FlushCode(); text.Append(value); } }
        public override string ToString() { FlushCode(); return text.ToString(); }
    }

    internal static class SubmissionGuard
    {
        public static void EnglishOnly(string text)
        {
            if (string.IsNullOrWhiteSpace(text) || text.Length > 60000) throw new InvalidOperationException("英文为空或过长，未提交。");
            for (int i = 0; i < text.Length; i++)
            {
                int point = char.IsHighSurrogate(text[i]) && i + 1 < text.Length && char.IsLowSurrogate(text[i + 1]) ? char.ConvertToUtf32(text[i], text[++i]) : text[i];
                if (point >= 0x2e80 && point <= 0x2fff || point == 0x3005 || point == 0x3007 || point >= 0x3038 && point <= 0x303b || point >= 0x3400 && point <= 0x4dbf || point >= 0x4e00 && point <= 0x9fff || point >= 0xf900 && point <= 0xfaff || point >= 0x20000 && point <= 0x3ffff)
                    throw new InvalidOperationException("提交中仍含中文字符（包括代码或路径），已停止发送。");
            }
        }
    }

    // Chromium's document range omits empty paragraph nodes. Reconstruct the
    // explicit paragraph boundaries instead of ignoring whitespace differences.
    internal sealed class ComposerText
    {
        private readonly StringBuilder result = new StringBuilder();
        private readonly StringBuilder code = new StringBuilder();
        private string lastBlock;

        private void FlushCode()
        {
            if (code.Length == 0) return;
            result.Append('`').Append(code).Append('`');
            code.Clear();
        }

        public void Add(string block, string text, bool monospace)
        {
            if (lastBlock != null && block != lastBlock) { FlushCode(); result.Append('\n'); }
            lastBlock = block;
            // A lone newline is the accessibility placeholder for an empty p.
            if (text == "\n" || text == "\r\n") text = "";
            if (monospace) code.Append(text);
            else { FlushCode(); result.Append(text.Replace("\u200b", "")); }
        }

        public override string ToString() { FlushCode(); return result.ToString(); }
    }

    internal sealed class AnswerTracker
    {
        private readonly object sync = new object();
        private string observedKey, observedText, translatedKey, translatedText;
        private long stableSince;

        public bool Observe(string key, string text, bool streaming, long milliseconds)
        {
            lock (sync)
            {
                if (key != observedKey || text != observedText || streaming || string.IsNullOrWhiteSpace(text))
                {
                    observedKey = key; observedText = text; stableSince = milliseconds;
                    return false;
                }
                return milliseconds - stableSince >= 1500 && (key != translatedKey || text != translatedText);
            }
        }

        public void Translated(string key, string text)
        {
            lock (sync) { translatedKey = key; translatedText = text; }
        }

        public void Reset()
        {
            lock (sync) { observedKey = observedText = translatedKey = translatedText = null; }
        }
    }
}
