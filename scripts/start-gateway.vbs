' dsh-remote — start the gateway silently (used by the Startup shortcut).
Option Explicit
Dim sh, fso, here, gw, node, logFile, cmd
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
gw = fso.GetParentFolderName(here) & "\gateway"
node = sh.Environment("PROCESS")("ProgramFiles") & "\nodejs\node.exe"
If Not fso.FileExists(node) Then node = "node"
logFile = gw & "\gateway.log"
cmd = "cmd /c """"" & node & """ """ & gw & "\server.mjs"" >> """ & logFile & """ 2>&1"""
sh.Run cmd, 0, False
