' dmzs-mail iCloud agent - silent launcher.
'
' Starts run.ps1 with no console window at all. Put a shortcut to this file
' (or the file itself) in the Startup folder and the agent comes up at logon
' without a terminal, without Task Scheduler, and without admin rights.
'
' The two arguments to .Run are what matter:
'   0     - window style: hidden. 1 would show it, 7 would minimise it.
'   False - do not wait for it to exit, so this script ends immediately and
'           leaves the agent running behind it.
'
' Output still goes to agent\agent.log, which is the only way to see what it
' is doing once there is no window to look at.

Dim sh
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""D:\dmzs-mail\agent\run.ps1""", 0, False
