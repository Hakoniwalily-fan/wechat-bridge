' Launch the bridge supervisor with no console window, and stay alive for as
' long as it runs. Staying alive matters: the scheduled task treats this
' process as the task, so a second instance gets suppressed by IgnoreNew
' instead of stacking up another copy of the bridge every pulse.
'
' The path is derived from this script's own location, so the repo can live
' anywhere.
Dim fso, sh, dir, target
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
target = fso.BuildPath(dir, "start.cmd")
sh.Run """" & target & """", 0, True
