using System.Windows;
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

    public static class ResponseFixture
    {
        public static void Run(string title)
        {
            var panel = new StackPanel();
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
            var window = new Window { Title = title, Content = panel, Width = 420, Height = 120,
                Left = -10000, Top = -10000, ShowInTaskbar = false, ShowActivated = false };
            new Application().Run(window);
        }
    }
}
