using System.Windows;
using System.Collections.Generic;
using System.Windows.Automation;
using System.Windows.Automation.Peers;
using System.Windows.Controls;

namespace TranslatorTests
{
    public sealed class ResponsePanel : StackPanel
    {
        protected override AutomationPeer OnCreateAutomationPeer() { return new ResponsePeer(this); }
    }

    public sealed class ResponsePeer : FrameworkElementAutomationPeer
    {
        public ResponsePeer(ResponsePanel owner) : base(owner) { }
        protected override string GetClassNameCore() { return "font-claude-response"; }
        protected override bool IsControlElementCore() { return false; }
        protected override bool IsContentElementCore() { return false; }
    }

    public sealed class ToolPanel : StackPanel
    {
        protected override AutomationPeer OnCreateAutomationPeer() { return new ToolPeer(this); }
    }
    public sealed class ToolPeer : FrameworkElementAutomationPeer
    {
        public ToolPeer(ToolPanel owner) : base(owner) { }
        protected override string GetClassNameCore() { return "tool-result"; }
    }

    public sealed class MessagePanel : StackPanel
    {
        public string AutomationClass = "", LeafText;
        public bool RawOnly;
        protected override AutomationPeer OnCreateAutomationPeer() { return new MessagePeer(this); }
    }
    public sealed class MessagePeer : FrameworkElementAutomationPeer
    {
        public MessagePeer(MessagePanel owner) : base(owner) { }
        private MessagePanel Panel { get { return (MessagePanel)Owner; } }
        protected override string GetClassNameCore() { return Panel.AutomationClass; }
        protected override string GetNameCore() { return Panel.LeafText ?? AutomationProperties.GetName(Panel); }
        protected override AutomationControlType GetAutomationControlTypeCore() { return Panel.LeafText == null ? AutomationControlType.Group : AutomationControlType.ListItem; }
        protected override bool IsControlElementCore() { return !Panel.RawOnly; }
        protected override bool IsContentElementCore() { return !Panel.RawOnly; }
        protected override List<AutomationPeer> GetChildrenCore() { return Panel.LeafText == null ? base.GetChildrenCore() : null; }
    }
    public sealed class SummaryText : TextBlock
    {
        protected override AutomationPeer OnCreateAutomationPeer() { return new SummaryPeer(this); }
    }
    public sealed class SummaryPeer : FrameworkElementAutomationPeer
    {
        public SummaryPeer(SummaryText owner) : base(owner) { }
        protected override string GetClassNameCore() { return "sr-only select-none"; }
        protected override string GetNameCore() { return ((SummaryText)Owner).Text; }
        protected override AutomationControlType GetAutomationControlTypeCore() { return AutomationControlType.Text; }
    }

    public static class ResponseFixture
    {
        public static void Run(string title)
        {
            var panel = new MessagePanel();
            AutomationProperties.SetName(panel, "legacy assistant fixture");
            panel.Children.Add(new TextBlock { Text = "Claude responded: First sentence only." });
            panel.Children.Add(new Expander { Header = "Thought for 2s", IsExpanded = true,
                Content = new TextBlock { Text = "I will compare the constraints before answering." } });
            panel.Children.Add(new Expander { Header = "Thought for 3s", IsExpanded = false,
                Content = new TextBlock { Text = "Collapsed text must not be fabricated or exposed." } });
            var tool = new ToolPanel();
            tool.Children.Add(new TextBlock { Text = "Tool finished without changing files." });
            panel.Children.Add(tool);
            var response = new ResponsePanel();
            response.Children.Add(new TextBlock { Text = "First sentence. Second sentence. " });
            response.Children.Add(new TextBlock { Text = "Final question?" });
            panel.Children.Add(response);
            panel.Children.Add(new TextBlock { Text = "Promotion outside the answer" });
            var modern = new MessagePanel(); AutomationProperties.SetName(modern, "modern assistant fixture");
            modern.Children.Add(new SummaryText { Text = "Claude responded: First sentence only." });
            var row = new MessagePanel { AutomationClass = "group/message-row relative", RawOnly = true };
            var paragraph = new MessagePanel();
            paragraph.Children.Add(new TextBlock { Text = "Modern first sentence. " });
            paragraph.Children.Add(new TextBlock { Text = "Second sentence." }); row.Children.Add(paragraph);
            row.Children.Add(new MessagePanel { LeafText = "List conclusion with 250 ms." });
            var cardHeading = new MessagePanel(); cardHeading.Children.Add(new TextBlock { Text = "Claude Code is built into this app" });
            row.Children.Add(cardHeading); row.Children.Add(new Button { Content = "Upgrade" }); row.Children.Add(new Button { Content = "Dismiss" }); modern.Children.Add(row);
            var user = new MessagePanel(); AutomationProperties.SetName(user, "modern user fixture");
            user.Children.Add(new SummaryText { Text = "You said: Claude responded: This is user input." });
            var userRow = new MessagePanel { AutomationClass = "group/message-row relative", RawOnly = true };
            userRow.Children.Add(new TextBlock { Text = "User text must not be captured." }); user.Children.Add(userRow);
            var root = new StackPanel(); root.Children.Add(panel); root.Children.Add(modern); root.Children.Add(user);
            var window = new Window { Title = title, Content = root, Width = 420, Height = 120,
                Left = -10000, Top = -10000, ShowInTaskbar = false, ShowActivated = false };
            new Application().Run(window);
        }
    }
}
