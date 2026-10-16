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

    public static class ResponseFixture
    {
        public static void Run(string title)
        {
            var panel = new StackPanel();
            panel.Children.Add(new TextBlock { Text = "Claude responded: First sentence only." });
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
