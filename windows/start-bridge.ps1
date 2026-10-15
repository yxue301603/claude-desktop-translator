param([Parameter(Mandatory=$true)][string]$Config,[switch]$CompileOnly)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,WindowsBase,System.Windows.Forms,System.Drawing,System.Web.Extensions
$references=@(
  [System.Windows.Forms.Form].Assembly.Location,
  [System.Drawing.Point].Assembly.Location,
  [System.Web.Script.Serialization.JavaScriptSerializer].Assembly.Location,
  [System.Windows.Automation.AutomationElement].Assembly.Location,
  [System.Windows.Automation.AutomationIdentifier].Assembly.Location,
  [System.Windows.Rect].Assembly.Location
)
Add-Type -Path (Join-Path $PSScriptRoot 'TranslatorBridge.cs') -ReferencedAssemblies $references
if(-not $CompileOnly) { [ClaudeOfflineTranslator.DesktopBridge]::Run($Config) }
