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
$guard=[ClaudeOfflineTranslator.DesktopBridge].Assembly.GetType('ClaudeOfflineTranslator.SubmissionGuard').GetMethod('EnglishOnly')
$guard.Invoke($null,@('Explain code without running it.'))
$badInputs=@(
  ([char]0x4e2d).ToString()
  ('```js'+([char]0x4e2d).ToString()+'```')
  ('C:\'+([char]0x4e2d).ToString()+'\file.txt')
  ([char]::ConvertFromUtf32(0x20000))
)
foreach($bad in $badInputs){
  $rejected=$false
  try{$guard.Invoke($null,@($bad))}catch{$rejected=$true}
  Assert $rejected 'Final desktop guard must reject Chinese even inside code, paths and supplementary characters'
}
$ledgerType=[ClaudeOfflineTranslator.DesktopBridge].Assembly.GetType('ClaudeOfflineTranslator.OutputLedger')
$ledger=[Activator]::CreateInstance($ledgerType,$true)
function Block($key,$message,$kind,$text,$stream=$false){
  $block=New-Object ClaudeOfflineTranslator.OutputBlock
  $block.Key=$key;$block.Message=$message;$block.Kind=$kind;$block.Text=$text;$block.Streaming=$stream;$block.Number=1
  return $block
}
function Blocks($items){
  $list=New-Object 'System.Collections.Generic.List[ClaudeOfflineTranslator.OutputBlock]'
  foreach($item in $items){$list.Add($item)}
  return ,$list
}
$batch=Blocks @((Block 'old-answer' 'm1' 'answer' 'Earlier answer.'),(Block 'thinking' 'm2' 'thinking' 'Compare constraints.'),(Block 'answer' 'm2' 'answer' 'Partial' $true))
$ledger.Observe($batch,0)
Assert ($null -eq $ledger.Next(1000)) 'All blocks must settle first'
$old=$ledger.Next(1500);Assert ($old.Block.Key -eq 'old-answer') 'Earlier messages must be translated, not just the last reply'
Assert ($ledger.Complete($old,'Earlier translated.')) 'Earlier message completion'
$thought=$ledger.Next(1500);Assert ($thought.Block.Kind -eq 'thinking') 'Public thinking can translate while the final answer streams'
Assert ($ledger.Complete($thought,'Thinking translated.')) 'Thinking completion'
Assert ($null -eq $ledger.Next(5000)) 'Streaming final answer must not be delivered partially'
$batch=Blocks @($batch[0],$batch[1],(Block 'answer' 'm2' 'answer' 'Complete answer.'));$ledger.Observe($batch,5500)
Assert ($null -eq $ledger.Next(6000)) 'Final answer change must settle'
$final=$ledger.Next(7000);Assert ($final.Block.Key -eq 'answer') 'Final answer becomes ready'
$ledger.Fail($final,7000,'fixture failure')
Assert ($null -eq $ledger.Next(8000)) 'Provider failures back off rather than repeatedly billing requests'
$ledger.Retry();$retry=$ledger.Next(8000);Assert ($retry.Block.Key -eq 'answer') 'Manual refresh retries failed blocks'
$ledger.Observe((Blocks @((Block 'new-answer' 'other-chat' 'answer' 'Other chat.'))),8500)
Assert (-not $ledger.Complete($retry,'Stale old chat.')) 'A late provider response must never overwrite a switched conversation'
Assert (-not $ledger.Render().Contains('Earlier translated.')) 'Translations must not leak into another conversation'
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
  $capture=[ClaudeOfflineTranslator.DesktopBridge].GetMethod('ReadOutputBlocks',[Reflection.BindingFlags]'NonPublic,Static')
  $blocks=$capture.Invoke($null,@($window.psobject.BaseObject,'fixture-message',1,$false))
  Assert (@($blocks | Where-Object Kind -EQ 'thinking').Count -eq 1) 'Expanded semantic thinking must be captured separately'
  Assert (($blocks | Where-Object Kind -EQ 'thinking').Text -eq 'I will compare the constraints before answering.') 'Full thinking text, no header duplication'
  Assert (($blocks | Where-Object Kind -EQ 'intermediate').Text -eq 'Tool finished without changing files.') 'Intermediate tool text must be captured'
  Assert (-not (($blocks | ForEach-Object Text) -join '').Contains('Collapsed text')) 'Collapsed unavailable thinking must never be invented'
  Assert (-not (($blocks | ForEach-Object Text) -join '').Contains('Promotion outside')) 'Non-output UI must not be translated'
  $summary=$window.FindAll([System.Windows.Automation.TreeScope]::Descendants,
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Text))) | Where-Object {$_.Current.Name -like 'Claude responded:*'} | Select-Object -First 1
  $text=$method.Invoke($null,@($summary.psobject.BaseObject))
  Assert ($text -eq '') 'Summary must never substitute for missing body'
  'Windows regression passed: English-only guard, expanded thinking, intermediate output, multi-message timeline, stale-response isolation, full body, raw ancestry, no summary fallback, streaming and retries.'
} finally {
  if($window){$window.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close()}
  if(-not $child.WaitForExit(5000)){Stop-Process -Id $child.Id}
}
