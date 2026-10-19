param([switch]$Fixture,[string]$Title)
$ErrorActionPreference='Stop'
if($Fixture){
  Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase
  Add-Type -Path (Join-Path $PSScriptRoot 'ResponseFixture.cs') -ReferencedAssemblies @(
    [System.Windows.Window].Assembly.Location,
    [System.Windows.Media.FontFamily].Assembly.Location,
    [System.Windows.Rect].Assembly.Location,
    [System.Xaml.XamlReader].Assembly.Location
  )
  [TranslatorTests.ResponseFixture]::Run($Title)
  exit
}
. (Join-Path $PSScriptRoot '../../windows/start-bridge.ps1') -Config unused -CompileOnly
$type=[ClaudeOfflineTranslator.DesktopBridge].Assembly.GetType('ClaudeOfflineTranslator.AnswerTracker')
$tracker=[Activator]::CreateInstance($type,$true)
function Assert($condition,$message){if(-not $condition){throw $message}}
$composerType=[ClaudeOfflineTranslator.DesktopBridge].Assembly.GetType('ClaudeOfflineTranslator.ComposerText')
$composer=[Activator]::CreateInstance($composerType,$true)
$composer.Add('p1','First line.',$false)
$composer.Add('p2',"`n",$false)
$composer.Add('p3',"`n",$false)
$composer.Add('p4','Keep ',$false)
$composer.Add('p4','npm test',$true)
$composer.Add('p4',([char]0x200b).ToString()+', 250 ms.',$false)
Assert ($composer.ToString() -eq "First line.`n`n`nKeep ``npm test``, 250 ms.") 'Composer must preserve empty paragraphs, inline code, punctuation and numbers'
Assert ($composer.ToString() -ne "First line.`nKeep ``npm test``, 250 ms.") 'Missing paragraphs must not compare equal'
Assert ($composer.ToString() -ne "First line.`n`n`nKeep ``npm test``, 25 ms.") 'Changed literals must not compare equal'
Assert (-not $tracker.Observe('reply','First sentence.', $false, 0)) 'Wait for stable body'
Assert (-not $tracker.Observe('reply','First sentence. Second sentence.', $true, 2000)) 'Streaming must wait'
Assert (-not $tracker.Observe('reply','First sentence. Second sentence.', $false, 3000)) 'Wait after streaming'
Assert ($tracker.Observe('reply','First sentence. Second sentence.', $false, 3500)) 'Ready after stability'
$tracker.Translated('reply','First sentence. Second sentence.')
Assert (-not $tracker.Observe('reply','First sentence. Second sentence.', $false, 6000)) 'Do not repeat unchanged body'
Assert (-not $tracker.Observe('reply','First sentence. Second sentence. Final question?', $false, 6500)) 'Changed body must settle'
Assert ($tracker.Observe('reply','First sentence. Second sentence. Final question?', $false, 8000)) 'Same summary must not hide body growth'
Assert ($tracker.Observe('reply','First sentence. Second sentence. Final question?', $false, 8500)) 'Failure remains retryable'
Assert (-not $tracker.Observe('reply','', $false, 10000)) 'Unavailable body must not translate'
Assert (-not $tracker.Observe('reply','', $false, 12000)) 'Empty body is never ready'
Assert (-not $tracker.Observe('other-chat','First sentence. Second sentence.', $false, 13000)) 'New chat must settle'
Assert ($tracker.Observe('other-chat','First sentence. Second sentence.', $false, 14500)) 'Same text in new chat must translate'

$fixtureTitle='CDT response regression '+[Guid]::NewGuid().ToString('N')
$fixtureArgs=@('-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',('"'+$PSCommandPath+'"'),'-Fixture','-Title',('"'+$fixtureTitle+'"'))
$child=Start-Process powershell.exe -WindowStyle Hidden -ArgumentList $fixtureArgs -PassThru
try {
  $window=$null
  for($i=0;$i -lt 80;$i++){
    Start-Sleep -Milliseconds 100
    if($child.HasExited){throw 'Response fixture exited before opening'}
    $window=[System.Windows.Automation.AutomationElement]::RootElement.FindFirst(
      [System.Windows.Automation.TreeScope]::Children,
      (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,$fixtureTitle)))
    if($window){break}
  }
  Assert ($null -ne $window) 'Fixture window not found'
  $method=[ClaudeOfflineTranslator.DesktopBridge].GetMethod('ReadResponse',[Reflection.BindingFlags]'NonPublic,Static')
  $text=$method.Invoke($null,@($window.psobject.BaseObject))
  Assert ($text -eq 'First sentence. Second sentence. Final question?') ('Full body capture failed: '+$text)
  $summary=$window.FindAll([System.Windows.Automation.TreeScope]::Descendants,
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Text))) | Where-Object {$_.Current.Name -like 'Claude responded:*'} | Select-Object -First 1
  $text=$method.Invoke($null,@($summary.psobject.BaseObject))
  Assert ($text -eq '') 'Summary must never substitute for missing body'
  'Windows regression passed: full body, raw ancestry, no summary fallback, streaming, changed text, retries, chat identity.'
} finally {
  if($window){$window.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close()}
  if(-not $child.WaitForExit(5000)){Stop-Process -Id $child.Id}
}
